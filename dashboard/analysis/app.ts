import {
  createStreamingParser,
  mergeStatements,
  type ElementNode,
  type ParseResult,
} from "@openuidev/lang-core";
import { fetchJson, HttpError } from "../api.js";
import { revokeAccessToken } from "../auth-api.js";
import { renderAuthUi } from "../auth-ui.js";
import { OpenUIDOMRenderer, isElementNode, type OpenUIAction } from "../../openui/dom-renderer";
import {
  OPENUI_MAX_COMPONENTS,
  OPENUI_MAX_DEPTH,
  OPENUI_MAX_PROGRAM_CHARS,
  soyuzOpenUILibrary,
  validateSoyuzAction,
} from "../../openui/library";
import { createSoyuzOpenUIRuntime, validateGeneratedProgram, type SoyuzOpenUIRuntime } from "../../openui/runtime";
import { soyuzComponentRenderers } from "./components";
import { suggestedJevProfile } from "./jev-selection";

interface OAuthRegistration { client_id: string }
interface OAuthTokenResponse { access_token: string }

type AnalysisMode = "generate" | "edit";
type JevProfileId = keyof typeof JEV_PROFILE_VIEWS;
interface JevProfileView {
  title: string;
  answers: readonly { key: string; title: string; type: "noul" | "choice" | "score"; labels?: Record<string, string> }[];
}

const JEV_PROFILE_VIEWS = {
  run_operations_triage_v1: {
    title: "Run operations triage",
    answers: [
      { key: "needs_followup", title: "Needs followup", type: "noul" },
      { key: "likely_area", title: "Likely area", type: "choice", labels: { execution: "Kaseki execution", control_plane: "Soyuz control plane", unknown: "Unknown" } },
      { key: "severity", title: "Severity", type: "score" },
    ],
  },
  kaseki_output_review_v1: {
    title: "Kaseki output review",
    answers: [
      { key: "summary_specificity", title: "Summary specificity", type: "noul" },
      { key: "outcome_alignment", title: "Outcome alignment", type: "choice", labels: { consistent: "Consistent", unclear: "Unclear", inconsistent: "Inconsistent" } },
      { key: "evidence_strength", title: "Evidence strength", type: "score" },
    ],
  },
  kaseki_output_review_v2: {
    title: "Kaseki output and outcome review",
    answers: [
      { key: "summary_specificity", title: "Summary specificity", type: "noul" },
      { key: "outcome_alignment", title: "Outcome alignment", type: "choice", labels: { consistent: "Consistent", unclear: "Unclear", inconsistent: "Inconsistent" } },
      { key: "evidence_strength", title: "Evidence strength", type: "score" },
      { key: "recorded_outcome", title: "Recorded outcome score", type: "score" },
    ],
  },
} as const satisfies Record<string, JevProfileView>;

const oauthKeys = ["state", "verifier", "clientId", "redirectUri"] as const;
const notice = requiredElement<HTMLElement>("#analysis-notice");
const dataNotice = requiredElement<HTMLElement>("#analysis-data-notice");
const connectButton = requiredElement<HTMLButtonElement>("#analysis-connect");
const accountLabel = requiredElement<HTMLElement>("#analysis-account");
const form = requiredElement<HTMLFormElement>("#analysis-form");
const question = requiredElement<HTMLTextAreaElement>("#analysis-question");
const generateButton = requiredElement<HTMLButtonElement>("#analysis-generate");
const refineButton = requiredElement<HTMLButtonElement>("#analysis-refine");
const output = requiredElement<HTMLElement>("#analysis-output");
const jevControls = requiredElement<HTMLElement>("#analysis-jev-controls");
const jevForm = requiredElement<HTMLFormElement>("#analysis-jev-form");
const jevProfile = requiredElement<HTMLSelectElement>("#analysis-jev-profile");
const jevRunId = requiredElement<HTMLInputElement>("#analysis-jev-run-id");
const jevButton = requiredElement<HTMLButtonElement>("#analysis-jev-run");
const jevNotice = requiredElement<HTMLElement>("#analysis-jev-notice");
const jevOutput = requiredElement<HTMLElement>("#analysis-jev-output");
const jevFeedback = requiredElement<HTMLElement>("#analysis-jev-feedback");
const jevFeedbackNotice = requiredElement<HTMLElement>("#analysis-jev-feedback-notice");
const jevFeedbackButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-jev-rating]")];

let accessToken: string | null = null;
let oauthClientId: string | null = null;
let runtime: SoyuzOpenUIRuntime | null = null;
let renderer: OpenUIDOMRenderer | null = null;
let stopRuntimeSubscription: (() => void) | null = null;
let jevRuntime: SoyuzOpenUIRuntime | null = null;
let jevRenderer: OpenUIDOMRenderer | null = null;
let stopJevRuntimeSubscription: (() => void) | null = null;
let currentProgram = "";
let isGenerating = false;
let isRunningJev = false;
let hasRunJev = false;

renderAuthUi(connectButton, accountLabel, "signed-out");
void finishSignIn();

connectButton.addEventListener("click", () => {
  if (accessToken) void signOut();
  else void connect();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const submitter = event.submitter;
  const mode: AnalysisMode = submitter instanceof HTMLButtonElement && submitter.value === "edit" ? "edit" : "generate";
  void generateAnalysis(mode);
});

jevForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runJevAssessment();
});
jevProfile.addEventListener("change", clearJevAssessment);
jevRunId.addEventListener("input", clearJevAssessment);
for (const button of jevFeedbackButtons) button.addEventListener("click", () => {
  const rating = button.dataset.jevRating;
  if (rating === "helpful" || rating === "not_helpful") void submitJevFeedback(rating);
});

window.addEventListener("pagehide", () => disposeRuntime());

async function connect(): Promise<void> {
  renderAuthUi(connectButton, accountLabel, "signing-in");
  setNotice("Opening GitHub sign-in…", "info");
  try {
    const redirectUri = `${location.origin}/dashboard/analysis/`;
    const registration = await fetchJson<OAuthRegistration>("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Soyuz Run Analysis",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "soyuz:read",
      }),
    });
    const verifier = randomString(64);
    const state = randomString(32);
    const challenge = await codeChallenge(verifier);
    sessionStorage.setItem("soyuz.analysis.state", state);
    sessionStorage.setItem("soyuz.analysis.verifier", verifier);
    sessionStorage.setItem("soyuz.analysis.clientId", registration.client_id);
    sessionStorage.setItem("soyuz.analysis.redirectUri", redirectUri);

    const authorize = new URL("/oauth/authorize", location.origin);
    authorize.searchParams.set("client_id", registration.client_id);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("scope", "soyuz:read");
    authorize.searchParams.set("resource", `${location.origin}/`);
    location.assign(authorize);
  } catch {
    setNotice("We couldn't start sign-in. Please try again.", "danger");
    renderAuthUi(connectButton, accountLabel, "signed-out");
  }
}

async function finishSignIn(): Promise<void> {
  const params = new URL(location.href).searchParams;
  const code = params.get("code");
  if (!code) return;
  if (params.get("state") !== sessionStorage.getItem("soyuz.analysis.state")) {
    clearOAuthState();
    setNotice("We couldn't verify this sign-in. Please start again.", "danger");
    return;
  }
  renderAuthUi(connectButton, accountLabel, "signing-in");
  setNotice("Completing sign-in…", "info");
  try {
    const token = await fetchJson<OAuthTokenResponse>("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: sessionStorage.getItem("soyuz.analysis.clientId") ?? "",
        redirect_uri: sessionStorage.getItem("soyuz.analysis.redirectUri") ?? "",
        code_verifier: sessionStorage.getItem("soyuz.analysis.verifier") ?? "",
        resource: `${location.origin}/`,
      }),
    });
    accessToken = token.access_token;
    oauthClientId = sessionStorage.getItem("soyuz.analysis.clientId");
    if (!accessToken || !oauthClientId) throw new Error("OAuth token response was incomplete");
    const identity = await apiJson<{ githubLogin: string }>("/dashboard/api/me");
    if (typeof identity.githubLogin !== "string") throw new Error("OAuth identity response was invalid");
    clearOAuthState();
    history.replaceState(null, "", "/dashboard/analysis/");
    renderAuthUi(connectButton, accountLabel, "signed-in", identity.githubLogin);
    form.hidden = false;
    jevControls.hidden = false;
    activateRuntime();
    setNotice("Ask a question to generate a read-only interface from Soyuz run data.", "info");
  } catch {
    clearOAuthState();
    if (accessToken && oauthClientId) {
      try { await revokeAccessToken(accessToken, oauthClientId); }
      catch { /* Clear the local session even if revocation cannot be confirmed. */ }
    }
    clearLocalSession("We couldn't complete sign-in. Please try again.", "danger");
  }
}

async function signOut(): Promise<void> {
  const token = accessToken;
  const clientId = oauthClientId;
  accessToken = null;
  oauthClientId = null;
  renderAuthUi(connectButton, accountLabel, "signing-out");
  form.hidden = true;
  jevControls.hidden = true;
  disposeRuntime();
  clearAnalysisOutput();
  setNotice("Signing out…", "info");
  try {
    if (token && clientId) await revokeAccessToken(token, clientId);
    clearLocalSession("You're signed out.", "success");
  } catch {
    clearLocalSession("You're signed out on this page. We couldn't confirm that your token was revoked; it will expire within one hour.", "warning");
  }
}

function clearLocalSession(message: string, tone: "info" | "success" | "warning" | "danger"): void {
  accessToken = null;
  oauthClientId = null;
  form.hidden = true;
  jevControls.hidden = true;
  renderAuthUi(connectButton, accountLabel, "signed-out");
  disposeRuntime();
  clearAnalysisOutput();
  clearOAuthState();
  setNotice(message, tone);
}

function activateRuntime(): void {
  if (!accessToken) return;
  disposeRuntime();
  runtime = createSoyuzOpenUIRuntime(accessToken, fetch, () => {
    clearLocalSession("Your sign-in has expired or access has changed. Sign in again to continue.", "danger");
  });
  renderer = new OpenUIDOMRenderer(output, soyuzOpenUILibrary, soyuzComponentRenderers, {
    maxDepth: OPENUI_MAX_DEPTH,
    maxComponents: OPENUI_MAX_COMPONENTS,
  });
  stopRuntimeSubscription = runtime.subscribe(renderRuntime);
  jevRuntime = createSoyuzOpenUIRuntime(accessToken, fetch, () => {
    clearLocalSession("Your sign-in has expired or access has changed. Sign in again to continue.", "danger");
  });
  jevRenderer = new OpenUIDOMRenderer(jevOutput, soyuzOpenUILibrary, soyuzComponentRenderers, {
    maxDepth: OPENUI_MAX_DEPTH,
    maxComponents: OPENUI_MAX_COMPONENTS,
  });
  stopJevRuntimeSubscription = jevRuntime.subscribe(renderJevRuntime);
}

function disposeRuntime(): void {
  stopRuntimeSubscription?.();
  stopRuntimeSubscription = null;
  stopJevRuntimeSubscription?.();
  stopJevRuntimeSubscription = null;
  renderer?.dispose();
  renderer = null;
  runtime?.dispose();
  runtime = null;
  jevRenderer?.dispose();
  jevRenderer = null;
  jevRuntime?.dispose();
  jevRuntime = null;
}

function renderRuntime(): void {
  if (!runtime || !renderer) return;
  const root = runtime.getRoot();
  if (root) renderer.render(root, {
    store: runtime.store,
    queryManager: runtime.queryManager,
    dispatchAction,
  });
  const snapshot = runtime.queryManager.getSnapshot();
  if (snapshot.__openui_errors.length > 0) {
    setDataNotice("Some run data could not be loaded. Refresh or select a different run to try again.", "warning");
  } else if (runtime.queryManager.isAnyLoading()) {
    setDataNotice("Loading approved Soyuz run data…", "info");
  } else {
    setDataNotice("", "empty");
  }
}

function renderJevRuntime(): void {
  if (!jevRuntime || !jevRenderer || !hasRunJev) return;
  const root = jevRuntime.getRoot();
  if (root) jevRenderer.render(root, {
    store: jevRuntime.store,
    queryManager: jevRuntime.queryManager,
    dispatchAction: () => undefined,
  });
  const snapshot = jevRuntime.queryManager.getSnapshot();
  if (snapshot.__openui_errors.length > 0) {
    hasRunJev = false;
    isRunningJev = false;
    jevButton.disabled = false;
    jevProfile.disabled = false;
    jevRunId.disabled = false;
    setJevNotice("JEV could not validate a response for this run. No action was taken.", "warning");
    jevFeedback.hidden = true;
  } else if (jevRuntime.queryManager.isAnyLoading()) {
    setJevNotice("JEV is assessing the selected run. Please wait…", "info");
  } else {
    hasRunJev = false;
    isRunningJev = false;
    jevButton.disabled = false;
    jevProfile.disabled = false;
    jevRunId.disabled = false;
    setJevNotice("Advisory result received. Review the run record and confirm any consequential decision yourself.", "success");
    jevFeedback.hidden = false;
  }
}

async function runJevAssessment(): Promise<void> {
  if (!accessToken || !jevRuntime || !jevRenderer || isRunningJev) return;
  const runId = jevRunId.value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    setJevNotice("Enter a retained run UUID or select a run in the generated table.", "warning");
    jevRunId.focus();
    return;
  }
  const profileId = jevProfile.value;
  if (!isJevProfileId(profileId)) {
    setJevNotice("Select a supported JEV profile.", "warning");
    return;
  }

  const program = createJevDecisionProgram(profileId, runId.toLowerCase());
  const validated = validateGeneratedProgram(program, { allowJev: true });
  if (!validated.ok || !validated.result) {
    setJevNotice("The JEV view could not be prepared. No provider request was sent.", "warning");
    return;
  }

  isRunningJev = true;
  hasRunJev = true;
  jevButton.disabled = true;
  jevProfile.disabled = true;
  jevRunId.disabled = true;
  jevOutput.hidden = false;
  jevOutput.replaceChildren();
  jevFeedback.hidden = true;
  jevFeedbackNotice.textContent = "";
  for (const button of jevFeedbackButtons) button.disabled = false;
  setJevNotice("Sending the approved run projection to OpenRouter for advisory analysis…", "info");
  jevRuntime.setProgram(validated.result);
  renderJevRuntime();
}

function createJevDecisionProgram(profileId: JevProfileId, runId: string): string {
  const profile = JEV_PROFILE_VIEWS[profileId];
  const components = [`Heading(${JSON.stringify(profile.title)})`, 'Text("Advisory decision support. Verify the recorded run before taking consequential action.", "warning")'];
  for (const field of profile.answers) {
    const title = field.title;
    const answer = `decision.answers.${field.key}`;
    components.push(`DecisionSummary(${JSON.stringify(title)}, ${answer})`);
    if (field.type === "score") {
      components.push(`ScoreScale(${JSON.stringify(`${title} score`)}, ${answer}.score, ${answer}.legend, ${answer}.probabilities)`);
    } else {
      const labels = field.type === "choice"
        ? field.labels ?? {}
        : { false: "False", true: "True" };
      components.push(`ChoiceProbabilities(${JSON.stringify(`${title} probabilities`)}, ${answer}.probabilities, ${JSON.stringify(labels)})`);
    }
    components.push(`ConfidenceDisplay(${JSON.stringify(`${title} confidence`)}, ${answer}.confidence)`);
  }
  const query = `decision = Query("jev_decisions", { profileId: ${JSON.stringify(profileId)}, runId: ${JSON.stringify(runId)} }, { model: "", answers: {} })`;
  return `${query}\nroot = Stack([${components.join(", ")}])`;
}

async function submitJevFeedback(rating: "helpful" | "not_helpful"): Promise<void> {
  if (!accessToken || !jevProfile.value || !jevRunId.value || jevFeedbackButtons.every((button) => button.disabled)) return;
  for (const button of jevFeedbackButtons) button.disabled = true;
  try {
    await fetchJson<{ data: { saved: boolean } }>("/dashboard/api/analysis/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        profileId: jevProfile.value,
        runId: jevRunId.value.trim().toLowerCase(),
        rating,
      }),
      cache: "no-store",
    });
    jevFeedbackNotice.textContent = "Thanks. Your rating is recorded without saving JEV's answer.";
  } catch (error) {
    for (const button of jevFeedbackButtons) button.disabled = false;
    jevFeedbackNotice.textContent = error instanceof HttpError && (error.status === 401 || error.status === 403)
      ? "Sign in again to record feedback."
      : "Feedback could not be saved. Please try again.";
  }
}

function isJevProfileId(value: string): value is JevProfileId {
  return Object.hasOwn(JEV_PROFILE_VIEWS, value);
}

function setJevNotice(message: string, tone: "info" | "success" | "warning"): void {
  jevNotice.hidden = message.length === 0;
  jevNotice.className = `notice notice--${tone}`;
  jevNotice.textContent = message;
}

function clearJevAssessment(): void {
  if (isRunningJev) return;
  hasRunJev = false;
  jevRenderer?.clear();
  jevOutput.replaceChildren();
  jevOutput.hidden = true;
  setJevNotice("", "info");
}

async function generateAnalysis(mode: AnalysisMode): Promise<void> {
  if (!accessToken || !runtime || !renderer || isGenerating) return;
  const prompt = question.value.trim();
  if (!prompt) {
    setNotice("Enter a question about retained run data.", "warning");
    question.focus();
    return;
  }
  if (mode === "edit" && !currentProgram) {
    setNotice("Generate an interface before refining it.", "warning");
    return;
  }
  isGenerating = true;
  generateButton.disabled = true;
  refineButton.disabled = true;
  setNotice(mode === "edit" ? "Refining the current interface…" : "Generating an interface…", "info");
  try {
    const patch = await streamGeneration(prompt, mode, mode === "edit" ? currentProgram : undefined);
    const program = mode === "edit" ? mergeStatements(currentProgram, patch, "root") : patch;
    const validated = validateGeneratedProgram(program);
    if (!validated.ok || !validated.result) throw new Error(validated.reason ?? "The generated interface was invalid.");
    runtime.setProgram(validated.result);
    currentProgram = program;
    renderRuntime();
    refineButton.hidden = false;
    question.value = "";
    setNotice(mode === "edit" ? "Interface refined. Filters and queries remain interactive." : "Interface ready. Select a run, filter, or sort without another generation call.", "success");
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      clearLocalSession("Your sign-in has expired or access has changed. Sign in again to continue.", "danger");
    } else {
      setNotice(error instanceof Error ? error.message.slice(0, 240) : "The interface could not be generated. Please try again.", "danger");
    }
  } finally {
    isGenerating = false;
    generateButton.disabled = false;
    refineButton.disabled = false;
  }
}

async function streamGeneration(prompt: string, mode: AnalysisMode, existingProgram?: string): Promise<string> {
  const token = accessToken;
  if (!token) throw new Error("Sign in to generate an analysis.");
  const response = await fetch("/dashboard/api/analysis/generate", {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ prompt, mode, ...(existingProgram ? { existingProgram } : {}) }),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new HttpError("sign-in required", response.status);
    throw new Error(response.status === 503 ? "AI analysis is not configured. Contact your Soyuz administrator." : "The analysis request could not be completed.");
  }
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) {
    throw new Error("The AI provider returned an unsupported response.");
  }

  const parser = createStreamingParser(soyuzOpenUILibrary.toJSONSchema(), "Stack");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let source = "";
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.length > OPENUI_MAX_PROGRAM_CHARS * 3) throw new Error("The AI response exceeded supported limits.");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (consumeAnalysisFrame(frame, (delta) => {
          source += delta;
          if (source.length > OPENUI_MAX_PROGRAM_CHARS) throw new Error("The AI response exceeded supported limits.");
          const result = parser.set(source);
          const preview = previewHeadings(result);
          if (preview && mode === "generate" && renderer && runtime) {
            renderer.render(preview, { store: runtime.store, queryManager: runtime.queryManager, dispatchAction: () => undefined });
          }
        })) {
          complete = true;
          break;
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (chunk.done) break;
      if (complete) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!complete) throw new Error("The AI response ended before the interface was complete.");
  parser.set(source, true);
  return source;
}

function consumeAnalysisFrame(frame: string, onDelta: (delta: string) => void): boolean {
  const lines = frame.replaceAll("\r", "").split("\n");
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const data = lines.filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return false;
  let payload: unknown;
  try { payload = JSON.parse(data); }
  catch { throw new Error("The AI response stream was malformed."); }
  if (eventName === "error" || (payload && typeof payload === "object" && "error" in payload)) {
    throw new Error("The AI response was incomplete or invalid. Please try again.");
  }
  if (!payload || typeof payload !== "object") return false;
  const message = payload as { delta?: unknown; done?: unknown };
  if (typeof message.delta === "string") onDelta(message.delta);
  return message.done === true;
}

function previewHeadings(result: ParseResult): ElementNode | null {
  const root = result.root;
  if (!root || root.typeName !== "Stack" || root.partial || result.meta.unresolved.length > 0 || result.meta.errors.length > 0) return null;
  const children = root.props.children;
  if (!Array.isArray(children)) return null;
  const headings = children.filter((child): child is ElementNode => isElementNode(child)
    && child.typeName === "Heading" && !child.partial && typeof child.props.text === "string");
  if (headings.length === 0) return null;
  return { ...root, partial: false, props: { children: headings, direction: "vertical" } };
}

function dispatchAction(action: OpenUIAction): void {
  if (!runtime) return;
  const validated = validateSoyuzAction(action);
  if (!validated) {
    setDataNotice("An unsupported interface action was ignored.", "warning");
    return;
  }
  switch (validated.type) {
    case "refresh_runs":
      runtime.refresh();
      break;
    case "reset_filters":
      runtime.store.set("$runStatus", "all");
      runtime.store.set("$selectedRunId", "");
      runtime.store.set("$runSort", "createdAt");
      runtime.refresh();
      break;
    case "select_run": {
      const runId = validated.params.runId;
      if (typeof runId === "string" && isLoadedRun(runId)) {
        runtime.store.set("$selectedRunId", runId);
        if (!isRunningJev) {
          jevRunId.value = runId;
          const selectedRun = findLoadedRun(runId);
          const suggestedProfile = selectedRun ? suggestedJevProfile(selectedRun) : null;
          if (suggestedProfile) jevProfile.value = suggestedProfile;
          clearJevAssessment();
        }
      }
      break;
    }
    case "navigate_dashboard": {
      const path = validated.params.path;
      if (path === "/dashboard/" || path === "/dashboard/analysis/") location.assign(path);
      break;
    }
  }
}

function isLoadedRun(runId: string): boolean {
  return findLoadedRun(runId) !== null;
}

function findLoadedRun(runId: string): { status?: unknown; operationalHealth?: unknown } | null {
  if (!runtime) return null;
  const snapshot = runtime.queryManager.getSnapshot();
  for (const value of Object.values(snapshot)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const runs = (value as { runs?: unknown }).runs;
    if (Array.isArray(runs)) {
      const selected = runs.find((run) => run && typeof run === "object" && (run as { runId?: unknown }).runId === runId);
      if (selected && typeof selected === "object") return selected as { status?: unknown; operationalHealth?: unknown };
    }
    if ((value as { runId?: unknown }).runId === runId && typeof (value as { status?: unknown }).status === "string") {
      return value as { status?: unknown; operationalHealth?: unknown };
    }
  }
  return null;
}

async function apiJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    cache: "no-store",
  });
}

function setNotice(message: string, tone: "info" | "success" | "warning" | "danger"): void {
  notice.className = `notice notice--${tone}`;
  notice.textContent = message;
}

function setDataNotice(message: string, tone: "info" | "empty" | "warning"): void {
  dataNotice.hidden = message.length === 0;
  dataNotice.className = `notice notice--${tone}`;
  dataNotice.textContent = message;
}

function clearAnalysisOutput(): void {
  currentProgram = "";
  question.value = "";
  refineButton.hidden = true;
  renderer?.clear();
  jevRenderer?.clear();
  jevRunId.value = "";
  jevOutput.replaceChildren();
  jevOutput.hidden = true;
  jevFeedback.hidden = true;
  jevFeedbackNotice.textContent = "";
  jevNotice.hidden = true;
  isRunningJev = false;
  hasRunJev = false;
  jevProfile.disabled = false;
  jevRunId.disabled = false;
  setDataNotice("", "empty");
}

function clearOAuthState(): void {
  for (const key of oauthKeys) sessionStorage.removeItem(`soyuz.analysis.${key}`);
}

function randomString(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing analysis page element: ${selector}`);
  return element;
}

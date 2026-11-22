import { fetchJson, HttpError } from "../api.js";
import { revokeAccessToken } from "../auth-api.js";
import { renderAuthUi } from "../auth-ui.js";
import { createSnackBarController } from "../snackbar.js";
import { setButtonBusy, setNotice as renderNotice } from "../ui/components.js";
import { A2UI_MAX_STREAM_CHARS, validateA2uiMessages } from "../../a2ui/protocol";
import { A2uiDomRenderer, type AnalysisAction } from "./a2ui-renderer";
import { JEV_PROFILE_VIEWS, renderJevResult, type JevProfileId } from "./jev-renderer";
import { suggestedJevProfile } from "./jev-selection";

interface OAuthRegistration { client_id: string }
interface OAuthTokenResponse { access_token: string }
interface RunSummary {
  runId: string;
  displayId: string;
  status: string;
  stage: string | null;
  operationalHealth: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}
interface RunDetail extends RunSummary {
  outcomeSummary: string | null;
  changedFileCount: number | null;
  exitCode: number | null;
}
interface EventRecord {
  eventId: string;
  type: string;
  stage: string | null;
  step: string | null;
  timestamp: string;
  payload: Record<string, string | number | boolean>;
}
interface ArtifactRecord { id: string; name: string; size: number }
interface AnalysisData {
  runs: RunSummary[];
  statusCounts: Array<{ status: string; count: number }>;
  selectedRunId: string;
  selectedRun: RunDetail | null;
  events: EventRecord[];
  artifacts: ArtifactRecord[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
const dataControls = requiredElement<HTMLElement>("#analysis-data-controls");
const statusFilter = requiredElement<HTMLSelectElement>("#analysis-status-filter");
const sortSelect = requiredElement<HTMLSelectElement>("#analysis-sort");
const refreshButton = requiredElement<HTMLButtonElement>("#analysis-refresh");
const jevDisclosure = requiredElement<HTMLDetailsElement>("#analysis-jev-disclosure");
const jevControls = requiredElement<HTMLElement>("#analysis-jev-controls");
const jevForm = requiredElement<HTMLFormElement>("#analysis-jev-form");
const jevProfile = requiredElement<HTMLSelectElement>("#analysis-jev-profile");
const jevRunId = requiredElement<HTMLInputElement>("#analysis-jev-run-id");
const jevButton = requiredElement<HTMLButtonElement>("#analysis-jev-run");
const jevNotice = requiredElement<HTMLElement>("#analysis-jev-notice");
const jevOutput = requiredElement<HTMLElement>("#analysis-jev-output");
const jevFeedback = requiredElement<HTMLElement>("#analysis-jev-feedback");
const jevFeedbackNotice = requiredElement<HTMLElement>("#analysis-jev-feedback-notice");
const snackbar = createSnackBarController(requiredElement<HTMLElement>("#snackbar"));
const jevFeedbackButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-jev-rating]")];

let accessToken: string | null = null;
let oauthClientId: string | null = null;
let renderer: A2uiDomRenderer | null = null;
let currentMessages: unknown[] = [];
let allRuns: RunSummary[] = [];
let selectedRunId = "";
let selectedRun: RunDetail | null = null;
let selectedEvents: EventRecord[] = [];
let selectedArtifacts: ArtifactRecord[] = [];
let isGenerating = false;
let isRefreshing = false;
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
  void generateAnalysis(submitter instanceof HTMLButtonElement && submitter.value === "edit" ? "edit" : "generate");
});
statusFilter.addEventListener("change", renderAnalysis);
sortSelect.addEventListener("change", renderAnalysis);
refreshButton.addEventListener("click", () => void refreshData());
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
window.addEventListener("pagehide", disposeRenderer);

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
    dataControls.hidden = false;
    jevDisclosure.hidden = false;
    jevControls.hidden = false;
    activateRenderer();
    setNotice("Ask a question to generate a read-only view from retained Soyuz run data.", "info");
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
  dataControls.hidden = true;
  jevDisclosure.hidden = true;
  jevControls.hidden = true;
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
  dataControls.hidden = true;
  jevDisclosure.hidden = true;
  jevControls.hidden = true;
  renderAuthUi(connectButton, accountLabel, "signed-out");
  clearAnalysisOutput();
  clearOAuthState();
  setNotice(message, tone);
}

function activateRenderer(): void {
  disposeRenderer();
  renderer = new A2uiDomRenderer(output, handleAnalysisAction);
}

function disposeRenderer(): void {
  renderer?.dispose();
  renderer = null;
}

async function generateAnalysis(mode: "generate" | "edit"): Promise<void> {
  if (!accessToken || !renderer || isGenerating) return;
  const prompt = question.value.trim();
  if (!prompt) {
    setNotice("Enter a question about retained run data.", "warning");
    question.focus();
    return;
  }
  if (mode === "edit" && currentMessages.length === 0) {
    setNotice("Generate an interface before refining it.", "warning");
    return;
  }
  isGenerating = true;
  generateButton.disabled = true;
  if (mode === "edit") setButtonBusy(refineButton, true, "Refining interface…");
  else setButtonBusy(generateButton, true, "Generating interface…");
  setNotice(mode === "edit" ? "Refining the current interface…" : "Generating an interface…", "info");
  try {
    const additions = await streamGeneration(prompt, mode);
    const nextMessages = mode === "edit" ? [...currentMessages, ...additions] : additions;
    const validation = validateA2uiMessages(nextMessages);
    if (!validation.ok) throw new Error("The generated interface was invalid.");
    currentMessages = nextMessages;
    renderAnalysis();
    refineButton.hidden = false;
    question.value = "";
    setNotice(mode === "edit" ? "Interface refined." : "Interface ready. Use the fixed filters or select a run to inspect its recorded details.", "success");
    if (allRuns.length === 0) await refreshData(false);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      clearLocalSession("Your sign-in has expired or access has changed. Sign in again to continue.", "danger");
    } else {
      setNotice(error instanceof Error ? error.message.slice(0, 240) : "The interface could not be generated. Please try again.", "danger");
    }
  } finally {
    isGenerating = false;
    setButtonBusy(generateButton, false);
    setButtonBusy(refineButton, false);
    generateButton.disabled = false;
  }
}

async function streamGeneration(prompt: string, mode: "generate" | "edit"): Promise<unknown[]> {
  const token = accessToken;
  if (!token) throw new Error("Sign in to generate an analysis.");
  const response = await fetch("/dashboard/api/analysis/generate", {
    method: "POST",
    cache: "no-store",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      prompt,
      mode,
      ...(mode === "edit" ? { existingSurface: JSON.stringify(currentMessages) } : {}),
    }),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new HttpError("sign-in required", response.status);
    throw new Error(response.status === 503 ? "AI analysis is not configured. Contact your Soyuz administrator." : "The analysis request could not be completed.");
  }
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) {
    throw new Error("The AI provider returned an unsupported response.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const additions: unknown[] = [];
  let buffer = "";
  let responseChars = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      const decoded = decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, "\n");
      buffer += decoded;
      responseChars += decoded.length;
      if (responseChars > A2UI_MAX_STREAM_CHARS * 2) throw new Error("The AI response exceeded supported limits.");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const status = consumeA2uiFrame(frame, additions);
        if (status === "error") throw new Error("The AI response was incomplete or invalid. Please try again.");
        if (status === "done") complete = true;
        boundary = buffer.indexOf("\n\n");
      }
      if (chunk.done || complete) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!complete || additions.length === 0) throw new Error("The AI response ended before the interface was complete.");
  const combined = mode === "edit" ? [...currentMessages, ...additions] : additions;
  if (!validateA2uiMessages(combined).ok) throw new Error("The generated A2UI surface failed validation.");
  return additions;
}

function consumeA2uiFrame(frame: string, additions: unknown[]): "continue" | "done" | "error" {
  const lines = frame.replaceAll("\r", "").split("\n");
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data) return "continue";
  let payload: unknown;
  try { payload = JSON.parse(data); }
  catch { return "error"; }
  if (eventName === "error" || (payload && typeof payload === "object" && "error" in payload)) return "error";
  if (eventName === "a2ui") additions.push(payload);
  if (eventName === "done") return "done";
  return "continue";
}

async function refreshData(showNotice = true): Promise<void> {
  if (!accessToken || isRefreshing) return;
  isRefreshing = true;
  setButtonBusy(refreshButton, true, "Refreshing…");
  if (showNotice) setDataNotice("Loading approved Soyuz run data…", "info");
  try {
    const page = await apiJson<{ runs: unknown[] }>("/dashboard/api/runs?limit=30");
    allRuns = Array.isArray(page.runs) ? page.runs.map(projectRun).filter((run): run is RunSummary => run !== null) : [];
    if (selectedRunId && !allRuns.some((run) => run.runId === selectedRunId)) {
      selectedRunId = "";
      selectedRun = null;
      selectedEvents = [];
      selectedArtifacts = [];
    }
    if (selectedRunId) await loadSelectedRun(selectedRunId);
    renderAnalysis();
    setDataNotice(allRuns.length ? "Showing read-only data from retained runs." : "No retained runs are currently available.", "empty");
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      clearLocalSession("Your sign-in has expired or access has changed. Sign in again to continue.", "danger");
    } else {
      setDataNotice("Some run data could not be loaded. Refresh to try again.", "warning");
    }
  } finally {
    isRefreshing = false;
    setButtonBusy(refreshButton, false);
  }
}

async function loadSelectedRun(runId: string): Promise<void> {
  if (!UUID.test(runId) || !allRuns.some((run) => run.runId === runId)) return;
  const encoded = encodeURIComponent(runId);
  const [detailResponse, eventResponse, artifactResponse] = await Promise.all([
    apiJson<Record<string, unknown>>(`/dashboard/api/runs/${encoded}`),
    apiJson<{ events: unknown[] }>(`/dashboard/api/runs/${encoded}/events?limit=50&after=0`),
    apiJson<{ artifacts: unknown[] }>(`/dashboard/api/runs/${encoded}/artifacts`),
  ]);
  if (selectedRunId !== runId) return;
  selectedRun = projectDetail(detailResponse);
  selectedEvents = Array.isArray(eventResponse.events) ? eventResponse.events.map(projectEvent).filter((event): event is EventRecord => event !== null) : [];
  selectedArtifacts = Array.isArray(artifactResponse.artifacts)
    ? artifactResponse.artifacts.map(projectArtifact).filter((artifact): artifact is ArtifactRecord => artifact !== null)
    : [];
}

function renderAnalysis(): void {
  if (!renderer || currentMessages.length === 0) return;
  const runs = displayedRuns();
  const statusCounts = countStatuses(allRuns);
  try {
    renderer.render(currentMessages, {
      runs,
      statusCounts,
      selectedRunId,
      selectedRun,
      events: selectedEvents.slice(0, 50),
      artifacts: selectedArtifacts.slice(0, 100),
    });
  } catch {
    setDataNotice("The generated interface could not be rendered safely. Generate a new interface to continue.", "warning");
  }
}

function displayedRuns(): RunSummary[] {
  const status = statusFilter.value;
  const sort = sortSelect.value;
  return allRuns.filter((run) => status === "all" || run.status === status).toSorted((left, right) => {
    if (sort === "displayId") return left.displayId.localeCompare(right.displayId);
    if (sort === "status") return left.status.localeCompare(right.status) || right.createdAt.localeCompare(left.createdAt);
    return right.createdAt.localeCompare(left.createdAt);
  }).slice(0, 30);
}

function handleAnalysisAction(action: AnalysisAction): void {
  switch (action.name) {
    case "refresh_runs":
      void refreshData();
      break;
    case "reset_filters":
      statusFilter.value = "all";
      sortSelect.value = "createdAt";
      selectedRunId = "";
      selectedRun = null;
      selectedEvents = [];
      selectedArtifacts = [];
      renderAnalysis();
      void refreshData();
      break;
    case "select_run":
      if (typeof action.context.runId === "string") void selectRun(action.context.runId);
      break;
    case "navigate_dashboard":
      if (action.context.path === "/dashboard/analysis/") location.assign("/dashboard/analysis/");
      break;
  }
}

async function selectRun(runId: string): Promise<void> {
  if (!UUID.test(runId) || !allRuns.some((run) => run.runId === runId)) return;
  selectedRunId = runId;
  const run = allRuns.find((item) => item.runId === runId);
  jevRunId.value = runId;
  if (run) {
    const suggested = suggestedJevProfile(run);
    if (suggested) jevProfile.value = suggested;
  }
  clearJevAssessment();
  renderAnalysis();
  setDataNotice("Loading the selected run's recorded details…", "info");
  try {
    await loadSelectedRun(runId);
    renderAnalysis();
    setDataNotice("Selected run details loaded from Soyuz's read-only APIs.", "empty");
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      clearLocalSession("Your sign-in has expired or access has changed. Sign in again to continue.", "danger");
    } else {
      selectedRun = null;
      selectedEvents = [];
      selectedArtifacts = [];
      renderAnalysis();
      setDataNotice("Selected run details could not be loaded. Refresh or select another run.", "warning");
    }
  }
}

async function runJevAssessment(): Promise<void> {
  if (!accessToken || isRunningJev) return;
  const runId = jevRunId.value.trim();
  if (!UUID.test(runId)) {
    setJevNotice("Enter a retained run UUID or select a run in the generated view.", "warning");
    jevRunId.focus();
    return;
  }
  const profileId = jevProfile.value;
  if (!isJevProfileId(profileId)) {
    setJevNotice("Select a supported JEV profile.", "warning");
    return;
  }
  isRunningJev = true;
  setButtonBusy(jevButton, true, "Assessing run…");
  jevProfile.disabled = true;
  jevRunId.disabled = true;
  jevOutput.hidden = false;
  jevOutput.replaceChildren();
  jevFeedback.hidden = true;
  jevFeedbackNotice.textContent = "";
  for (const button of jevFeedbackButtons) button.disabled = false;
  setJevNotice("Sending the approved run projection to Senku for advisory analysis…", "info");
  try {
    const result = await apiJson<{ model: string; answers: Record<string, unknown> }>("/dashboard/api/analysis/decisions", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ profileId, runId: runId.toLowerCase() }),
      cache: "no-store",
    });
    renderJevResult(jevOutput, profileId, result);
    hasRunJev = true;
    setJevNotice("Advisory result received. Review the run record and confirm any consequential decision yourself.", "success");
    jevFeedback.hidden = false;
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      clearLocalSession("Your sign-in has expired or access has changed. Sign in again to continue.", "danger");
    } else {
      setJevNotice("JEV could not validate a response for this run. No action was taken.", "warning");
    }
    hasRunJev = false;
    jevFeedback.hidden = true;
  } finally {
    isRunningJev = false;
    setButtonBusy(jevButton, false);
    jevProfile.disabled = false;
    jevRunId.disabled = false;
  }
}

async function submitJevFeedback(rating: "helpful" | "not_helpful"): Promise<void> {
  if (!accessToken || !hasRunJev || !isJevProfileId(jevProfile.value) || !UUID.test(jevRunId.value.trim())
    || jevFeedbackButtons.every((button) => button.disabled)) return;
  for (const button of jevFeedbackButtons) button.disabled = true;
  const activeButton = jevFeedbackButtons.find((button) => button.dataset.jevRating === rating);
  if (activeButton) setButtonBusy(activeButton, true, "Saving rating…");
  try {
    await apiJson<{ saved: boolean }>("/dashboard/api/analysis/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ profileId: jevProfile.value, runId: jevRunId.value.trim().toLowerCase(), rating }),
      cache: "no-store",
    });
    if (activeButton) {
      setButtonBusy(activeButton, false);
      activeButton.disabled = true;
    }
    jevFeedbackNotice.textContent = "";
    snackbar.show("Rating recorded; JEV's answer was not saved.", "success");
  } catch (error) {
    for (const button of jevFeedbackButtons) setButtonBusy(button, false);
    jevFeedbackNotice.textContent = error instanceof HttpError && (error.status === 401 || error.status === 403)
      ? "Sign in again to record feedback."
      : "Feedback could not be saved. Please try again.";
  }
}

function isJevProfileId(value: string): value is JevProfileId {
  return Object.hasOwn(JEV_PROFILE_VIEWS, value);
}

function clearJevAssessment(): void {
  if (isRunningJev) return;
  hasRunJev = false;
  jevOutput.replaceChildren();
  jevOutput.hidden = true;
  jevFeedback.hidden = true;
  jevFeedbackNotice.textContent = "";
  setJevNotice("", "info");
}

function projectRun(value: unknown): RunSummary | null {
  if (!isRecord(value) || typeof value.runId !== "string" || !UUID.test(value.runId)) return null;
  const startedAt = nullableString(value.startedAt, 40);
  const completedAt = nullableString(value.completedAt, 40);
  return {
    runId: value.runId,
    displayId: safeString(value.displayId, 80) || "Retained run",
    status: safeString(value.status, 40) || "unknown",
    stage: nullableString(value.stage, 80),
    operationalHealth: safeString(value.operationalHealth, 40) || "unknown",
    createdAt: safeString(value.createdAt, 40),
    startedAt,
    completedAt,
    durationMs: durationMs(startedAt, completedAt),
  };
}

function projectDetail(value: Record<string, unknown>): RunDetail | null {
  const summary = projectRun(value);
  if (!summary) return null;
  return {
    ...summary,
    outcomeSummary: nullableString(value.outcomeSummary, 2_000),
    changedFileCount: safeInteger(value.changedFileCount, 0, 1_000_000),
    exitCode: safeInteger(value.exitCode, -1_000_000, 1_000_000),
  };
}

function projectEvent(value: unknown): EventRecord | null {
  if (!isRecord(value) || typeof value.eventId !== "string") return null;
  const payload: Record<string, string | number | boolean> = {};
  if (isRecord(value.payload)) {
    for (const [key, item] of Object.entries(value.payload).slice(0, 12)) {
      if (typeof item === "string") payload[key.slice(0, 64)] = item.slice(0, 160);
      else if (typeof item === "number" && Number.isFinite(item)) payload[key.slice(0, 64)] = item;
      else if (typeof item === "boolean") payload[key.slice(0, 64)] = item;
    }
  }
  return {
    eventId: value.eventId.slice(0, 80),
    type: safeString(value.type, 80),
    stage: nullableString(value.stage, 80),
    step: nullableString(value.step, 80),
    timestamp: safeString(value.timestamp, 40),
    payload,
  };
}

function projectArtifact(value: unknown): ArtifactRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || !UUID.test(value.id)) return null;
  return { id: value.id, name: safeString(value.name, 160), size: safeInteger(value.size, 0, 1_000_000_000) ?? 0 };
}

function countStatuses(runs: RunSummary[]): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  return [...counts].toSorted(([left], [right]) => left.localeCompare(right)).map(([status, count]) => ({ status, count }));
}

function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 && duration <= 31_536_000_000 ? duration : null;
}

function safeString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function nullableString(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function safeInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  return fetchJson<T>(path, { ...init, headers, cache: init.cache ?? "no-store" });
}

function setNotice(message: string, tone: "info" | "success" | "warning" | "danger"): void {
  renderNotice(notice, message, tone);
}

function setDataNotice(message: string, tone: "info" | "empty" | "warning"): void {
  renderNotice(dataNotice, message, tone);
}

function setJevNotice(message: string, tone: "info" | "success" | "warning"): void {
  renderNotice(jevNotice, message, tone);
}

function clearAnalysisOutput(): void {
  currentMessages = [];
  allRuns = [];
  selectedRunId = "";
  selectedRun = null;
  selectedEvents = [];
  selectedArtifacts = [];
  question.value = "";
  setButtonBusy(generateButton, false);
  setButtonBusy(refineButton, false);
  generateButton.disabled = false;
  refineButton.hidden = true;
  renderer?.clear();
  jevRunId.value = "";
  jevOutput.replaceChildren();
  jevOutput.hidden = true;
  jevFeedback.hidden = true;
  jevFeedbackNotice.textContent = "";
  jevNotice.hidden = true;
  setButtonBusy(jevButton, false);
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

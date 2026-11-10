import { fetchJson, HttpError } from "./api.js";
import { revokeAccessToken } from "./auth-api.js";
import { renderAuthUi } from "./auth-ui.js";
import { createSnackBarController } from "./snackbar.js";
import { createDefinitionList, setButtonBusy, setNotice as renderNotice, type NoticeTone } from "./ui/components.js";
import { createRunCard, type DashboardRunSummary } from "./run-card.js";
import { safeHttpUrlForDisplay } from "./ui/safe-url.js";
import {
  formatEventLabel,
  formatEventPayloadValue,
  formatMachineLabel,
  formatTimestamp,
  RUN_STATUS_OPTIONS,
} from "./presentation.js";
import { buildRunListPath, filterAndSortRuns, type RunSortOrder } from "./run-list.js";

interface OAuthRegistration {
  client_id: string;
}

interface OAuthTokenResponse {
  access_token: string;
}

interface DashboardRunListResponse {
  runs: DashboardRunSummary[];
  nextCursor: string | null;
}

interface DashboardRunDetail extends DashboardRunSummary {
  outcomeSummary: string | null;
  taskMode: string;
  publishMode: string;
  publishedUrl: string | null;
  changedFileCount: number | null;
  failureClass: string | null;
  exitCode: number | null;
}

interface DashboardArtifact {
  id: string;
  name: string;
  size: number;
}

interface DashboardArtifactListResponse {
  artifacts: DashboardArtifact[];
}

interface DashboardRunEventsResponse {
  events: DashboardRunEvent[];
  nextAfter: number;
  hasMore: boolean;
}

interface DashboardRunEvent {
  sequence: number;
  type: string;
  stage: string | null;
  step: string | null;
  timestamp: string;
  payload: Record<string, string | number | boolean>;
}

const notice = requiredElement<HTMLElement>("#notice");
const runsSection = requiredElement<HTMLElement>("#runs");
const runControls = requiredElement<HTMLElement>("#run-controls");
const connectButton = requiredElement<HTMLButtonElement>("#connect");
const accountLabel = requiredElement<HTMLElement>("#account");
const refreshButton = requiredElement<HTMLButtonElement>("#refresh");
const statusFilter = requiredElement<HTMLSelectElement>("#status-filter");
const runSearch = requiredElement<HTMLInputElement>("#run-search");
const runSort = requiredElement<HTMLSelectElement>("#run-sort");
const runCount = requiredElement<HTMLElement>("#run-count");
const loadMoreButton = requiredElement<HTMLButtonElement>("#load-more");
const updatedLabel = requiredElement<HTMLElement>("#updated");
const snackbar = createSnackBarController(requiredElement<HTMLElement>("#snackbar"));
const oauthKeys = ["state", "verifier", "clientId", "redirectUri"] as const;
const RUN_REFRESH_INTERVAL_MS = 30_000;
let accessToken: string | null = null;
let oauthClientId: string | null = null;
let runRefreshTimer: ReturnType<typeof setInterval> | null = null;
let nextCursor: string | null = null;
let isLoadingRuns = false;
let pendingRunReset = false;
let runsById = new Map<string, DashboardRunSummary>();
const expandedRunIds = new Set<string>();

populateStatusFilter();
setDashboardVisible(false);

connectButton.addEventListener("click", () => {
  if (accessToken) void signOut();
  else void connect();
});

renderAuthUi(connectButton, accountLabel, "signed-out");
void finishSignIn();

refreshButton.addEventListener("click", () => void loadRuns({ reset: true }));
runSearch.addEventListener("input", renderRuns);
runSort.addEventListener("change", renderRuns);
statusFilter.addEventListener("change", () => {
  expandedRunIds.clear();
  void loadRuns({ reset: true });
});
loadMoreButton.addEventListener("click", () => void loadRuns({ reset: false }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshRunsInBackground();
});

async function connect() {
  renderAuthUi(connectButton, accountLabel, "signing-in");
  setNotice("Opening GitHub sign-in…", "info");
  try {
    const redirectUri = `${location.origin}/dashboard/`;
    const registration = await fetchJson<OAuthRegistration>("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Soyuz Run Dashboard",
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
    sessionStorage.setItem("soyuz.dashboard.state", state);
    sessionStorage.setItem("soyuz.dashboard.verifier", verifier);
    sessionStorage.setItem("soyuz.dashboard.clientId", registration.client_id);
    sessionStorage.setItem("soyuz.dashboard.redirectUri", redirectUri);

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
    setNotice("We couldn't start sign-in. Please try again. If the problem continues, contact your Soyuz administrator.", "danger");
    renderAuthUi(connectButton, accountLabel, "signed-out");
  }
}

async function finishSignIn() {
  const params = new URL(location.href).searchParams;
  const code = params.get("code");
  if (!code) return;
  if (!oauthStateMatches(params)) {
    setNotice("We couldn't verify this sign-in. Please start again.", "danger");
    renderAuthUi(connectButton, accountLabel, "signed-out");
    return;
  }

  renderAuthUi(connectButton, accountLabel, "signing-in");
  setNotice("Completing sign-in…", "info");
  try {
    const token = await exchangeAuthorizationCode(code);
    accessToken = token.access_token;
    oauthClientId = sessionStorage.getItem("soyuz.dashboard.clientId");
    if (typeof accessToken !== "string" || !accessToken || !oauthClientId) {
      throw new Error("OAuth token response was incomplete");
    }
    const identity = await apiJson<{ githubLogin: string }>("/dashboard/api/me");
    if (typeof identity.githubLogin !== "string") throw new Error("OAuth identity response was invalid");
    clearOAuthState();
    history.replaceState(null, "", "/dashboard/");
    renderAuthUi(connectButton, accountLabel, "signed-in", identity.githubLogin);
    setDashboardVisible(true);
    await loadRuns({ reset: true });
    startRunRefresh();
  } catch {
    clearOAuthState();
    if (accessToken && oauthClientId) {
      try {
        await revokeAccessToken(accessToken, oauthClientId);
      } catch {
        // Clear local sign-in state even when the provider cannot confirm revocation.
      }
    }
    clearLocalSession("We couldn't complete sign-in. Please try again.", "danger");
  }
}

async function signOut() {
  const token = accessToken;
  const clientId = oauthClientId;
  accessToken = null;
  oauthClientId = null;
  renderAuthUi(connectButton, accountLabel, "signing-out");
  stopRunRefresh();
  runsSection.replaceChildren();
  setDashboardVisible(false);
  setNotice("Signing out…", "info");

  try {
    if (token && clientId) await revokeAccessToken(token, clientId);
    clearLocalSession("You're signed out.", "success");
  } catch {
    clearLocalSession("You're signed out on this page. We couldn't confirm that your token was revoked; it will expire within one hour.", "warning");
  }
}

function clearLocalSession(message: string, tone: NoticeTone = "info"): void {
  accessToken = null;
  oauthClientId = null;
  isLoadingRuns = false;
  pendingRunReset = false;
  stopRunRefresh();
  nextCursor = null;
  runsById = new Map();
  expandedRunIds.clear();
  loadMoreButton.hidden = true;
  updatedLabel.textContent = "";
  runsSection.replaceChildren();
  setDashboardVisible(false);
  renderAuthUi(connectButton, accountLabel, "signed-out");
  setNotice(message, tone);
}

function oauthStateMatches(params: URLSearchParams): boolean {
  const state = params.get("state");
  return Boolean(state && state === sessionStorage.getItem("soyuz.dashboard.state"));
}

async function exchangeAuthorizationCode(code: string): Promise<OAuthTokenResponse> {
  return fetchJson<OAuthTokenResponse>("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: sessionStorage.getItem("soyuz.dashboard.clientId") ?? "",
        redirect_uri: sessionStorage.getItem("soyuz.dashboard.redirectUri") ?? "",
        code_verifier: sessionStorage.getItem("soyuz.dashboard.verifier") ?? "",
        resource: `${location.origin}/`,
      }),
    });
}

function clearOAuthState() {
  for (const key of oauthKeys) sessionStorage.removeItem(`soyuz.dashboard.${key}`);
}

async function loadRuns(options: { reset: boolean; quiet?: boolean; refreshFirstPage?: boolean }): Promise<void> {
  const token = accessToken;
  if (!token) return;
  if (isLoadingRuns) {
    if (options.reset) pendingRunReset = true;
    return;
  }
  const cursor = options.reset || options.refreshFirstPage ? null : nextCursor;
  if (!options.reset && !options.refreshFirstPage && !cursor) return;

  isLoadingRuns = true;
  loadMoreButton.disabled = true;
  if (!options.quiet) {
    const loadingMore = !options.reset && !options.refreshFirstPage;
    setButtonBusy(loadingMore ? loadMoreButton : refreshButton, true, loadingMore ? "Loading more…" : "Loading runs…");
    runsSection.setAttribute("aria-busy", "true");
    setNotice(loadingMore ? "Loading more runs…" : "Loading recent runs…", "info");
  }
  try {
    const result = await apiJson<DashboardRunListResponse>(buildRunListPath({
      status: statusFilter.value || null,
      cursor,
    }));
    if (!token || token !== accessToken || !Array.isArray(result.runs)) return;
    if (options.reset) runsById = new Map();
    for (const run of result.runs) runsById.set(run.runId, run);
    if (options.reset || cursor || options.refreshFirstPage) nextCursor = result.nextCursor;
    if (!(options.refreshFirstPage && expandedRunIds.size > 0)) renderRuns();
    loadMoreButton.hidden = !nextCursor;
    updatedLabel.textContent = `Last refreshed ${new Date().toLocaleTimeString()}`;
    setNotice("", "info");
  } catch {
    if (token === accessToken) {
      if (!options.quiet) setNotice("We couldn't load runs. Please try again shortly.", "danger");
    }
  } finally {
    runsSection.removeAttribute("aria-busy");
    if (token === accessToken) {
      isLoadingRuns = false;
      if (!options.quiet) {
        setButtonBusy(refreshButton, false);
        setButtonBusy(loadMoreButton, false);
      }
      loadMoreButton.disabled = !nextCursor;
      if (pendingRunReset) {
        pendingRunReset = false;
        void loadRuns({ reset: true });
      }
    }
  }
}

function renderRuns(): void {
  const loadedRuns = [...runsById.values()];
  const order = runSort.value as RunSortOrder;
  const runs = filterAndSortRuns(loadedRuns, runSearch.value, order);
  runsSection.replaceChildren(...runs.map(renderRun));
  if (runs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "notice notice--empty run-list-empty";
    empty.textContent = loadedRuns.length > 0
      ? "No retained runs match your search and status filter. Clear the search or choose a different status."
      : statusFilter.value
        ? "No retained runs match this status filter."
        : "No runs yet. Runs submitted to Soyuz will appear here.";
    runsSection.append(empty);
  }
  const matching = statusFilter.value ? "matching " : "";
  const runLabel = loadedRuns.length === 1 ? "run" : "runs";
  runCount.textContent = loadedRuns.length === 0
    ? "No retained runs"
    : `Showing ${runs.length} of ${loadedRuns.length} ${matching}retained ${runLabel}`;
}

function renderRun(run: DashboardRunSummary): HTMLElement {
  return createRunCard(run, {
    ownerDocument: document,
    expanded: expandedRunIds.has(run.runId),
    onCopyId: (runId) => {
      const clipboard = navigator.clipboard;
      if (!clipboard) {
        snackbar.show("Clipboard access isn't available. You can select and copy the technical ID from run metadata.", "warning");
        return;
      }
      void clipboard.writeText(runId).then(
        () => { snackbar.show("Technical run ID copied.", "success"); },
        () => { snackbar.show("We couldn't copy the technical run ID. You can select and copy it from run metadata.", "danger"); },
      );
    },
    onDetailsToggle: (currentRun, details, content, expanded) => {
      if (expanded) {
        expandedRunIds.add(currentRun.runId);
        if (details.dataset.loaded !== "yes" && details.dataset.loading !== "yes") {
          void loadRunDetails(currentRun.runId, details, content);
        }
      } else {
        expandedRunIds.delete(currentRun.runId);
      }
    },
  });
}

async function loadRunDetails(runId: string, details: HTMLDetailsElement, content: HTMLElement): Promise<void> {
  const token = accessToken;
  if (!token || details.dataset.loading === "yes") return;
  details.dataset.loading = "yes";
  content.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "meta";
  loading.textContent = "Loading run details…";
  content.append(loading);
  try {
    const [detail, artifacts, eventPage] = await Promise.all([
      apiJson<DashboardRunDetail>(`/dashboard/api/runs/${encodeURIComponent(runId)}`),
      apiJson<DashboardArtifactListResponse>(`/dashboard/api/runs/${encodeURIComponent(runId)}/artifacts`),
      apiJson<DashboardRunEventsResponse>(`/dashboard/api/runs/${encodeURIComponent(runId)}/events?limit=100`),
    ]);
    if (token !== accessToken) return;
    content.replaceChildren();
    appendRunSummary(content, detail);
    appendRunEvents(content, runId, eventPage);
    appendRunArtifacts(content, runId, artifacts.artifacts);
    details.dataset.loaded = "yes";
  } catch {
    if (token !== accessToken) return;
    content.replaceChildren();
    const error = document.createElement("p");
    error.className = "notice notice--danger";
    error.textContent = "We couldn't load this run's details. Please try again.";
    const retry = document.createElement("button");
    retry.className = "button button--secondary";
    retry.type = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => void loadRunDetails(runId, details, content));
    content.append(error, retry);
  } finally {
    delete details.dataset.loading;
  }
}

function appendRunSummary(container: HTMLElement, detail: DashboardRunDetail): void {
  const publishedUrl = typeof detail.publishedUrl === "string" ? safeHttpUrlForDisplay(detail.publishedUrl) : null;
  const section = document.createElement("section");
  section.className = "run-details__section";
  const heading = document.createElement("h3");
  heading.textContent = "Summary";
  const summary = document.createElement("p");
  summary.className = "run-summary";
  summary.textContent = detail.outcomeSummary || "No outcome summary was reported by the execution host.";
  const facts = createDefinitionList([
    ["Origin", formatRunOrigin(detail.origin)],
    ["Retry of", detail.retryOf || "Not reported"],
    ["Task", formatMachineLabel(detail.taskMode)],
    ["Publishing", formatMachineLabel(detail.publishMode)],
    ["Changed files", detail.changedFileCount === null ? "Not reported" : String(detail.changedFileCount)],
    ["Exit code", detail.exitCode === null ? "Not reported" : String(detail.exitCode)],
    ["Failure class", formatMachineLabel(detail.failureClass)],
    ["Published URL", publishedUrl || "Not reported"],
  ], "data-list run-summary-facts");
  section.append(heading, summary, facts);
  if (publishedUrl) {
    const link = document.createElement("a");
    link.href = publishedUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open published URL";
    section.append(link);
  }
  container.append(section);
}

function formatRunOrigin(origin: DashboardRunSummary["origin"] | null | undefined): string {
  if (!origin?.type || !origin.id) return "Not reported";
  return `${formatMachineLabel(origin.type)} (${origin.id})`;
}

function appendRunEvents(container: HTMLElement, runId: string, page: DashboardRunEventsResponse): void {
  const section = document.createElement("section");
  section.className = "run-details__section event-history";
  const heading = document.createElement("h3");
  heading.textContent = "Activity";
  section.append(heading);
  if (!page.events.length) {
    const empty = document.createElement("p");
    empty.className = "notice notice--empty";
    empty.textContent = "No activity has been recorded for this run yet.";
    section.append(empty);
  } else {
    const list = document.createElement("ol");
    appendRunEventItems(list, page.events);
    section.append(list);
    if (page.hasMore) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button--secondary load-older-events";
      button.dataset.after = String(page.nextAfter);
      button.textContent = "Load older activity";
      button.addEventListener("click", () => void loadOlderRunEvents(runId, list, button));
      section.append(button);
    }
  }
  container.append(section);
}

function appendRunEventItems(list: HTMLOListElement, events: DashboardRunEvent[]): void {
  for (const event of events) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.className = "event-title";
    title.textContent = formatEventLabel(event.type);
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = [event.stage && formatMachineLabel(event.stage), event.step && formatMachineLabel(event.step), formatTimestamp(event.timestamp)].filter(Boolean).join(" · ");
    item.append(title, meta);
    const fields = Object.entries(event.payload);
    if (fields.length) {
      item.append(createDefinitionList(
        fields.map(([key, value]): [string, string] => [formatMachineLabel(key), formatEventPayloadValue(key, value)]),
        "data-list event-payload",
      ));
    }
    list.append(item);
  }
}

async function loadOlderRunEvents(runId: string, list: HTMLOListElement, button: HTMLButtonElement): Promise<void> {
  const token = accessToken;
  if (!token || button.disabled) return;
  button.disabled = true;
  button.textContent = "Loading older activity…";
  try {
    const after = Number(button.dataset.after);
    const page = await apiJson<DashboardRunEventsResponse>(
      `/dashboard/api/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(after)}&limit=100`,
    );
    if (token !== accessToken) return;
    appendRunEventItems(list, page.events);
    button.dataset.after = String(page.nextAfter);
    button.hidden = !page.hasMore;
    button.textContent = "Load older activity";
  } catch {
    if (token === accessToken) {
      button.disabled = false;
      button.textContent = "Try again";
    }
  } finally {
    if (token === accessToken) button.disabled = false;
  }
}

function appendRunArtifacts(container: HTMLElement, runId: string, artifacts: DashboardArtifact[]): void {
  const section = document.createElement("section");
  section.className = "run-details__section";
  const heading = document.createElement("h3");
  heading.textContent = "Files";
  section.append(heading);
  if (!artifacts.length) {
    const empty = document.createElement("p");
    empty.className = "notice notice--empty";
    empty.textContent = "No artifacts are available in Soyuz for this run.";
    section.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "artifacts";
    for (const artifact of artifacts) list.append(createArtifactButton(runId, artifact));
    section.append(list);
  }
  container.append(section);
}

function createArtifactButton(runId: string, artifact: DashboardArtifact): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "button button--secondary artifact-link";
  button.type = "button";
  button.textContent = `Download ${artifact.name} (${formatBytes(artifact.size)})`;
  button.addEventListener("click", () => void downloadArtifact(runId, artifact));
  return button;
}

async function downloadArtifact(runId: string, artifact: DashboardArtifact): Promise<void> {
  const token = accessToken;
  if (!token) return;
  try {
    const response = await fetch(`/dashboard/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) {
      clearSessionWhenUnauthorized(new HttpError("download failed", response.status));
      throw new Error("download failed");
    }
    if (token !== accessToken) return;
    const blob = await response.blob();
    if (token !== accessToken) return;
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = artifact.name;
    link.click();
    URL.revokeObjectURL(objectUrl);
    snackbar.show("File download started.", "success");
  } catch {
    if (token === accessToken) setNotice("We couldn't download that file. It may have expired; please refresh and try again.", "danger");
  }
}

function populateStatusFilter(): void {
  for (const status of RUN_STATUS_OPTIONS) {
    const option = document.createElement("option");
    option.value = status.value;
    option.textContent = status.label;
    statusFilter.append(option);
  }
}

function setDashboardVisible(visible: boolean): void {
  runControls.hidden = !visible;
  runsSection.hidden = !visible;
}

function setNotice(message: string, tone: NoticeTone): void {
  renderNotice(notice, message, tone);
}

async function apiJson<T = unknown>(path: string): Promise<T> {
  try {
    return await fetchJson<T>(path, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  } catch (error) {
    clearSessionWhenUnauthorized(error);
    throw error;
  }
}

function clearSessionWhenUnauthorized(error: unknown): void {
  if (accessToken && error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    clearLocalSession("Your sign-in has expired or access has changed. Sign in again to continue.", "danger");
  }
}

function randomString(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return base64Url(bytes);
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function formatBytes(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.ceil(bytes / 1_000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function startRunRefresh(): void {
  stopRunRefresh();
  runRefreshTimer = setInterval(() => void refreshRunsInBackground(), RUN_REFRESH_INTERVAL_MS);
}

function stopRunRefresh(): void {
  if (runRefreshTimer !== null) clearInterval(runRefreshTimer);
  runRefreshTimer = null;
}

async function refreshRunsInBackground(): Promise<void> {
  if (!accessToken || document.visibilityState !== "visible" || expandedRunIds.size > 0) return;
  await loadRuns({ reset: false, quiet: true, refreshFirstPage: true });
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Dashboard is missing required element ${selector}`);
  return element;
}

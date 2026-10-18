import { fetchJson, HttpError } from "./api.js";
import { revokeAccessToken } from "./auth-api.js";
import { renderAuthUi } from "./auth-ui.js";
import { buildRunListPath, isActiveRunStatus } from "./run-list.js";

interface OAuthRegistration {
  client_id: string;
}

interface OAuthTokenResponse {
  access_token: string;
}

interface DashboardRunSummary {
  status: string;
  runId: string;
  repoUrl: string;
  ref: string;
  createdAt: string;
  stage: string | null;
  operationalHealth: "unknown" | "healthy" | "suspect_stalled";
  lastHeartbeatAt: string | null;
}

interface DashboardRunListResponse {
  runs: DashboardRunSummary[];
  nextCursor: string | null;
}

interface DashboardRunDetail {
  outcomeSummary: string | null;
  taskMode: string;
  publishMode: string;
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
const connectButton = requiredElement<HTMLButtonElement>("#connect");
const accountLabel = requiredElement<HTMLElement>("#account");
const refreshButton = requiredElement<HTMLButtonElement>("#refresh");
const statusFilter = requiredElement<HTMLSelectElement>("#status-filter");
const loadMoreButton = requiredElement<HTMLButtonElement>("#load-more");
const updatedLabel = requiredElement<HTMLElement>("#updated");
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

connectButton.addEventListener("click", () => {
  if (accessToken) void signOut();
  else void connect();
});

renderAuthUi(connectButton, accountLabel, "signed-out");
void finishSignIn();

refreshButton.addEventListener("click", () => void loadRuns({ reset: true }));
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
  notice.textContent = "Starting GitHub sign-in…";
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
    notice.textContent = "Sign-in could not start. Check the service configuration and try again.";
    renderAuthUi(connectButton, accountLabel, "signed-out");
  }
}

async function finishSignIn() {
  const params = new URL(location.href).searchParams;
  const code = params.get("code");
  if (!code) return;
  if (!oauthStateMatches(params)) {
    notice.textContent = "Sign-in could not be verified. Start again.";
    renderAuthUi(connectButton, accountLabel, "signed-out");
    return;
  }

  renderAuthUi(connectButton, accountLabel, "signing-in");
  notice.textContent = "Finishing sign-in…";
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
    clearLocalSession("GitHub sign-in failed. Start again.");
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
  notice.textContent = "Signing out…";

  try {
    if (token && clientId) await revokeAccessToken(token, clientId);
    clearLocalSession("Signed out.");
  } catch {
    clearLocalSession("Signed out on this page. Soyuz could not confirm token revocation; the token expires within one hour.");
  }
}

function clearLocalSession(message: string): void {
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
  renderAuthUi(connectButton, accountLabel, "signed-out");
  notice.textContent = message;
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
  if (!options.quiet && options.reset) notice.textContent = "Loading recent runs…";
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
    updatedLabel.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    if (!runsById.size) {
      notice.textContent = statusFilter.value ? "No runs match this status." : "No runs have been recorded yet.";
    } else {
      notice.textContent = `${runsById.size} ${runsById.size === 1 ? "run" : "runs"} shown`;
    }
  } catch {
    if (token === accessToken) {
      if (!options.quiet) notice.textContent = "Recent runs could not be loaded. Try again shortly.";
    }
  } finally {
    if (token === accessToken) {
      isLoadingRuns = false;
      loadMoreButton.disabled = !nextCursor;
      if (pendingRunReset) {
        pendingRunReset = false;
        void loadRuns({ reset: true });
      }
    }
  }
}

function renderRuns(): void {
  const runs = [...runsById.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  runsSection.replaceChildren(...runs.map(renderRun));
}

function renderRun(run: DashboardRunSummary): HTMLElement {
  const card = document.createElement("article");
  card.className = "run";
  const heading = document.createElement("h2");
  heading.textContent = `${run.status} · ${run.runId}`;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${run.repoUrl} · ${run.ref} · ${new Date(run.createdAt).toLocaleString()}`;
  const status = document.createElement("p");
  status.className = isActiveRunStatus(run.status) ? "badge status-active" : "badge";
  status.textContent = `Status: ${run.status}`;
  const stage = document.createElement("p");
  stage.className = "meta";
  stage.textContent = `Stage: ${run.stage || "not reported"}`;
  const health = document.createElement("p");
  health.className = run.operationalHealth === "suspect_stalled" ? "badge health-warning" : "badge";
  health.textContent = run.operationalHealth === "suspect_stalled"
    ? `Heartbeat overdue · last seen ${formatTimestamp(run.lastHeartbeatAt)}`
    : run.lastHeartbeatAt
      ? `Last heartbeat ${formatTimestamp(run.lastHeartbeatAt)}`
      : "Heartbeat not reported";
  card.append(heading, meta, status, stage, health);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Run history, details and artifacts";
  const content = document.createElement("div");
  content.className = "details-content";
  details.append(summary, content);
  details.addEventListener("toggle", () => {
    if (details.open) {
      expandedRunIds.add(run.runId);
      if (details.dataset.loaded !== "yes" && details.dataset.loading !== "yes") {
        void loadRunDetails(run.runId, details, content);
      }
    } else {
      expandedRunIds.delete(run.runId);
    }
  });
  if (expandedRunIds.has(run.runId)) details.open = true;
  card.append(details);
  return card;
}

async function loadRunDetails(runId: string, details: HTMLDetailsElement, content: HTMLElement): Promise<void> {
  const token = accessToken;
  if (!token || details.dataset.loading === "yes") return;
  details.dataset.loading = "yes";
  content.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "meta";
  loading.textContent = "Loading run history…";
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
    error.textContent = "Run details could not be loaded.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Try loading again";
    retry.addEventListener("click", () => void loadRunDetails(runId, details, content));
    content.append(error, retry);
  } finally {
    delete details.dataset.loading;
  }
}

function appendRunSummary(container: HTMLElement, detail: DashboardRunDetail): void {
  const summary = document.createElement("p");
  summary.textContent = detail.outcomeSummary || `Task mode: ${detail.taskMode}; publish mode: ${detail.publishMode}.`;
  container.append(summary);
}

function appendRunEvents(container: HTMLElement, runId: string, page: DashboardRunEventsResponse): void {
  const section = document.createElement("section");
  section.className = "event-history";
  const heading = document.createElement("h3");
  heading.textContent = "Run history";
  section.append(heading);
  if (!page.events.length) {
    const empty = document.createElement("p");
    empty.className = "meta";
    empty.textContent = "No recorded events.";
    section.append(empty);
  } else {
    const list = document.createElement("ol");
    appendRunEventItems(list, page.events);
    section.append(list);
    if (page.hasMore) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "load-older-events";
      button.dataset.after = String(page.nextAfter);
      button.textContent = "Load older events";
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
    title.textContent = event.type;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = [event.stage, event.step, formatTimestamp(event.timestamp)].filter(Boolean).join(" · ");
    item.append(title, meta);
    const fields = Object.entries(event.payload);
    if (fields.length) {
      const payload = document.createElement("p");
      payload.textContent = fields.map(([key, value]) => `${key}: ${value}`).join(" · ");
      item.append(payload);
    }
    list.append(item);
  }
}

async function loadOlderRunEvents(runId: string, list: HTMLOListElement, button: HTMLButtonElement): Promise<void> {
  const token = accessToken;
  if (!token || button.disabled) return;
  button.disabled = true;
  button.textContent = "Loading older events…";
  try {
    const after = Number(button.dataset.after);
    const page = await apiJson<DashboardRunEventsResponse>(
      `/dashboard/api/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(after)}&limit=100`,
    );
    if (token !== accessToken) return;
    appendRunEventItems(list, page.events);
    button.dataset.after = String(page.nextAfter);
    button.hidden = !page.hasMore;
    button.textContent = "Load older events";
  } catch {
    if (token === accessToken) {
      button.disabled = false;
      button.textContent = "Retry loading older events";
    }
  } finally {
    if (token === accessToken) button.disabled = false;
  }
}

function appendRunArtifacts(container: HTMLElement, runId: string, artifacts: DashboardArtifact[]): void {
  if (!artifacts.length) {
    const empty = document.createElement("p");
    empty.className = "meta";
    empty.textContent = "No retained artifacts.";
    container.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "artifacts";
  for (const artifact of artifacts) list.append(createArtifactButton(runId, artifact));
  container.append(list);
}

function createArtifactButton(runId: string, artifact: DashboardArtifact): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "artifact-link";
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
  } catch {
    if (token === accessToken) notice.textContent = "Artifact download failed. It may have expired.";
  }
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
    clearLocalSession("Your Soyuz sign-in expired or access was removed. Sign in again.");
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

function formatTimestamp(value: string | null): string {
  if (!value) return "unknown";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "unknown" : timestamp.toLocaleString();
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

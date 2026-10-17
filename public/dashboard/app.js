import { fetchJson } from "./api.js";
import { revokeAccessToken } from "./auth-api.js";
import { renderAuthUi } from "./auth-ui.js";

const notice = document.querySelector("#notice");
const runsSection = document.querySelector("#runs");
const connectButton = document.querySelector("#connect");
const accountLabel = document.querySelector("#account");
const oauthKeys = ["state", "verifier", "clientId", "redirectUri"];
let accessToken = null;
let oauthClientId = null;

connectButton.addEventListener("click", () => {
  if (accessToken) void signOut();
  else void connect();
});

renderAuthUi(connectButton, accountLabel, "signed-out");
void finishSignIn();

async function connect() {
  renderAuthUi(connectButton, accountLabel, "signing-in");
  notice.textContent = "Starting GitHub sign-in…";
  try {
    const redirectUri = `${location.origin}/dashboard/`;
    const registration = await fetchJson("/oauth/register", {
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
    const identity = await apiJson("/dashboard/api/me");
    if (typeof identity.githubLogin !== "string") throw new Error("OAuth identity response was invalid");
    clearOAuthState();
    history.replaceState(null, "", "/dashboard/");
    renderAuthUi(connectButton, accountLabel, "signed-in", identity.githubLogin);
    try {
      await loadRuns();
    } catch {
      if (accessToken) notice.textContent = "You are signed in, but recent runs could not be loaded. Try again shortly.";
    }
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
  runsSection.replaceChildren();
  notice.textContent = "Signing out…";

  try {
    if (token && clientId) await revokeAccessToken(token, clientId);
    clearLocalSession("Signed out.");
  } catch {
    clearLocalSession("Signed out on this page. Soyuz could not confirm token revocation; the token expires within one hour.");
  }
}

function clearLocalSession(message) {
  accessToken = null;
  oauthClientId = null;
  runsSection.replaceChildren();
  renderAuthUi(connectButton, accountLabel, "signed-out");
  notice.textContent = message;
}

function oauthStateMatches(params) {
  const state = params.get("state");
  return Boolean(state && state === sessionStorage.getItem("soyuz.dashboard.state"));
}

async function exchangeAuthorizationCode(code) {
  return fetchJson("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: sessionStorage.getItem("soyuz.dashboard.clientId"),
        redirect_uri: sessionStorage.getItem("soyuz.dashboard.redirectUri"),
        code_verifier: sessionStorage.getItem("soyuz.dashboard.verifier"),
        resource: `${location.origin}/`,
      }),
    });
}

function clearOAuthState() {
  for (const key of oauthKeys) sessionStorage.removeItem(`soyuz.dashboard.${key}`);
}

async function loadRuns() {
  const token = accessToken;
  notice.textContent = "Loading recent runs…";
  runsSection.replaceChildren();
  const result = await apiJson("/dashboard/api/runs?limit=50");
  if (!token || token !== accessToken) return;
  if (!result.runs.length) {
    notice.textContent = "No runs have been recorded yet.";
    return;
  }
  notice.textContent = `${result.runs.length} recent runs`;
  for (const run of result.runs) runsSection.append(renderRun(run));
}

function renderRun(run) {
  const card = document.createElement("article");
  card.className = "run";
  const heading = document.createElement("h2");
  heading.textContent = `${run.status} · ${run.runId}`;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${run.repoUrl} · ${run.ref} · ${new Date(run.createdAt).toLocaleString()}`;
  card.append(heading, meta);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Details and artifacts";
  details.append(summary);
  details.addEventListener("toggle", () => {
    if (details.open && details.dataset.loaded !== "yes") {
      details.dataset.loaded = "yes";
      void loadRunDetails(run.runId, details);
    }
  });
  card.append(details);
  return card;
}

async function loadRunDetails(runId, container) {
  const token = accessToken;
  if (!token) return;
  try {
    const [detail, artifacts] = await Promise.all([
      apiJson(`/dashboard/api/runs/${encodeURIComponent(runId)}`),
      apiJson(`/dashboard/api/runs/${encodeURIComponent(runId)}/artifacts`),
    ]);
    if (token !== accessToken) return;
    appendRunSummary(container, detail);
    appendRunArtifacts(container, runId, artifacts.artifacts);
  } catch {
    const error = document.createElement("p");
    error.textContent = "Run details could not be loaded.";
    container.append(error);
  }
}

function appendRunSummary(container, detail) {
  const summary = document.createElement("p");
  summary.textContent = detail.outcomeSummary || `Task mode: ${detail.taskMode}; publish mode: ${detail.publishMode}.`;
  container.append(summary);
}

function appendRunArtifacts(container, runId, artifacts) {
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

function createArtifactButton(runId, artifact) {
  const button = document.createElement("button");
  button.className = "artifact-link";
  button.type = "button";
  button.textContent = `Download ${artifact.name} (${formatBytes(artifact.size)})`;
  button.addEventListener("click", () => void downloadArtifact(runId, artifact));
  return button;
}

async function downloadArtifact(runId, artifact) {
  const token = accessToken;
  if (!token) return;
  try {
    const response = await fetch(`/dashboard/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) {
      clearSessionWhenUnauthorized({ status: response.status });
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

async function apiJson(path) {
  try {
    return await fetchJson(path, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  } catch (error) {
    clearSessionWhenUnauthorized(error);
    throw error;
  }
}

function clearSessionWhenUnauthorized(error) {
  if (accessToken && (error?.status === 401 || error?.status === 403)) {
    clearLocalSession("Your Soyuz sign-in expired or access was removed. Sign in again.");
  }
}

function randomString(byteCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return base64Url(bytes);
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function formatBytes(bytes) {
  return bytes < 1_000_000 ? `${Math.ceil(bytes / 1_000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

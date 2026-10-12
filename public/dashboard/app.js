const notice = document.querySelector("#notice");
const runsSection = document.querySelector("#runs");
const connectButton = document.querySelector("#connect");
const oauthKeys = ["state", "verifier", "clientId", "redirectUri"];
let accessToken = null;

connectButton.addEventListener("click", () => {
  void connect();
});

void finishSignIn();

async function connect() {
  connectButton.disabled = true;
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
    connectButton.disabled = false;
  }
}

async function finishSignIn() {
  const params = new URL(location.href).searchParams;
  const code = params.get("code");
  if (!code) return;
  const state = params.get("state");
  if (!state || state !== sessionStorage.getItem("soyuz.dashboard.state")) {
    notice.textContent = "Sign-in could not be verified. Start again.";
    return;
  }

  notice.textContent = "Finishing sign-in…";
  try {
    const token = await fetchJson("/oauth/token", {
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
    accessToken = token.access_token;
    for (const key of oauthKeys) sessionStorage.removeItem(`soyuz.dashboard.${key}`);
    history.replaceState(null, "", "/dashboard/");
    await loadRuns();
  } catch {
    notice.textContent = "GitHub sign-in failed. Start again.";
    for (const key of oauthKeys) sessionStorage.removeItem(`soyuz.dashboard.${key}`);
  }
}

async function loadRuns() {
  notice.textContent = "Loading recent runs…";
  runsSection.replaceChildren();
  const result = await apiJson("/dashboard/api/runs?limit=50");
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
  try {
    const [detail, artifacts] = await Promise.all([
      apiJson(`/dashboard/api/runs/${encodeURIComponent(runId)}`),
      apiJson(`/dashboard/api/runs/${encodeURIComponent(runId)}/artifacts`),
    ]);
    const summary = document.createElement("p");
    summary.textContent = detail.outcomeSummary || `Task mode: ${detail.taskMode}; publish mode: ${detail.publishMode}.`;
    container.append(summary);
    if (artifacts.artifacts.length) {
      const list = document.createElement("div");
      list.className = "artifacts";
      for (const artifact of artifacts.artifacts) {
        const button = document.createElement("button");
        button.className = "artifact-link";
        button.type = "button";
        button.textContent = `Download ${artifact.name} (${formatBytes(artifact.size)})`;
        button.addEventListener("click", () => void downloadArtifact(runId, artifact));
        list.append(button);
      }
      container.append(list);
    } else {
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "No retained artifacts.";
      container.append(empty);
    }
  } catch {
    const error = document.createElement("p");
    error.textContent = "Run details could not be loaded.";
    container.append(error);
  }
}

async function downloadArtifact(runId, artifact) {
  try {
    const response = await fetch(`/dashboard/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("download failed");
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = artifact.name;
    link.click();
    URL.revokeObjectURL(objectUrl);
  } catch {
    notice.textContent = "Artifact download failed. It may have expired.";
  }
}

async function apiJson(path) {
  return fetchJson(path, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
}

async function fetchJson(path, init = {}) {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error("request failed");
  return body.data ?? body;
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

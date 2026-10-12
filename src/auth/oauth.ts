import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  authorizationErrorRedirect,
  insufficientScope,
  type ConsentDescription,
  type OAuthHelpers,
  type OAuthProviderOptions,
  type OAuthResourceAuth,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { listRunsPage, readRun, readRunEventsPage, RunApplicationError } from "../application/runs";
import { parseEventPayload, parseResult, type RunEventRow, type RunRow } from "../db/runs";
import type { Env } from "../env";
import { isUuid } from "../lib/uuid";
import { handleClientArtifacts } from "../api/artifacts";
import { errorResponse, requestIdFor, successResponse } from "../api/http";
import { createSoyuzMcpHandler } from "../mcp/server";

export const SOYUZ_READ_SCOPE = "soyuz:read";
export const SOYUZ_WRITE_SCOPE = "soyuz:write";
const API_PREFIX = "/dashboard/api";
const MAX_MCP_AUTH_INSPECTION_BYTES = 1_000_000;
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

interface OAuthProps {
  githubUserId: string;
  githubLogin: string;
}

interface GitHubUser {
  id: number;
  login: string;
}

const providers = new Map<string, OAuthProvider<Env>>();

export function canonicalPublicOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function allowedGithubUserIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  const entries = raw.split(",").map((value) => value.trim());
  if (entries.length === 0 || entries.some((value) => !/^\d{1,20}$/.test(value))) return new Set();
  return new Set(entries);
}

export function isAllowedGithubUser(userId: unknown, rawAllowlist: string | undefined): boolean {
  if (typeof userId !== "string" && (typeof userId !== "number" || !Number.isSafeInteger(userId))) return false;
  return allowedGithubUserIds(rawAllowlist).has(String(userId));
}

export function isOAuthConfigured(env: Env): boolean {
  return Boolean(
    canonicalPublicOrigin(env.SOYUZ_PUBLIC_URL) &&
    env.GITHUB_OAUTH_CLIENT_ID?.trim() &&
    env.GITHUB_OAUTH_CLIENT_SECRET?.trim() &&
    env.OAUTH_KV,
  );
}

export function getSoyuzOAuthProvider(env: Env): OAuthProvider<Env> | null {
  const origin = canonicalPublicOrigin(env.SOYUZ_PUBLIC_URL);
  if (!origin || !env.GITHUB_OAUTH_CLIENT_ID?.trim() || !env.GITHUB_OAUTH_CLIENT_SECRET?.trim() || !env.OAUTH_KV) return null;
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>(oauthProviderOptions(origin));
    providers.set(origin, provider);
  }
  return provider;
}

export function oauthProviderOptions(origin: string): OAuthProviderOptions<Env> {
  const resource = `${origin}/`;
  return {
    apiHandlers: {
      "/mcp": { fetch: handleOAuthMcpRequest },
      "/dashboard/api/": { fetch: handleDashboardApiRequest },
    },
    defaultHandler: { fetch: handleOAuthPageRequest },
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [SOYUZ_READ_SCOPE, SOYUZ_WRITE_SCOPE, "offline_access"],
    requiredScopes: [SOYUZ_READ_SCOPE],
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      resource_name: "Soyuz",
    },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * 24 * 60 * 60,
  };
}

export async function requestNeedsWriteScope(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_MCP_AUTH_INSPECTION_BYTES) return true;
  try {
    const body = request.clone().body;
    if (!body) return false;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_MCP_AUTH_INSPECTION_BYTES) {
        await reader.cancel();
        return true;
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const message: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return containsWriteCall(message);
  } catch {
    return false;
  }
}

function containsWriteCall(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsWriteCall);
  if (!value || typeof value !== "object") return false;
  const message = value as { method?: unknown; params?: unknown };
  if (message.method !== "tools/call" || !message.params || typeof message.params !== "object") return false;
  const name = (message.params as { name?: unknown }).name;
  return name === "create_run" || name === "cancel_run";
}

export function renderConsentPage(details: ConsentDescription, handle: string): string {
  const clientName = escapeHtml(details.clientName);
  const domain = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const scopes = details.scope.map((scope) =>
    `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`,
  ).join("<br>");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${clientName}</title></head>
<body><main><h1>Allow ${clientName} to access Soyuz?</h1>
<p>${domain} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>GitHub will only be asked to confirm your account identity with the read:user permission.</p>
<form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">${scopes}<p>
<button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p></form></main></body></html>`;
}

async function handleOAuthMcpRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  if (!hasOAuthContext(context)) return errorResponse("oauth", 401, "UNAUTHORIZED", "OAuth token context is unavailable.");
  const rejected = authorizeOAuthUser(context.props, context.auth.scope, env, context.auth);
  if (rejected) return rejected;
  if (await requestNeedsWriteScope(request) && !context.auth.scope.includes(SOYUZ_WRITE_SCOPE)) {
    return insufficientScope(context.auth, [SOYUZ_READ_SCOPE, SOYUZ_WRITE_SCOPE]);
  }
  return createSoyuzMcpHandler(env).fetch(request);
}

async function handleDashboardApiRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  if (!hasOAuthContext(context)) return errorResponse("oauth", 401, "UNAUTHORIZED", "OAuth token context is unavailable.");
  const rejected = authorizeOAuthUser(context.props, context.auth.scope, env, context.auth);
  if (rejected) return rejected;
  if (request.method !== "GET") return errorResponse(requestIdFor(request), 405, "METHOD_NOT_ALLOWED", "The dashboard is read-only.");

  const url = new URL(request.url);
  const path = url.pathname.slice(API_PREFIX.length) || "/";
  const segments = path.split("/").filter(Boolean);
  const requestId = requestIdFor(request);
  if (segments.length === 1 && segments[0] === "runs") {
    try {
      const page = await listRunsPage(env, {
        limit: url.searchParams.get("limit") ?? 50,
        status: url.searchParams.get("status"),
        cursor: url.searchParams.get("cursor"),
      });
      return successResponse(requestId, { runs: page.rows.map(dashboardRunSummary), nextCursor: page.nextCursor });
    } catch (error) {
      return dashboardErrorResponse(error, requestId);
    }
  }
  if (segments.length < 2 || segments[0] !== "runs" || !isUuid(segments[1])) {
    return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }

  const runId = segments[1];
  if (segments.length === 2) {
    try {
      return successResponse(requestId, dashboardRunDetail(await readRun(env, runId)));
    } catch (error) {
      return dashboardErrorResponse(error, requestId);
    }
  }
  if (segments.length === 3 && segments[2] === "events") {
    try {
      const page = await readRunEventsPage(env, runId, {
        after: url.searchParams.get("after"),
        limit: url.searchParams.get("limit") ?? 100,
      });
      return successResponse(requestId, {
        events: page.events.map(dashboardEvent),
        nextAfter: page.nextAfter,
      });
    } catch (error) {
      return dashboardErrorResponse(error, requestId);
    }
  }
  if ((segments.length === 3 || segments.length === 4) && segments[2] === "artifacts") {
    const artifactPath = `/v1/runs/${runId}/artifacts${segments[3] ? `/${encodeURIComponent(segments[3])}` : ""}`;
    return await handleClientArtifacts(request, env, new URL(`${artifactPath}${url.search}`, url.origin), requestId)
      ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }
  return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

function authorizeOAuthUser(
  props: OAuthProps,
  scopes: string[],
  env: Env,
  auth: OAuthResourceContext<OAuthProps>["auth"],
): Response | null {
  if (!isAllowedGithubUser(props?.githubUserId, env.SOYUZ_OAUTH_ALLOWED_GITHUB_IDS)) {
    return errorResponse("oauth", 403, "ACCESS_DENIED", "This GitHub account is not allowed to access Soyuz.");
  }
  if (!scopes.includes(SOYUZ_READ_SCOPE)) return insufficientScope(auth, [SOYUZ_READ_SCOPE]);
  return null;
}

function hasOAuthContext(context: ExecutionContext): context is OAuthResourceContext<OAuthProps> {
  const candidate = context as ExecutionContext & { auth?: unknown; props?: unknown };
  if (!candidate.props || typeof candidate.props !== "object" || !candidate.auth || typeof candidate.auth !== "object") return false;
  const props = candidate.props as { githubUserId?: unknown; githubLogin?: unknown };
  const auth = candidate.auth as Partial<OAuthResourceAuth>;
  return typeof props.githubUserId === "string" && typeof props.githubLogin === "string"
    && typeof auth.token === "string" && typeof auth.audience === "string"
    && Array.isArray(auth.scope) && auth.scope.every((scope) => typeof scope === "string");
}

async function handleOAuthPageRequest(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
  const helpers = env.OAUTH_PROVIDER;
  if (!helpers) return plainOAuthError(503, "OAuth storage is not available.");
  const path = new URL(request.url).pathname;
  if (path === "/oauth/authorize") return handleAuthorizationPage(request, env, helpers);
  if (path === "/oauth/callback") return handleGithubCallback(request, env, helpers);
  return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
}

async function handleAuthorizationPage(request: Request, env: Env, helpers: OAuthHelpers): Promise<Response> {
  try {
    if (request.method === "GET") {
      const authRequest = await helpers.parseAuthRequest(request);
      const details = await helpers.describeConsent(authRequest);
      const transaction = await helpers.beginConsent(authRequest);
      const headers = new Headers(transaction.headers);
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("cache-control", "no-store");
      headers.set("content-security-policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      headers.set("referrer-policy", "no-referrer");
      headers.set("x-content-type-options", "nosniff");
      return new Response(renderConsentPage(details, transaction.handle), { headers });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await helpers.denyConsent(request, handle);
      denied.headers.set("cache-control", "no-store");
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await helpers.approveConsent(request, handle, {
      scope: form.getAll("scope").map(String),
    });
    const verifier = randomVerifier();
    const transaction = await helpers.beginUpstream(approved.request, {
      data: { verifier },
      headers: approved.headers,
    });
    const origin = canonicalPublicOrigin(env.SOYUZ_PUBLIC_URL);
    if (!origin) return plainOAuthError(503, "OAuth is not configured.");
    const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID ?? "");
    authorizeUrl.searchParams.set("redirect_uri", `${origin}/oauth/callback`);
    authorizeUrl.searchParams.set("scope", "read:user");
    authorizeUrl.searchParams.set("state", transaction.state);
    authorizeUrl.searchParams.set("code_challenge", await codeChallenge(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("allow_signup", "false");
    transaction.headers.set("location", authorizeUrl.toString());
    transaction.headers.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers: transaction.headers });
  } catch (error) {
    return authorizationErrorResponse(error);
  }
}

async function handleGithubCallback(request: Request, env: Env, helpers: OAuthHelpers): Promise<Response> {
  try {
    const resumed = await helpers.finishUpstream<{ verifier: string }>(request);
    const callback = new URL(request.url);
    if (callback.searchParams.has("error")) return upstreamErrorRedirect(resumed, "GitHub sign-in was denied.");
    const code = callback.searchParams.get("code");
    if (!code || code.length > 2_048) return upstreamErrorRedirect(resumed, "GitHub did not return an authorization code.");

    const origin = canonicalPublicOrigin(env.SOYUZ_PUBLIC_URL);
    if (!origin || !env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
      return plainOAuthError(503, "OAuth is not configured.");
    }
    const user = await fetchGithubUser(code, resumed.data.verifier, env, origin);
    if (!isAllowedGithubUser(user.id, env.SOYUZ_OAUTH_ALLOWED_GITHUB_IDS)) {
      return upstreamErrorRedirect(resumed, "This GitHub account is not allowed to access Soyuz.");
    }
    const { redirectTo } = await helpers.completeAuthorization({
      request: resumed.request,
      userId: `github-${user.id}`,
      metadata: { githubLogin: user.login },
      props: { githubUserId: String(user.id), githubLogin: user.login } satisfies OAuthProps,
      scope: resumed.request.scope,
    });
    resumed.headers.set("location", redirectTo);
    resumed.headers.set("cache-control", "no-store");
    resumed.headers.set("referrer-policy", "no-referrer");
    return new Response(null, { status: 302, headers: resumed.headers });
  } catch (error) {
    return authorizationErrorResponse(error);
  }
}

async function fetchGithubUser(code: string, verifier: string, env: Env, origin: string): Promise<GitHubUser> {
  const tokenBody = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID ?? "",
    client_secret: env.GITHUB_OAUTH_CLIENT_SECRET ?? "",
    code,
    redirect_uri: `${origin}/oauth/callback`,
    code_verifier: verifier,
  });
  const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  if (!tokenResponse.ok) throw new Error("GITHUB_TOKEN_EXCHANGE_FAILED");
  const token = await tokenResponse.json() as { access_token?: unknown; error?: unknown };
  if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 8_192) {
    throw new Error("GITHUB_TOKEN_MISSING");
  }
  const userResponse = await fetch(GITHUB_USER_URL, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token.access_token}`,
      "user-agent": "Soyuz",
    },
  });
  if (!userResponse.ok) throw new Error("GITHUB_IDENTITY_LOOKUP_FAILED");
  const value = await userResponse.json() as Partial<GitHubUser>;
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id < 1 || typeof value.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(value.login)) {
    throw new Error("GITHUB_IDENTITY_INVALID");
  }
  return { id: value.id, login: value.login };
}

function upstreamErrorRedirect(resumed: { request: Parameters<OAuthHelpers["completeAuthorization"]>[0]["request"]; headers: Headers }, description: string): Response {
  resumed.headers.set("location", authorizationErrorRedirect(resumed.request, "access_denied", description));
  resumed.headers.set("cache-control", "no-store");
  resumed.headers.set("referrer-policy", "no-referrer");
  return new Response(null, { status: 302, headers: resumed.headers });
}

function authorizationErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return new Response(null, { status: 302, headers: { location: error.redirectTo, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) return plainOAuthError(400, "The authorization request could not be verified. Start again from your MCP client.");
  return plainOAuthError(502, "GitHub sign-in could not be completed. Retry shortly.");
}

function plainOAuthError(status: number, message: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Soyuz sign-in</title><p>${escapeHtml(message)}</p>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&#34;",
    "'": "&#39;",
  })[character] ?? character);
}

function dashboardRunSummary(row: RunRow): Record<string, unknown> {
  return {
    runId: row.id,
    status: row.status,
    repoUrl: safeDisplayUrl(row.repo_url),
    ref: row.git_ref,
    taskMode: row.task_mode,
    publishMode: row.publish_mode,
    stage: row.stage,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function dashboardRunDetail(row: RunRow): Record<string, unknown> {
  const result = parseResult(row);
  const publishedUrl = typeof result?.publishedUrl === "string" ? safeDisplayUrl(result.publishedUrl) : null;
  return {
    ...dashboardRunSummary(row),
    updatedAt: row.updated_at,
    outcomeSummary: typeof result?.summary === "string" ? result.summary.slice(0, 2_000) : null,
    publishedUrl,
    changedFileCount: typeof result?.changedFileCount === "number" ? result.changedFileCount : null,
    failureClass: row.failure_class,
    cancellation: {
      state: row.status === "cancel_requested" ? "requested" : row.status === "cancelled" ? "cancelled" : "none",
      requestedAt: row.cancel_requested_at,
    },
  };
}

const DASHBOARD_EVENT_KEYS = new Set([
  "source", "status", "percent", "progressPercent", "current", "total", "completed", "passed", "failed", "exitCode", "durationMs", "changedFileCount", "failureClass",
]);

function dashboardEvent(row: RunEventRow): Record<string, unknown> {
  const payload: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parseEventPayload(row))) {
    if (!DASHBOARD_EVENT_KEYS.has(key)) continue;
    if (typeof value === "string" && value.length <= 160) payload[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) payload[key] = value;
    else if (typeof value === "boolean") payload[key] = value;
  }
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    type: row.type,
    stage: row.stage,
    step: row.step,
    timestamp: row.occurred_at,
    payload,
  };
}

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "about:invalid";
  }
}

function dashboardErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof RunApplicationError) {
    return errorResponse(requestId, error.status, error.code, error.publicMessage, { details: error.details });
  }
  return errorResponse(requestId, 503, "RUN_OPERATION_UNAVAILABLE", "Soyuz could not read run history. Retry shortly.");
}

import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  authorizationErrorRedirect,
  type ConsentDescription,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { requestIdFor } from "../api/http";
import { sha256Hex } from "../lib/sha256";
import {
  isAllowedGithubUser,
  SOYUZ_READ_SCOPE,
  SOYUZ_WRITE_SCOPE,
  type OAuthProps,
} from "./oauth-policy";
import { handleDashboardApiRequest, handleOAuthMcpRequest } from "./oauth-resource";

export { allowedGithubUserIds, isAllowedGithubUser } from "./oauth-policy";
export { requestNeedsWriteScope } from "./oauth-resource";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const OAUTH_COOKIE_PREFIX = "__Host-oauth-";
const OAUTH_ERROR_CODES = new Set([
  "invalid_client", "invalid_request", "unauthorized_client", "access_denied",
  "unsupported_response_type", "invalid_scope", "server_error", "temporarily_unavailable",
  "invalid_grant", "unsupported_grant_type", "invalid_token", "insufficient_scope",
]);
const AUTHORIZATION_ERROR_CODES = new Set([
  "invalid_request", "invalid_target", "unauthorized_client", "access_denied",
  "unsupported_response_type", "invalid_scope", "server_error", "temporarily_unavailable",
]);
const GITHUB_FAILURE_CODES = new Set([
  "GITHUB_TOKEN_EXCHANGE_FAILED", "GITHUB_TOKEN_MISSING",
  "GITHUB_IDENTITY_LOOKUP_FAILED", "GITHUB_IDENTITY_INVALID",
]);
const AUTHORIZATION_FAILURE_REASONS = new Map([
  ["Missing transaction handle", "consent_handle_missing"],
  ["This authorization was not started in this browser; start again", "consent_binding_cookie_missing"],
  ["This authorization belongs to a different browser session; start again", "consent_binding_mismatch"],
  ["This authorization expired or was already used; start again", "consent_transaction_expired"],
  ["Approved scopes must be ones this server supports", "consent_scope_invalid"],
]);

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
    onError: ({ code, status, headers, internal, request }) => {
      const requestId = request ? requestIdFor(request) : crypto.randomUUID();
      headers["x-request-id"] = requestId;
      console.warn(JSON.stringify({
        event: "soyuz.oauth.provider_error",
        requestId,
        category: safeSlug(internal.category, /^[a-z][a-z0-9-]{0,63}$/),
        reason: safeSlug(internal.reason, /^[a-z][a-z0-9_]{0,63}$/),
        oauthCode: OAUTH_ERROR_CODES.has(code) ? code : "other",
        status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 0,
      }));
    },
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    cookiePrefix: OAUTH_COOKIE_PREFIX,
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

export function renderConsentPage(details: ConsentDescription, handle: string): string {
  const clientName = escapeHtml(details.clientName);
  const domain = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app provided its own name. Check that you trust it before continuing.";
  const scopes = details.scope.map((scope) =>
    `<label class="consent-scope"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked><span>${escapeHtml(consentScopeLabel(scope))}</span></label>`,
  ).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${clientName}</title><link rel="stylesheet" href="/dashboard/style.css"></head>
<body><main class="consent-main"><section class="consent-card" aria-labelledby="consent-title">
<p class="eyebrow">Soyuz · Run Dashboard</p><h1 id="consent-title">Allow ${clientName} to access Soyuz?</h1>
<p>${domain} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p class=\"notice notice--warning consent-warning\"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p class="consent-provider">GitHub will confirm your account using its read:user permission.</p>
<form method="post" class="consent-form"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><fieldset class="consent-scopes"><legend>Soyuz permissions</legend>${scopes}</fieldset>
<div class="consent-actions"><button class="button button--primary consent-allow" name="decision" value="approve">Allow</button><button class="button button--secondary consent-deny" name="decision" value="deny">Deny</button></div></form>
</section></main></body></html>`;
}

function consentScopeLabel(scope: string): string {
  switch (scope) {
    case SOYUZ_READ_SCOPE:
      return "View run status, history, and files";
    case SOYUZ_WRITE_SCOPE:
      return "Create and manage runs";
    case "offline_access":
      return "Stay signed in";
    default:
      return scope;
  }
}

async function handleOAuthPageRequest(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
  const helpers = env.OAUTH_PROVIDER;
  if (!helpers) return oauthConfigurationErrorResponse(request, "provider_context", "oauth_provider_unavailable", "OAuth storage is not available.");
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
      headers.set("content-security-policy", "default-src 'none'; style-src 'self'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'");
      headers.set("referrer-policy", "no-referrer");
      headers.set("x-content-type-options", "nosniff");
      return new Response(renderConsentPage(details, transaction.handle), { headers });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    const consentRequest = await bindConsentToSameOriginRequest(request, handle, env);
    if (form.get("decision") !== "approve") {
      const denied = await helpers.denyConsent(consentRequest, handle);
      denied.headers.set("cache-control", "no-store");
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await helpers.approveConsent(consentRequest, handle, {
      scope: form.getAll("scope").map(String),
    });
    const verifier = randomVerifier();
    const transaction = await helpers.beginUpstream(approved.request, {
      data: { verifier },
      headers: approved.headers,
    });
    const origin = canonicalPublicOrigin(env.SOYUZ_PUBLIC_URL);
    if (!origin) return oauthConfigurationErrorResponse(request, "authorize", "public_origin_invalid", "OAuth is not configured.");
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
    const requestId = requestIdFor(request);
    transaction.headers.set("x-request-id", requestId);
    console.info(JSON.stringify({
      event: "soyuz.oauth.upstream_redirect",
      requestId,
      destination: authorizeUrl.origin,
    }));
    return new Response(null, { status: 302, headers: transaction.headers });
  } catch (error) {
    return authorizationErrorResponse(error, request, "authorize");
  }
}

export async function bindConsentToSameOriginRequest(
  request: Request,
  handle: string,
  env: Pick<Env, "SOYUZ_PUBLIC_URL">,
): Promise<Request> {
  if (!handle) return request;
  const handleHash = await sha256Hex(handle);
  const cookieName = `${OAUTH_COOKIE_PREFIX}consent-${handleHash.slice(0, 16)}`;
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (cookieHeader.split(";").some((part) => {
    const separator = part.indexOf("=");
    const name = separator === -1 ? part : part.slice(0, separator);
    return name.trim() === cookieName;
  })) return request;

  const origin = canonicalPublicOrigin(env.SOYUZ_PUBLIC_URL);
  const requestOrigin = new URL(request.url).origin;
  const originHeader = request.headers.get("origin");
  const sameOriginForm = origin !== null
    && requestOrigin === origin
    && request.headers.get("sec-fetch-site") === "same-origin"
    && (originHeader === origin || originHeader === "null");
  if (!sameOriginForm) return request;

  // Some browser shells omit the provider's Lax binding cookie on their own same-origin form POST.
  // Fetch Metadata plus the one-use, KV-backed handle preserves CSRF protection in that case.
  const headers = new Headers(request.headers);
  headers.set("cookie", cookieHeader ? `${cookieHeader}; ${cookieName}=${handleHash}` : `${cookieName}=${handleHash}`);
  return new Request(request.url, { method: request.method, headers });
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
      return oauthConfigurationErrorResponse(request, "github_callback", "oauth_configuration_missing", "OAuth is not configured.");
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
    return authorizationErrorResponse(error, request, "github_callback");
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

export function authorizationErrorResponse(error: unknown, request: Request, stage: string): Response {
  const requestId = requestIdFor(request);
  const diagnostic = oauthFailureDiagnostic(error);
  console.error(JSON.stringify({
    event: "soyuz.oauth.failure",
    requestId,
    stage: safeSlug(stage, /^[a-z][a-z0-9_]{0,63}$/),
    ...diagnostic,
  }));
  const redirect = authorizationRedirect(error);
  if (redirect) {
    redirect.headers.set("x-request-id", requestId);
    return redirect;
  }
  if (isUnverifiedAuthorizationFailure(error)) {
    return plainOAuthError(400, "The authorization request could not be verified. Start again from your MCP client.", requestId);
  }
  return plainOAuthError(502, "GitHub sign-in could not be completed. Retry shortly.", requestId);
}

function oauthFailureDiagnostic(error: unknown): { errorType: string; errorCode?: string; failureReason?: string } {
  if (error instanceof AuthorizationError) {
    return {
      errorType: "authorization_error",
      errorCode: AUTHORIZATION_ERROR_CODES.has(error.code) ? error.code : "other",
      ...(AUTHORIZATION_FAILURE_REASONS.has(error.description)
        ? { failureReason: AUTHORIZATION_FAILURE_REASONS.get(error.description) }
        : {}),
    };
  }
  if (error instanceof CimdFetchError) return { errorType: "cimd_fetch_error", errorCode: "metadata_resolution_failed" };
  if (error instanceof Error && GITHUB_FAILURE_CODES.has(error.message)) {
    return { errorType: "github_upstream_error", errorCode: error.message };
  }
  return { errorType: "unexpected_error" };
}

function oauthConfigurationErrorResponse(request: Request, stage: string, errorCode: string, message: string): Response {
  const requestId = requestIdFor(request);
  console.error(JSON.stringify({
    event: "soyuz.oauth.failure",
    requestId,
    stage: safeSlug(stage, /^[a-z][a-z0-9_]{0,63}$/),
    errorType: "configuration_error",
    errorCode: safeSlug(errorCode, /^[a-z][a-z0-9_]{0,63}$/),
  }));
  return plainOAuthError(503, message, requestId);
}

function safeSlug(value: string, pattern: RegExp): string {
  return pattern.test(value) ? value : "other";
}

function authorizationRedirect(error: unknown): Response | null {
  if (!(error instanceof AuthorizationError) || !error.redirectTo) return null;
  return new Response(null, {
    status: 302,
    headers: { location: error.redirectTo, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function isUnverifiedAuthorizationFailure(error: unknown): boolean {
  return error instanceof AuthorizationError || error instanceof CimdFetchError;
}

function plainOAuthError(status: number, message: string, requestId: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Soyuz sign-in</title><p>${escapeHtml(message)}</p><p>Reference: <code>${escapeHtml(requestId)}</code></p>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
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

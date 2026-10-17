import { hasBearerToken, isBearerTokenConfigured } from "./auth/bearer";
import { authorizeMcpClient } from "./auth/mcp-client";
import { getSoyuzOAuthProvider, isOAuthConfigured } from "./auth/oauth";
import { handleClientRuns } from "./api/runs";
import { handleClientArtifacts, purgeExpiredArtifacts } from "./api/artifacts";
import { handleWorkerArtifacts } from "./api/worker-artifacts";
import { errorResponse, jsonResponse, requestIdFor } from "./api/http";
import { handleWorkerCallbacks } from "./api/workers";
import type { Env } from "./env";
import { DEFAULT_RUN_ORIGIN, type RunOrigin } from "./application/runs";
import { createSoyuzMcpHandler } from "./mcp/server";
import { reconcileAdmissions, reconcileStalledRuns } from "./queue/reconcile";

export async function handleRequest(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
  const requestId = requestIdFor(request);
  const url = new URL(request.url);
  const executionContext = context ?? { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  switch (requestRoute(url.pathname, request.method)) {
    case "health":
      return handleHealth(requestId, env);
    case "mcp":
      return handleMcpRequest(request, env, requestId, executionContext);
    case "dashboard-redirect":
      return Response.redirect(new URL("/dashboard/", url), 308);
    case "dashboard-api":
      return handleDashboardApi(request, env, requestId, executionContext);
    case "dashboard-assets":
      return env.ASSETS?.fetch(request) ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
    case "oauth":
      return handleOAuthRequest(request, env, requestId, executionContext);
    case "worker-api":
      return handleWorkerRequest(request, env, url, requestId);
    case "client-api":
      return handleClientRequest(request, env, url, requestId);
    default:
      return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }
}

type RequestRoute = "health" | "mcp" | "dashboard-redirect" | "dashboard-api" | "dashboard-assets" | "oauth" | "worker-api" | "client-api" | "not-found";

function requestRoute(pathname: string, method: string): RequestRoute {
  if (isHealthRoute(pathname, method)) return "health";
  if (isMcpRoute(pathname)) return "mcp";
  if (pathname === "/dashboard") return "dashboard-redirect";
  if (isDashboardApiRoute(pathname)) return "dashboard-api";
  if (isDashboardAssetRoute(pathname)) return "dashboard-assets";
  if (isOAuthRoute(pathname)) return "oauth";
  if (pathname.startsWith("/v1/worker/")) return "worker-api";
  if (isClientApiRoute(pathname)) return "client-api";
  return "not-found";
}

function isHealthRoute(pathname: string, method: string): boolean {
  return pathname === "/health" && method === "GET";
}

function isMcpRoute(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function isDashboardApiRoute(pathname: string): boolean {
  return pathname === "/dashboard/api" || pathname.startsWith("/dashboard/api/");
}

function isDashboardAssetRoute(pathname: string): boolean {
  return pathname === "/dashboard/" || pathname.startsWith("/dashboard/");
}

function isOAuthRoute(pathname: string): boolean {
  return pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/");
}

function isClientApiRoute(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

async function handleHealth(requestId: string, env: Env): Promise<Response> {
  if (!isBearerTokenConfigured(env.CLIENT_API_TOKEN) || !isBearerTokenConfigured(env.WORKER_API_TOKEN)) {
    return jsonResponse(503, {
      status: "unavailable",
      message: "Soyuz API authentication is not configured. Contact the service administrator.",
      requestId,
    });
  }
  try {
    await env.DB.prepare("SELECT 1 AS healthy").first();
    return jsonResponse(200, { status: "ok", contractVersion: "1", requestId });
  } catch {
    return jsonResponse(503, {
      status: "unavailable",
      message: "Soyuz cannot reach its run database. Retry shortly, or contact the service administrator if this continues.",
      requestId,
    });
  }
}

async function handleMcpRequest(
  request: Request,
  env: Env,
  requestId: string,
  context: ExecutionContext,
): Promise<Response> {
  if (isOAuthConfigured(env) && !(await hasBearerToken(request, env.CLIENT_API_TOKEN))) {
    return getSoyuzOAuthProvider(env)!.fetch(request, env, context);
  }
  const authFailure = await authorizeMcpClient(request, env, requestId);
  if (authFailure) return authFailure;
  return createSoyuzMcpHandler(env).fetch(request);
}

async function handleDashboardApi(
  request: Request,
  env: Env,
  requestId: string,
  context: ExecutionContext,
): Promise<Response> {
  const provider = getSoyuzOAuthProvider(env);
  if (!provider) return errorResponse(requestId, 503, "OAUTH_UNAVAILABLE", "OAuth dashboard access is not configured.");
  return provider.fetch(request, env, context);
}

async function handleOAuthRequest(
  request: Request,
  env: Env,
  requestId: string,
  context: ExecutionContext,
): Promise<Response> {
  const provider = getSoyuzOAuthProvider(env);
  if (!provider) return errorResponse(requestId, 503, "OAUTH_UNAVAILABLE", "OAuth is not configured.");
  return provider.fetch(request, env, context);
}

async function handleWorkerRequest(request: Request, env: Env, url: URL, requestId: string): Promise<Response> {
  if (!isBearerTokenConfigured(env.WORKER_API_TOKEN)) {
    return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Worker API-key authentication is not configured. Contact the service administrator.");
  }
  if (!(await hasBearerToken(request, env.WORKER_API_TOKEN))) {
    return errorResponse(requestId, 401, "UNAUTHORIZED", "Worker API key is missing or invalid. Check that you are using the current worker key.");
  }
  const artifactResponse = await handleWorkerArtifacts(request, env, url, requestId);
  if (artifactResponse) return artifactResponse;
  const response = await handleWorkerCallbacks(request, env, url, requestId);
  return response ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

async function handleClientRequest(request: Request, env: Env, url: URL, requestId: string): Promise<Response> {
  const kasekiTokenConfigured = isBearerTokenConfigured(env.KASEKI_SUBMISSION_API_TOKEN);
  if (kasekiTokenConfigured && env.KASEKI_SUBMISSION_API_TOKEN === env.CLIENT_API_TOKEN) {
    return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Kaseki submission authentication must use a credential distinct from the general client API key.");
  }
  if (!isBearerTokenConfigured(env.CLIENT_API_TOKEN) && !kasekiTokenConfigured) {
    return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Client API-key authentication is not configured. Contact the service administrator.");
  }
  let origin: RunOrigin = DEFAULT_RUN_ORIGIN;
  let authenticated = false;
  if (kasekiTokenConfigured && await hasBearerToken(request, env.KASEKI_SUBMISSION_API_TOKEN)) {
    const path = new URL(request.url).pathname;
    if (!isKasekiSubmissionRoute(path, request.method)) {
      return errorResponse(requestId, 403, "INSUFFICIENT_SCOPE", "Kaseki submission credentials are limited to run creation, retry, and cancellation.");
    }
    const identity = env.KASEKI_SUBMISSION_IDENTITY?.trim() || "kaseki";
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(identity)) {
      return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Kaseki submission identity configuration is invalid.");
    }
    origin = { type: "kaseki", id: identity };
    authenticated = true;
  } else if (await hasBearerToken(request, env.CLIENT_API_TOKEN)) {
    authenticated = true;
  }
  if (!authenticated) {
    return errorResponse(requestId, 401, "UNAUTHORIZED", "Client API key is missing or invalid. Check that you are using the current client key.");
  }
  const artifactResponse = await handleClientArtifacts(request, env, url, requestId);
  if (artifactResponse) return artifactResponse;
  const response = await handleClientRuns(request, env, url, requestId, origin);
  return response ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

function isKasekiSubmissionRoute(path: string, method: string): boolean {
  if (method === "POST" && path === "/v1/runs") return true;
  return method === "POST" && /^\/v1\/runs\/[0-9a-f-]{36}\/(retry|cancel)$/i.test(path);
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, context);
  },
  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): void {
    const work = [reconcileAdmissions(env), reconcileStalledRuns(env)];
    if (controller.cron === "0 3 * * *") {
      work.push(purgeExpiredArtifacts(env));
      const provider = getSoyuzOAuthProvider(env);
      if (provider && env.OAUTH_KV) work.push(purgeOAuthData(provider, env));
    }
    context.waitUntil(Promise.all(work).then(() => undefined));
  },
};

async function purgeOAuthData(provider: NonNullable<ReturnType<typeof getSoyuzOAuthProvider>>, env: Env): Promise<void> {
  if (!env.OAUTH_KV) return;
  const cursor = await env.OAUTH_KV.get("soyuz-oauth-purge-cursor");
  const result = await provider.purgeExpiredData(env, { batchSize: 100, cursor: cursor ?? undefined });
  if (result.cursor) await env.OAUTH_KV.put("soyuz-oauth-purge-cursor", result.cursor);
  else await env.OAUTH_KV.delete("soyuz-oauth-purge-cursor");
}

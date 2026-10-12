import { hasBearerToken, isBearerTokenConfigured } from "./auth/bearer";
import { authorizeMcpClient } from "./auth/mcp-client";
import { getSoyuzOAuthProvider, isOAuthConfigured } from "./auth/oauth";
import { handleClientRuns } from "./api/runs";
import { handleClientArtifacts, handleWorkerArtifacts, purgeExpiredArtifacts } from "./api/artifacts";
import { errorResponse, jsonResponse, requestIdFor } from "./api/http";
import { handleWorkerCallbacks } from "./api/workers";
import type { Env } from "./env";
import { createSoyuzMcpHandler } from "./mcp/server";
import { reconcileAdmissions, reconcileStalledRuns } from "./queue/reconcile";

export async function handleRequest(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
  const requestId = requestIdFor(request);
  const url = new URL(request.url);
  const executionContext = context ?? { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  if (url.pathname === "/health" && request.method === "GET") {
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

  if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
    if (isOAuthConfigured(env) && !(await hasBearerToken(request, env.CLIENT_API_TOKEN))) {
      return getSoyuzOAuthProvider(env)!.fetch(request, env, executionContext);
    }
    const authFailure = await authorizeMcpClient(request, env, requestId);
    if (authFailure) return authFailure;
    return createSoyuzMcpHandler(env).fetch(request);
  }

  if (url.pathname === "/dashboard") {
    return Response.redirect(new URL("/dashboard/", url), 308);
  }
  if (url.pathname === "/dashboard/api" || url.pathname.startsWith("/dashboard/api/")) {
    const provider = getSoyuzOAuthProvider(env);
    if (!provider) return errorResponse(requestId, 503, "OAUTH_UNAVAILABLE", "OAuth dashboard access is not configured.");
    return provider.fetch(request, env, executionContext);
  }
  if (url.pathname === "/dashboard/" || url.pathname.startsWith("/dashboard/")) {
    return env.ASSETS?.fetch(request) ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }
  if (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/")) {
    const provider = getSoyuzOAuthProvider(env);
    if (!provider) return errorResponse(requestId, 503, "OAUTH_UNAVAILABLE", "OAuth is not configured.");
    return provider.fetch(request, env, executionContext);
  }

  if (url.pathname.startsWith("/v1/worker/")) {
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

  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
    if (!isBearerTokenConfigured(env.CLIENT_API_TOKEN)) {
      return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Client API-key authentication is not configured. Contact the service administrator.");
    }
    if (!(await hasBearerToken(request, env.CLIENT_API_TOKEN))) {
      return errorResponse(requestId, 401, "UNAUTHORIZED", "Client API key is missing or invalid. Check that you are using the current client key.");
    }
    const artifactResponse = await handleClientArtifacts(request, env, url, requestId);
    if (artifactResponse) return artifactResponse;
    const response = await handleClientRuns(request, env, url, requestId);
    return response ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }

  return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
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

import { hasBearerToken, isBearerTokenConfigured } from "./auth/bearer";
import { authorizeMcpClient } from "./auth/mcp-client";
import { handleClientRuns } from "./api/runs";
import { errorResponse, jsonResponse, requestIdFor } from "./api/http";
import { handleWorkerCallbacks } from "./api/workers";
import type { Env } from "./env";
import { createSoyuzMcpHandler } from "./mcp/server";
import { reconcileAdmissions } from "./queue/reconcile";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const requestId = requestIdFor(request);
  const url = new URL(request.url);

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

  if (url.pathname === "/mcp") {
    const authFailure = await authorizeMcpClient(request, env, requestId);
    if (authFailure) return authFailure;
    return createSoyuzMcpHandler(env).fetch(request);
  }

  if (url.pathname.startsWith("/v1/worker/")) {
    if (!isBearerTokenConfigured(env.WORKER_API_TOKEN)) {
      return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Worker API-key authentication is not configured. Contact the service administrator.");
    }
    if (!(await hasBearerToken(request, env.WORKER_API_TOKEN))) {
      return errorResponse(requestId, 401, "UNAUTHORIZED", "Worker API key is missing, expired, or invalid. Check that you are using the current worker key.");
    }
    const response = await handleWorkerCallbacks(request, env, url, requestId);
    return response ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }

  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
    if (!isBearerTokenConfigured(env.CLIENT_API_TOKEN)) {
      return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Client API-key authentication is not configured. Contact the service administrator.");
    }
    if (!(await hasBearerToken(request, env.CLIENT_API_TOKEN))) {
      return errorResponse(requestId, 401, "UNAUTHORIZED", "Client API key is missing, expired, or invalid. Check that you are using the current client key.");
    }
    const response = await handleClientRuns(request, env, url, requestId);
    return response ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }

  return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): void {
    context.waitUntil(reconcileAdmissions(env));
  },
};

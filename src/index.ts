import { hasBearerToken } from "./auth/bearer";
import { handleClientRuns } from "./api/runs";
import { errorResponse, jsonResponse, requestIdFor } from "./api/http";
import { handleWorkerCallbacks } from "./api/workers";
import type { Env } from "./env";
import { reconcileAdmissions } from "./queue/reconcile";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const requestId = requestIdFor(request);
  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    try {
      await env.DB.prepare("SELECT 1 AS healthy").first();
      return jsonResponse(200, { status: "ok", contractVersion: "1", requestId });
    } catch {
      return jsonResponse(503, { status: "unavailable", requestId });
    }
  }

  if (url.pathname.startsWith("/v1/worker/")) {
    if (!(await hasBearerToken(request, env.WORKER_API_TOKEN))) {
      return errorResponse(requestId, 401, "UNAUTHORIZED", "Worker bearer token is missing or invalid");
    }
    const response = await handleWorkerCallbacks(request, env, url, requestId);
    return response ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }

  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
    if (!(await hasBearerToken(request, env.CLIENT_API_TOKEN))) {
      return errorResponse(requestId, 401, "UNAUTHORIZED", "Client bearer token is missing or invalid");
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

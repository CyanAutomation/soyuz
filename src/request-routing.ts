import { isBearerTokenConfigured } from "./auth/bearer";
import { errorResponse, jsonResponse, requestIdFor } from "./api/http";
import type { Env } from "./env";
import { createUtcpManual } from "./utcp/manual";
import {
  handleAgentRequest,
  handleClientRequest,
  handleDashboardApi,
  handleOAuthRequest,
  handleOperatorRequest,
  handleWorkerRequest,
} from "./request-handlers";

export async function handleRequest(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
  const requestId = requestIdFor(request);
  const url = new URL(request.url);
  const executionContext = context ?? { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  switch (requestRoute(url.pathname, request.method)) {
    case "health":
      return handleHealth(requestId, env);
    case "utcp":
      return handleUtcpDiscovery(request, env, requestId);
    case "docs-redirect":
      return Response.redirect(new URL("/docs/", url), 308);
    case "docs-assets":
      return handlePublicAssets(request, env, requestId);
    case "agent-api":
      return handleAgentRequest(request, env, url, requestId);
    case "dashboard-redirect":
      return Response.redirect(new URL("/dashboard/", url), 308);
    case "dashboard-api":
      return handleDashboardApi(request, env, requestId, executionContext);
    case "dashboard-assets":
      return handlePublicAssets(request, env, requestId);
    case "oauth":
      return handleOAuthRequest(request, env, requestId, executionContext);
    case "worker-api":
      return handleWorkerRequest(request, env, url, requestId);
    case "operator-api":
      return handleOperatorRequest(request, env, requestId);
    case "client-api":
      return handleClientRequest(request, env, url, requestId, executionContext);
    default:
      return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }
}

type RequestRoute = "health" | "utcp" | "agent-api" | "docs-redirect" | "docs-assets" | "dashboard-redirect" | "dashboard-api" | "dashboard-assets" | "oauth" | "worker-api" | "operator-api" | "client-api" | "not-found";

function requestRoute(pathname: string, method: string): RequestRoute {
  return controlPlaneRoute(pathname, method)
    ?? dashboardRoute(pathname)
    ?? oauthRoute(pathname)
    ?? versionedApiRoute(pathname)
    ?? "not-found";
}

function controlPlaneRoute(pathname: string, method: string): RequestRoute | null {
  if (pathname === "/health" && method === "GET") return "health";
  if (pathname === "/utcp" && method === "GET") return "utcp";
  if (pathname === "/docs") return "docs-redirect";
  if (pathname === "/docs/" || pathname.startsWith("/docs/") || pathname === "/openapi.json") return "docs-assets";
  if (pathname === "/v1/agent/runs" || pathname.startsWith("/v1/agent/runs/")) return "agent-api";
  if (pathname === "/v1/operator/kirisame/preflight" && method === "POST") return "operator-api";
  return null;
}

function dashboardRoute(pathname: string): RequestRoute | null {
  if (pathname === "/dashboard") return "dashboard-redirect";
  if (pathname === "/dashboard/api" || pathname.startsWith("/dashboard/api/")) return "dashboard-api";
  if (pathname === "/dashboard/" || pathname.startsWith("/dashboard/")) return "dashboard-assets";
  return null;
}

function oauthRoute(pathname: string): RequestRoute | null {
  return pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/") ? "oauth" : null;
}

function versionedApiRoute(pathname: string): RequestRoute | null {
  if (pathname.startsWith("/v1/worker/")) return "worker-api";
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return "client-api";
  return null;
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
    await env.DB.prepare(`
      SELECT id, origin_type, origin_id, retry_of, last_heartbeat_at, operational_health, request_redacted_at,
        persistence_schema_version, retention_policy_version, expires_at, artifact_delivery_status
      FROM runs LIMIT 0
    `).first();
    await env.DB.prepare(`
      SELECT artifact_type, artifact_schema_version, sha256, engine_id, producer_id, retention_policy_version
      FROM run_artifacts LIMIT 0
    `).first();
    await env.DB.prepare(`
      SELECT origin_type, origin_id, idempotency_key, request_hash, run_id
      FROM run_idempotency_keys LIMIT 0
    `).first();
    await env.DB.prepare(`
      SELECT object_key, queued_at, last_attempt_at
      FROM artifact_deletion_queue LIMIT 0
    `).first();
    await env.DB.prepare("SELECT publication_id, state FROM publications LIMIT 0").first();
    await env.DB.prepare("SELECT artifact_id, object_key FROM publication_manifest_artifacts LIMIT 0").first();
    await env.DB.prepare("SELECT publication_id, event_id FROM publication_events LIMIT 0").first();
    await env.DB.prepare("SELECT metric_day, outcome, expires_at FROM artifact_upload_metrics LIMIT 0").first();
    return jsonResponse(200, { status: "ok", contractVersion: "1", requestId });
  } catch {
    return jsonResponse(503, {
      status: "unavailable",
      message: "Soyuz cannot reach its run database or verify its required schema. Retry shortly, or contact the service administrator if this continues.",
      requestId,
    });
  }
}

async function handlePublicAssets(request: Request, env: Env, requestId: string): Promise<Response> {
  if (!env.ASSETS) return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; "));
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("cross-origin-resource-policy", "same-origin");
  if ((headers.get("content-type") ?? "").includes("text/html")) {
    headers.set("cache-control", "no-store");
  } else if (response.status === 200) {
    // Asset filenames are stable across deployments, so keep browser/CDN freshness bounded.
    headers.set("cache-control", "public, max-age=300, must-revalidate");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function handleUtcpDiscovery(request: Request, env: Env, requestId: string): Response {
  const manual = createUtcpManual(env);
  if (!manual) {
    return errorResponse(requestId, 503, "UTCP_DISCOVERY_UNAVAILABLE", "Soyuz UTCP discovery is not configured with a valid public origin.");
  }
  return jsonResponse(200, manual);
}

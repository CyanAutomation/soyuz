import { insufficientScope, type OAuthResourceAuth, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { listRunsPage, readRun, readRunEventsPage, RunApplicationError } from "../application/runs";
import { parseEventPayload, parseResult, type RunEventRow, type RunRow } from "../db/runs";
import type { Env } from "../env";
import { isUuid } from "../lib/uuid";
import { safeUrlForDisplay } from "../lib/safe-url";
import { handleClientArtifacts } from "../api/artifacts";
import { errorResponse, requestIdFor, successResponse } from "../api/http";
import { createSoyuzMcpHandler } from "../mcp/server";
import { isAllowedGithubUser, SOYUZ_READ_SCOPE, SOYUZ_WRITE_SCOPE, type OAuthProps } from "./oauth-policy";

const API_PREFIX = "/dashboard/api";
const MAX_MCP_AUTH_INSPECTION_BYTES = 1_000_000;

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

export async function handleOAuthMcpRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const access = authorizeOAuthContext(context, env);
  if (!access.ok) return access.response;
  if (await requestNeedsWriteScope(request) && !access.context.auth.scope.includes(SOYUZ_WRITE_SCOPE)) {
    return insufficientScope(access.context.auth, [SOYUZ_READ_SCOPE, SOYUZ_WRITE_SCOPE]);
  }
  return createSoyuzMcpHandler(env).fetch(request);
}

export async function handleDashboardApiRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const access = authorizeOAuthContext(context, env);
  if (!access.ok) return access.response;
  if (request.method !== "GET") return errorResponse(requestIdFor(request), 405, "METHOD_NOT_ALLOWED", "The dashboard is read-only.");

  const url = new URL(request.url);
  const path = url.pathname.slice(API_PREFIX.length) || "/";
  const segments = path.split("/").filter(Boolean);
  const requestId = requestIdFor(request);
  return routeDashboardApiRequest(request, env, url, segments, requestId, access.context);
}

async function routeDashboardApiRequest(
  request: Request,
  env: Env,
  url: URL,
  segments: string[],
  requestId: string,
  context: OAuthResourceContext<OAuthProps>,
): Promise<Response> {
  if (segments.length === 1 && segments[0] === "me") {
    return successResponse(requestId, { githubLogin: context.props.githubLogin });
  }
  if (segments.length === 1 && segments[0] === "runs") {
    return listDashboardRuns(env, url, requestId);
  }
  if (segments[0] !== "runs" || !isUuid(segments[1])) {
    return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }

  const runId = segments[1];
  switch (segments.length) {
    case 2:
      return readDashboardRun(env, runId, requestId);
    case 3:
      if (segments[2] === "events") return readDashboardEvents(env, url, runId, requestId);
      if (segments[2] === "artifacts") return readDashboardArtifacts(request, env, url, segments, runId, requestId);
      break;
    case 4:
      if (segments[2] === "artifacts") return readDashboardArtifacts(request, env, url, segments, runId, requestId);
      break;
  }
  return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

async function readDashboardArtifacts(
  request: Request,
  env: Env,
  url: URL,
  segments: string[],
  runId: string,
  requestId: string,
): Promise<Response> {
  const artifactPath = `/v1/runs/${runId}/artifacts${segments[3] ? `/${encodeURIComponent(segments[3])}` : ""}`;
  return await handleClientArtifacts(request, env, new URL(`${artifactPath}${url.search}`, url.origin), requestId)
    ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

async function listDashboardRuns(env: Env, url: URL, requestId: string): Promise<Response> {
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

async function readDashboardRun(env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    return successResponse(requestId, dashboardRunDetail(await readRun(env, runId)));
  } catch (error) {
    return dashboardErrorResponse(error, requestId);
  }
}

async function readDashboardEvents(env: Env, url: URL, runId: string, requestId: string): Promise<Response> {
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

function authorizeOAuthContext(
  context: ExecutionContext,
  env: Env,
): { ok: true; context: OAuthResourceContext<OAuthProps> } | { ok: false; response: Response } {
  if (!hasOAuthContext(context)) {
    return { ok: false, response: errorResponse("oauth", 401, "UNAUTHORIZED", "OAuth token context is unavailable.") };
  }
  const rejected = authorizeOAuthUser(context.props, context.auth.scope, env, context.auth);
  return rejected ? { ok: false, response: rejected } : { ok: true, context };
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

function dashboardRunSummary(row: RunRow): Record<string, unknown> {
  return {
    runId: row.id,
    status: row.status,
    repoUrl: safeUrlForDisplay(row.repo_url),
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
  const publishedUrl = typeof result?.publishedUrl === "string" ? safeUrlForDisplay(result.publishedUrl) : null;
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

function dashboardErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof RunApplicationError) {
    return errorResponse(requestId, error.status, error.code, error.publicMessage, { details: error.details });
  }
  return errorResponse(requestId, 503, "RUN_OPERATION_UNAVAILABLE", "Soyuz could not read run history. Retry shortly.");
}

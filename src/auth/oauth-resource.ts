import { insufficientScope, type OAuthResourceAuth, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { listRunsPage, readRun, readRunEventsPage, RunApplicationError } from "../application/runs";
import { parseEventPayload, parseResult, type RunEventRow, type RunRow } from "../db/runs";
import type { Env } from "../env";
import { isUuid } from "../lib/uuid";
import { safeHttpUrlForDisplay, safeUrlForDisplay } from "../lib/safe-url";
import { handleClientArtifacts } from "../api/artifacts";
import { handleRunOutcomes } from "../api/run-outcomes";
import type { PublicationRow } from "../publication/lifecycle";
import { errorResponse, rateLimitedResponse, requestIdFor, successResponse } from "../api/http";
import { isAllowedGithubUser, SOYUZ_READ_SCOPE, type OAuthProps } from "./oauth-policy";

const API_PREFIX = "/dashboard/api";

export async function handleDashboardApiRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const access = authorizeOAuthContext(context, env);
  if (!access.ok) return access.response;
  const url = new URL(request.url);
  const path = url.pathname.slice(API_PREFIX.length) || "/";
  const segments = path.split("/").filter(Boolean);
  const requestId = requestIdFor(request);
  if (request.method === "POST" && segments.length === 2 && segments[0] === "analysis" && segments[1] === "decisions") {
    let outcome: RateLimitOutcome;
    try {
      outcome = await env.JEV_DECISION_LIMITER.limit({ key: access.context.props.githubUserId });
    } catch {
      return errorResponse(requestId, 503, "RATE_LIMITER_UNAVAILABLE", "JEV analysis is temporarily unavailable. Retry shortly.");
    }
    if (!outcome.success) return rateLimitedResponse(requestId);
    const { handleJevAnalysisRequest } = await import("../jev/analysis");
    return handleJevAnalysisRequest(request, env, requestId);
  }
  if (request.method === "POST" && segments.length === 2 && segments[0] === "analysis" && segments[1] === "feedback") {
    let outcome: RateLimitOutcome;
    try {
      outcome = await env.JEV_DECISION_LIMITER.limit({ key: access.context.props.githubUserId });
    } catch {
      return errorResponse(requestId, 503, "RATE_LIMITER_UNAVAILABLE", "Analysis feedback is temporarily unavailable. Retry shortly.");
    }
    if (!outcome.success) return rateLimitedResponse(requestId);
    const { handleJevFeedbackRequest } = await import("../jev/feedback");
    return handleJevFeedbackRequest(request, env, access.context.props.githubUserId, requestId);
  }
  if (request.method !== "GET") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "The dashboard is read-only except for authenticated JEV decision and feedback requests.");
  if (segments.length === 2 && segments[0] === "analysis" && segments[1] === "feedback-summary") {
    const { handleJevFeedbackSummaryRequest } = await import("../jev/feedback");
    return handleJevFeedbackSummaryRequest(env, requestId);
  }
  return routeDashboardApiRequest(request, env, url, segments, requestId, access.context, context);
}

async function routeDashboardApiRequest(
  request: Request,
  env: Env,
  url: URL,
  segments: string[],
  requestId: string,
  context: OAuthResourceContext<OAuthProps>,
  executionContext: ExecutionContext,
): Promise<Response> {
  if (segments.length === 1 && segments[0] === "me") {
    return successResponse(requestId, { githubLogin: context.props.githubLogin });
  }
  if (segments.length === 1 && segments[0] === "outcomes") {
    return await handleRunOutcomes(new Request(new URL("/v1/run-outcomes", url), request), env, requestId)
      ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  }
  if (segments.length === 1 && segments[0] === "runs") {
    return listDashboardRuns(env, url, requestId);
  }
  return routeRunResource(request, env, url, segments, runIdFrom(segments), requestId, executionContext);
}

function runIdFrom(segments: string[]): string | null {
  if (segments[0] !== "runs" || !isUuid(segments[1])) {
    return null;
  }
  return segments[1];
}

async function routeRunResource(
  request: Request,
  env: Env,
  url: URL,
  segments: string[],
  runId: string | null,
  requestId: string,
  executionContext: ExecutionContext,
): Promise<Response> {
  if (!runId) return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  switch (segments.length) {
    case 2:
      return readDashboardRun(env, runId, requestId);
    case 3:
      if (segments[2] === "events") return readDashboardEvents(env, url, runId, requestId);
      if (segments[2] === "artifacts") return readDashboardArtifacts(request, env, url, segments, runId, requestId, executionContext);
      break;
    case 4:
      if (segments[2] === "artifacts") return readDashboardArtifacts(request, env, url, segments, runId, requestId, executionContext);
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
  executionContext: ExecutionContext,
): Promise<Response> {
  const artifactPath = `/v1/runs/${runId}/artifacts${segments[3] ? `/${encodeURIComponent(segments[3])}` : ""}`;
  return await handleClientArtifacts(request, env, new URL(`${artifactPath}${url.search}`, url.origin), requestId, executionContext)
    ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

async function listDashboardRuns(env: Env, url: URL, requestId: string): Promise<Response> {
  try {
    const page = await listRunsPage(env, {
      limit: url.searchParams.get("limit") ?? 30,
      status: url.searchParams.get("status"),
      cursor: url.searchParams.get("cursor"),
    });
    const publicationRead = await readPublicationSummaries(env, page.rows.map((row) => row.id));
    return successResponse(requestId, {
      runs: page.rows.map((row) => dashboardRunSummary(row, publicationRead.byRunId.get(row.id) ?? null, publicationRead.available)),
      nextCursor: page.nextCursor,
      publicationStatusAvailable: publicationRead.available,
    });
  } catch (error) {
    return dashboardErrorResponse(error, requestId);
  }
}

async function readDashboardRun(env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    const row = await readRun(env, runId);
    const publicationRead = await readPublicationSummaries(env, [runId]);
    return successResponse(requestId, dashboardRunDetail(
      row,
      publicationRead.byRunId.get(runId) ?? null,
      publicationRead.available,
    ));
  } catch (error) {
    return dashboardErrorResponse(error, requestId);
  }
}

interface DashboardPublicationStatus {
  run_id: string;
  state: PublicationRow["state"];
  attempt_count: number;
  next_attempt_at: string | null;
  completed_at: string | null;
}

async function readPublicationSummaries(
  env: Env,
  runIds: string[],
): Promise<{ available: boolean; byRunId: Map<string, DashboardPublicationStatus> }> {
  if (runIds.length === 0) return { available: true, byRunId: new Map() };
  try {
    const placeholders = runIds.map(() => "?").join(", ");
    const rows = await env.DB.prepare(`
      SELECT run_id, state, attempt_count, next_attempt_at, completed_at
      FROM publications WHERE run_id IN (${placeholders})
    `).bind(...runIds).all<DashboardPublicationStatus>();
    return {
      available: true,
      byRunId: new Map((rows.results ?? []).map((row) => [row.run_id, row])),
    };
  } catch {
    // Keep run history usable during a publication-ledger read failure.
    return { available: false, byRunId: new Map() };
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
      hasMore: page.hasMore,
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
  return hasOAuthProps(candidate.props) && hasOAuthAuth(candidate.auth);
}

function hasOAuthProps(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const props = value as { githubUserId?: unknown; githubLogin?: unknown };
  return typeof props.githubUserId === "string" && typeof props.githubLogin === "string";
}

function hasOAuthAuth(value: unknown): value is OAuthResourceAuth {
  if (!value || typeof value !== "object") return false;
  const auth = value as Partial<OAuthResourceAuth>;
  return typeof auth.token === "string"
    && typeof auth.audience === "string"
    && Array.isArray(auth.scope)
    && auth.scope.every((scope) => typeof scope === "string");
}

function dashboardRunSummary(
  row: RunRow,
  publication: DashboardPublicationStatus | null = null,
  publicationStatusAvailable = true,
): Record<string, unknown> {
  const result = parseResult(row);
  return {
    runId: row.id,
    displayId: row.display_id,
    origin: { type: row.origin_type, id: row.origin_id },
    retryOf: row.retry_of,
    status: row.status,
    repoUrl: safeUrlForDisplay(row.repo_url),
    ref: row.git_ref,
    taskMode: row.task_mode,
    publishMode: row.publish_mode,
    stage: row.stage,
    operationalHealth: row.operational_health,
    failureClass: row.failure_class,
    failureMessage: row.failure_message,
    outcomeSummary: typeof result?.summary === "string" ? result.summary.slice(0, 2_000) : null,
    legacyPublished: typeof result?.publishedUrl === "string" && safeHttpUrlForDisplay(result.publishedUrl) !== null,
    publication: publication ? dashboardPublicationSummary(publication) : null,
    publicationStatusAvailable,
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function dashboardRunDetail(
  row: RunRow,
  publication: DashboardPublicationStatus | null,
  publicationStatusAvailable: boolean,
): Record<string, unknown> {
  const result = parseResult(row);
  const publishedUrl = typeof result?.publishedUrl === "string" ? safeHttpUrlForDisplay(result.publishedUrl) : null;
  return {
    ...dashboardRunSummary(row, publication, publicationStatusAvailable),
    updatedAt: row.updated_at,
    outcomeSummary: typeof result?.summary === "string" ? result.summary.slice(0, 2_000) : null,
    publishedUrl,
    changedFileCount: typeof result?.changedFileCount === "number" ? result.changedFileCount : null,
    failureClass: row.failure_class,
    exitCode: row.exit_code,
    cancellation: {
      state: row.status === "cancel_requested" ? "requested" : row.status === "cancelled" ? "cancelled" : "none",
      requestedAt: row.cancel_requested_at,
    },
  };
}

function dashboardPublicationSummary(row: DashboardPublicationStatus): Record<string, unknown> {
  return {
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    completedAt: row.completed_at,
  };
}

const DASHBOARD_EVENT_KEYS = new Set([
  "source", "status", "percent", "progressPercent", "current", "total", "completed", "passed", "failed", "exitCode", "durationMs", "changedFileCount", "failureClass", "uploadedCount", "failedCount", "skippedCount",
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

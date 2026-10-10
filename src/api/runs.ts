import {
  createRun,
  listRunsPage,
  readRun,
  readRunEventsPage,
  requestRunCancellation,
  RunApplicationError,
} from "../application/runs";
import {
  parseRequest,
  parseResult,
  type RunRow,
} from "../db/runs";
import type { Env } from "../env";
import { isUuid } from "../lib/uuid";
import { ApiError, errorResponse, parseJsonBody, successResponse } from "./http";
import { publicEvent } from "./public-event";

export async function handleClientRuns(request: Request, env: Env, url: URL, requestId: string): Promise<Response | null> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/v1/runs" && request.method === "POST") {
    return submitRun(request, env, requestId);
  }
  if (url.pathname === "/v1/runs" && request.method === "GET") {
    return listRunRoute(url, env, requestId);
  }
  if (segments.length < 3 || segments[0] !== "v1" || segments[1] !== "runs" || !segments[2]) return null;

  const runId = segments[2];
  if (!isUuid(runId)) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");

  if (segments.length === 3 && request.method === "GET") {
    return getRunRoute(runId, env, requestId);
  }
  if (segments.length === 4 && segments[3] === "events" && request.method === "GET") {
    return getRunEventsRoute(runId, url, env, requestId);
  }
  if (segments.length === 4 && segments[3] === "cancel" && request.method === "POST") {
    return cancelRun(runId, env, requestId);
  }
  return null;
}

async function submitRun(request: Request, env: Env, requestId: string): Promise<Response> {
  try {
    const body = await parseJsonBody(request, requestId);
    const admission = await createRun(env, body, requestId, request.headers.get("idempotency-key"));
    return successResponse(requestId, publicRun(admission.row), admission.statusCode);
  } catch (error) {
    return applicationErrorResponse(error, requestId);
  }
}

async function listRunRoute(url: URL, env: Env, requestId: string): Promise<Response> {
  try {
    const page = await listRunsPage(env, {
      limit: url.searchParams.get("limit"),
      status: url.searchParams.get("status"),
      cursor: url.searchParams.get("cursor"),
    });
    return successResponse(requestId, {
      runs: page.rows.map(publicRunSummary),
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    return applicationErrorResponse(error, requestId);
  }
}

async function getRunRoute(runId: string, env: Env, requestId: string): Promise<Response> {
  try {
    return successResponse(requestId, publicRun(await readRun(env, runId)));
  } catch (error) {
    return applicationErrorResponse(error, requestId);
  }
}

async function getRunEventsRoute(runId: string, url: URL, env: Env, requestId: string): Promise<Response> {
  try {
    const page = await readRunEventsPage(env, runId, {
      after: url.searchParams.get("after"),
      limit: url.searchParams.get("limit"),
    });
    return successResponse(requestId, {
      events: page.events.map(publicEvent),
      nextAfter: page.nextAfter,
    });
  } catch (error) {
    return applicationErrorResponse(error, requestId);
  }
}

async function cancelRun(runId: string, env: Env, requestId: string): Promise<Response> {
  try {
    const result = await requestRunCancellation(env, runId);
    return successResponse(requestId, publicRun(result.row), result.statusCode);
  } catch (error) {
    return applicationErrorResponse(error, requestId);
  }
}

function applicationErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) return error.toResponse(requestId);
  if (error instanceof RunApplicationError) {
    return errorResponse(requestId, error.status, error.code, error.publicMessage, { details: error.details });
  }
  return errorResponse(requestId, 503, "RUN_OPERATION_UNAVAILABLE", "Soyuz could not reach a required service to complete the run operation. Retry shortly; if this continues, contact the service administrator.");
}

export function publicRun(row: RunRow): Record<string, unknown> {
  return {
    id: row.id,
    contractVersion: row.contract_version,
    repoUrl: row.repo_url,
    ref: row.git_ref,
    projectName: row.project_name,
    status: row.status,
    stage: row.stage,
    taskMode: row.task_mode,
    publishMode: row.publish_mode,
    request: parseRequest(row),
    result: parseResult(row),
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    workerId: row.worker_id,
    claimExpiresAt: row.claim_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    operationalHealth: row.operational_health,
    exitCode: row.exit_code,
    failureClass: row.failure_class,
    failureMessage: row.failure_message,
    cancelRequestedAt: row.cancel_requested_at,
    correlationId: row.correlation_id,
    requestId: row.request_id,
  };
}

function publicRunSummary(row: RunRow): Record<string, unknown> {
  return {
    id: row.id,
    contractVersion: row.contract_version,
    repoUrl: row.repo_url,
    ref: row.git_ref,
    projectName: row.project_name,
    status: row.status,
    stage: row.stage,
    taskMode: row.task_mode,
    publishMode: row.publish_mode,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    operationalHealth: row.operational_health,
    exitCode: row.exit_code,
    failureClass: row.failure_class,
  };
}

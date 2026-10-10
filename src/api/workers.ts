import {
  WorkerCancelledSchema,
  WorkerClaimSchema,
  WorkerCompletedSchema,
  WorkerEventSchema,
  WorkerFailedSchema,
  WorkerStartedSchema,
} from "../contracts/worker-callbacks";
import {
  findRunEvent,
  getRun,
  parseResult,
  recordWorkerEvent,
  RunEventError,
  RunNotFoundError,
  RunTransitionError,
  transitionRun,
  updateStartedRun,
  type RunEventInput,
  type RunEventRow,
  type RunRow,
} from "../db/runs";
import type { Env } from "../env";
import { stableStringify } from "../lib/canonical-json";
import { isUuid } from "../lib/uuid";
import { ApiError, errorResponse, parseJsonBody, successResponse, validationDetails } from "./http";
import { publicEvent } from "./public-event";
import { publicRun } from "./runs";

type CallbackParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };

type CallbackSchema<T> = { safeParse(input: unknown): CallbackParseResult<T> };

export async function handleWorkerCallbacks(request: Request, env: Env, url: URL, requestId: string): Promise<Response | null> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "worker" || parts[2] !== "runs") return null;
  if (parts.length === 4 && request.method === "GET") {
    const runId = parts[3];
    if (!isUuid(runId)) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
    try {
      const row = await getRun(env.DB, runId);
      if (!row) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
      return successResponse(requestId, {
        runId: row.id,
        contractVersion: row.contract_version,
        status: row.status,
        stage: row.stage,
        claimExpiresAt: row.claim_expires_at,
        cancelRequestedAt: row.cancel_requested_at,
        workerId: row.worker_id,
        updatedAt: row.updated_at,
        lastHeartbeatAt: row.last_heartbeat_at,
        operationalHealth: row.operational_health,
      });
    } catch {
      return errorResponse(requestId, 503, "RUN_READ_UNAVAILABLE", "Soyuz cannot reach its run database to read canonical run state. Retry shortly.");
    }
  }
  if (parts.length !== 5) return null;
  const [, , , runId, action] = parts;
  if (!isUuid(runId)) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
  if (request.method !== "POST") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Worker callback routes accept POST requests");

  switch (action) {
    case "claim":
      return claimed(request, env, runId, requestId);
    case "started":
      return started(request, env, runId, requestId);
    case "events":
      return event(request, env, runId, requestId);
    case "completed":
      return completed(request, env, runId, requestId);
    case "failed":
      return failed(request, env, runId, requestId);
    case "cancelled":
      return cancelled(request, env, runId, requestId);
    default:
      return null;
  }
}

async function claimed(request: Request, env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    const payload = await parseCallbackBody(
      request, requestId, WorkerClaimSchema, "INVALID_WORKER_CALLBACK", "Claim callback failed validation",
    );
    const row = await requireRun(env, runId);
    const previous = await findRunEvent(env.DB, runId, payload.data.callbackId);
    if (callbackReplayMatches(previous, "run.claimed", payload.data.workerId, { leaseSeconds: payload.data.leaseSeconds })) {
      return successResponse(requestId, publicRun(row));
    }
    const existingClaim = currentClaimResponse(row, payload.data.workerId, requestId);
    if (existingClaim) return existingClaim;

    const updated = await commitClaim(env, runId, payload.data.callbackId, payload.data.workerId, payload.data.leaseSeconds);
    return successResponse(requestId, publicRun(updated));
  } catch (error) {
    return callbackError(error, requestId);
  }
}

async function started(request: Request, env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    const payload = await parseCallbackBody(
      request, requestId, WorkerStartedSchema, "INVALID_WORKER_CALLBACK", "Started callback failed validation",
    );
    const row = await requireRun(env, runId);
    if (row.worker_id && row.worker_id !== payload.data.workerId) {
      throw new ApiError(409, "WORKER_MISMATCH", "A different worker already owns this run");
    }
    const priorCallback = await findRunEvent(env.DB, runId, payload.data.callbackId);
    if (callbackReplayMatches(
      priorCallback,
      "run.started",
      payload.data.workerId,
      { status: "running" },
      payload.data.stage ?? null,
    )) {
      return successResponse(requestId, publicRun(row));
    }
    if (row.status === "running") return successResponse(requestId, publicRun(row));
    if (row.status !== "claimed") {
      throw new ApiError(409, row.status === "cancelled" ? "RUN_CANCELLED" : "INVALID_STATE_TRANSITION", `Run in ${row.status} state cannot start`);
    }

    const now = new Date().toISOString();
    const eventInput: RunEventInput = {
      eventId: payload.data.callbackId,
      type: "run.started",
      workerId: payload.data.workerId,
      stage: payload.data.stage ?? null,
      occurredAt: payload.data.startedAt ?? now,
      recordedAt: now,
      payload: { status: "running" },
    };
    const updated = await updateStartedRun(
      env.DB,
      runId,
      payload.data.workerId,
      payload.data.startedAt ?? now,
      payload.data.stage ?? null,
      eventInput,
    );
    return successResponse(requestId, publicRun(updated));
  } catch (error) {
    return callbackError(error, requestId);
  }
}

async function event(request: Request, env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    const payload = await parseCallbackBody(
      request, requestId, WorkerEventSchema, "INVALID_WORKER_EVENT", "Worker event failed validation",
    );
    const now = new Date().toISOString();
    const eventInput: RunEventInput = {
      eventId: payload.data.eventId,
      type: payload.data.type,
      workerId: payload.data.workerId,
      stage: payload.data.stage ?? null,
      step: payload.data.step ?? null,
      occurredAt: payload.data.timestamp ?? now,
      recordedAt: now,
      payload: payload.data.payload,
    };
    const saved = await recordWorkerEvent(env.DB, runId, eventInput);
    return successResponse(requestId, publicEvent(saved), 202);
  } catch (error) {
    return callbackError(error, requestId);
  }
}

async function completed(request: Request, env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    const payload = await parseCallbackBody(
      request, requestId, WorkerCompletedSchema, "INVALID_WORKER_CALLBACK", "Completed callback failed validation",
    );
    const row = await requireActiveWorker(env, runId, payload.data.workerId);
    const result = {
      ...(payload.data.summary ? { summary: payload.data.summary } : {}),
      ...(payload.data.publishedUrl ? { publishedUrl: payload.data.publishedUrl } : {}),
      ...(payload.data.changedFileCount !== undefined ? { changedFileCount: payload.data.changedFileCount } : {}),
    };
    await ensureCallbackIdAvailable(env, runId, payload.data.callbackId, "run.completed", payload.data.workerId, result);
    if (row.status === "completed") return successResponse(requestId, publicRun(row));
    const now = new Date().toISOString();
    const updated = await transitionRun(env.DB, runId, "completed", {
      completed_at: payload.data.completedAt ?? now,
      exit_code: payload.data.exitCode ?? 0,
      result_json: Object.keys(result).length ? stableStringify(result) : null,
    }, {
      eventId: payload.data.callbackId,
      type: "run.completed",
      workerId: payload.data.workerId,
      occurredAt: payload.data.completedAt ?? now,
      recordedAt: now,
      payload: result,
    });
    return successResponse(requestId, publicRun(updated));
  } catch (error) {
    return callbackError(error, requestId);
  }
}

async function failed(request: Request, env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    const payload = await parseCallbackBody(
      request, requestId, WorkerFailedSchema, "INVALID_WORKER_CALLBACK", "Failed callback failed validation",
    );
    const row = await requireWorkerOwnership(env, runId, payload.data.workerId);
    const eventPayload = {
      failureClass: payload.data.failureClass,
      failureMessage: payload.data.failureMessage,
      ...(payload.data.exitCode !== undefined ? { exitCode: payload.data.exitCode } : {}),
    };
    await ensureCallbackIdAvailable(env, runId, payload.data.callbackId, "run.failed", payload.data.workerId, eventPayload);
    if (row.status === "failed") return successResponse(requestId, publicRun(row));
    const now = new Date().toISOString();
    if (row.status === "claimed") assertClaimIsLive(row);
    const updated = await transitionRun(env.DB, runId, "failed", {
      completed_at: payload.data.completedAt ?? now,
      exit_code: payload.data.exitCode ?? null,
      failure_class: payload.data.failureClass,
      failure_message: payload.data.failureMessage,
    }, {
      eventId: payload.data.callbackId,
      type: "run.failed",
      workerId: payload.data.workerId,
      occurredAt: payload.data.completedAt ?? now,
      recordedAt: now,
      payload: eventPayload,
    }, row.status === "claimed" ? { claimOwner: payload.data.workerId, claimNotExpiredAt: now } : undefined);
    return successResponse(requestId, publicRun(updated));
  } catch (error) {
    return callbackError(error, requestId);
  }
}

async function cancelled(request: Request, env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    const payload = await parseCallbackBody(
      request, requestId, WorkerCancelledSchema, "INVALID_WORKER_CALLBACK", "Cancelled callback failed validation",
    );
    const row = await requireWorkerOwnership(env, runId, payload.data.workerId);
    const eventPayload = {
      ...(payload.data.reason ? { reason: payload.data.reason } : {}),
      ...(payload.data.exitCode !== undefined ? { exitCode: payload.data.exitCode } : {}),
    };
    await ensureCallbackIdAvailable(env, runId, payload.data.callbackId, "run.cancelled", payload.data.workerId, eventPayload);
    if (row.status === "cancelled") return successResponse(requestId, publicRun(row));
    const now = new Date().toISOString();
    if (row.status === "claimed") assertClaimIsLive(row);
    const updated = await transitionRun(env.DB, runId, "cancelled", {
      completed_at: payload.data.completedAt ?? now,
      exit_code: payload.data.exitCode ?? null,
      failure_class: "cancelled",
      failure_message: payload.data.reason ?? null,
    }, {
      eventId: payload.data.callbackId,
      type: "run.cancelled",
      workerId: payload.data.workerId,
      occurredAt: payload.data.completedAt ?? now,
      recordedAt: now,
      payload: eventPayload,
    }, row.status === "claimed" ? { claimOwner: payload.data.workerId, claimNotExpiredAt: now } : undefined);
    return successResponse(requestId, publicRun(updated));
  } catch (error) {
    return callbackError(error, requestId);
  }
}

async function requireRun(env: Env, runId: string): Promise<RunRow> {
  const row = await getRun(env.DB, runId);
  if (!row) throw new ApiError(404, "RUN_NOT_FOUND", "Run was not found");
  return row;
}

function currentClaimResponse(row: RunRow, workerId: string, requestId: string): Response | null {
  if (row.status === "claimed" || row.status === "running") {
    if (row.worker_id === workerId) return successResponse(requestId, publicRun(row));
    throw new ApiError(409, "RUN_CLAIMED", "Another worker already owns this run");
  }
  if (row.status !== "queued") {
    throw new ApiError(409, row.status === "cancelled" ? "RUN_CANCELLED" : "INVALID_STATE_TRANSITION", `Run in ${row.status} state cannot be claimed`);
  }
  return null;
}

async function commitClaim(
  env: Env,
  runId: string,
  callbackId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<RunRow> {
  const now = new Date().toISOString();
  const claimExpiresAt = new Date(Date.now() + leaseSeconds * 1_000).toISOString();
  const payload = { leaseSeconds };
  try {
    const updated = await transitionRun(env.DB, runId, "claimed", {
      worker_id: workerId,
      claim_expires_at: claimExpiresAt,
    }, {
      eventId: callbackId,
      type: "run.claimed",
      workerId,
      occurredAt: now,
      recordedAt: now,
      payload,
    });
    if (updated.worker_id !== workerId) throw new ApiError(409, "RUN_CLAIMED", "Another worker already owns this run");
    return updated;
  } catch (error) {
    if (error instanceof RunTransitionError) {
      const latest = await getRun(env.DB, runId);
      if (latest?.status === "claimed" && latest.worker_id === workerId) return latest;
      if ((latest?.status === "claimed" || latest?.status === "running") && latest.worker_id !== workerId) {
        throw new ApiError(409, "RUN_CLAIMED", "Another worker already owns this run");
      }
    }
    throw error;
  }
}

async function parseCallbackBody<T>(
  request: Request,
  requestId: string,
  schema: CallbackSchema<T>,
  code: string,
  message: string,
): Promise<{ data: T }> {
  const result = schema.safeParse(await parseJsonBody(request, requestId));
  if (!result.success) throw new ApiError(422, code, message, validationDetails(result.error.issues));
  return { data: result.data };
}

function callbackReplayMatches(
  existing: RunEventRow | null,
  expectedType: string,
  workerId: string,
  payload: Record<string, unknown>,
  expectedStage?: string | null,
): boolean {
  if (!existing) return false;
  if (existing.type !== expectedType
    || existing.worker_id !== workerId
    || (expectedStage !== undefined && existing.stage !== expectedStage)
    || existing.payload_json !== stableStringify(payload)) {
    throw new ApiError(409, "CALLBACK_ID_REUSED", "callbackId was already used for a different callback");
  }
  return true;
}

async function requireActiveWorker(env: Env, runId: string, workerId: string): Promise<RunRow> {
  return requireOwnedWorker(env, runId, workerId, ["running", "cancel_requested"], "terminal");
}

async function requireWorkerOwnership(env: Env, runId: string, workerId: string): Promise<RunRow> {
  return requireOwnedWorker(env, runId, workerId, ["claimed", "running", "cancel_requested"], "cancellation");
}

async function requireOwnedWorker(
  env: Env,
  runId: string,
  workerId: string,
  acceptedStatuses: readonly RunRow["status"][],
  callbackKind: "terminal" | "cancellation",
): Promise<RunRow> {
  const row = await requireRun(env, runId);
  if (row.worker_id !== workerId) throw new ApiError(409, "WORKER_MISMATCH", "Worker does not own this run");
  if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") return row;
  if (!acceptedStatuses.includes(row.status)) {
    throw new ApiError(409, "INVALID_STATE_TRANSITION", `Run in ${row.status} state cannot accept a ${callbackKind} callback`);
  }
  return row;
}

function assertClaimIsLive(row: RunRow): void {
  if (!row.claim_expires_at || Date.parse(row.claim_expires_at) <= Date.now()) {
    throw new ApiError(409, "CLAIM_EXPIRED", "Worker claim expired before the terminal callback was recorded");
  }
}

async function ensureCallbackIdAvailable(
  env: Env,
  runId: string,
  callbackId: string,
  expectedType: string,
  workerId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const existing = await findRunEvent(env.DB, runId, callbackId);
  callbackReplayMatches(existing, expectedType, workerId, payload);
}

function callbackError(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) return error.toResponse(requestId);
  if (error instanceof RunNotFoundError) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
  if (error instanceof RunTransitionError) return errorResponse(requestId, 409, "INVALID_STATE_TRANSITION", `Run changed to ${error.current} before the callback was committed`);
  if (error instanceof RunEventError) {
    const code = error.code === "EVENT_ID_REUSED" ? "CALLBACK_ID_REUSED" : error.code;
    return errorResponse(requestId, 409, code, error.message);
  }
  return errorResponse(requestId, 503, "CALLBACK_UNAVAILABLE", "Soyuz cannot reach its run database to record the worker callback. Retry with the same callback ID.");
}

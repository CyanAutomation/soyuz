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
  parseEventPayload,
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
import { stableStringify } from "../lib/json";
import { ApiError, errorResponse, parseJsonBody, successResponse, validationDetails } from "./http";
import { publicRun } from "./runs";

export async function handleWorkerCallbacks(request: Request, env: Env, url: URL, requestId: string): Promise<Response | null> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "worker" || parts[2] !== "runs") return null;
  if (parts.length === 4 && request.method === "GET") {
    const runId = parts[3];
    if (!isRunId(runId)) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
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
      });
    } catch {
      return errorResponse(requestId, 503, "RUN_READ_UNAVAILABLE", "Soyuz cannot reach its run database to read canonical run state. Retry shortly.");
    }
  }
  if (parts.length !== 5) return null;
  const [, , , runId, action] = parts;
  if (!isRunId(runId)) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
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
    const body = await parseJsonBody(request, requestId);
    const payload = WorkerClaimSchema.safeParse(body);
    if (!payload.success) throw new ApiError(422, "INVALID_WORKER_CALLBACK", "Claim callback failed validation", validationDetails(payload.error.issues));
    const row = await getRun(env.DB, runId);
    if (!row) throw new ApiError(404, "RUN_NOT_FOUND", "Run was not found");
    const eventPayload = { leaseSeconds: payload.data.leaseSeconds };
    const previous = await findRunEvent(env.DB, runId, payload.data.callbackId);
    if (previous) {
      if (previous.type !== "run.claimed"
        || previous.worker_id !== payload.data.workerId
        || previous.payload_json !== stableStringify(eventPayload)) {
        throw new ApiError(409, "CALLBACK_ID_REUSED", "callbackId was already used for a different callback");
      }
      return successResponse(requestId, publicRun(row));
    }
    if ((row.status === "claimed" || row.status === "running") && row.worker_id === payload.data.workerId) {
      return successResponse(requestId, publicRun(row));
    }
    if (row.status === "claimed" || row.status === "running") {
      throw new ApiError(409, "RUN_CLAIMED", "Another worker already owns this run");
    }
    if (row.status !== "queued") {
      throw new ApiError(409, row.status === "cancelled" ? "RUN_CANCELLED" : "INVALID_STATE_TRANSITION", `Run in ${row.status} state cannot be claimed`);
    }

    const now = new Date().toISOString();
    const claimExpiresAt = new Date(Date.now() + payload.data.leaseSeconds * 1_000).toISOString();
    let updated: RunRow;
    try {
      updated = await transitionRun(env.DB, runId, "claimed", {
        worker_id: payload.data.workerId,
        claim_expires_at: claimExpiresAt,
      }, {
        eventId: payload.data.callbackId,
        type: "run.claimed",
        workerId: payload.data.workerId,
        occurredAt: now,
        recordedAt: now,
        payload: eventPayload,
      });
    } catch (error) {
      if (error instanceof RunTransitionError) {
        const latest = await getRun(env.DB, runId);
        if (latest?.status === "claimed" && latest.worker_id === payload.data.workerId) {
          return successResponse(requestId, publicRun(latest));
        }
      }
      throw error;
    }
    return successResponse(requestId, publicRun(updated));
  } catch (error) {
    return callbackError(error, requestId);
  }
}

async function started(request: Request, env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    const body = await parseJsonBody(request, requestId);
    const payload = WorkerStartedSchema.safeParse(body);
    if (!payload.success) throw new ApiError(422, "INVALID_WORKER_CALLBACK", "Started callback failed validation", validationDetails(payload.error.issues));
    const row = await getRun(env.DB, runId);
    if (!row) throw new ApiError(404, "RUN_NOT_FOUND", "Run was not found");
    if (row.worker_id && row.worker_id !== payload.data.workerId) {
      throw new ApiError(409, "WORKER_MISMATCH", "A different worker already owns this run");
    }
    const priorCallback = await findRunEvent(env.DB, runId, payload.data.callbackId);
    if (priorCallback) {
      if (priorCallback.type !== "run.started"
        || priorCallback.worker_id !== payload.data.workerId
        || priorCallback.stage !== (payload.data.stage ?? null)
        || priorCallback.payload_json !== stableStringify({ status: "running" })) {
        throw new ApiError(409, "CALLBACK_ID_REUSED", "callbackId was already used for a different callback");
      }
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
    const body = await parseJsonBody(request, requestId);
    const payload = WorkerEventSchema.safeParse(body);
    if (!payload.success) throw new ApiError(422, "INVALID_WORKER_EVENT", "Worker event failed validation", validationDetails(payload.error.issues));
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
    const body = await parseJsonBody(request, requestId);
    const payload = WorkerCompletedSchema.safeParse(body);
    if (!payload.success) throw new ApiError(422, "INVALID_WORKER_CALLBACK", "Completed callback failed validation", validationDetails(payload.error.issues));
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
    const body = await parseJsonBody(request, requestId);
    const payload = WorkerFailedSchema.safeParse(body);
    if (!payload.success) throw new ApiError(422, "INVALID_WORKER_CALLBACK", "Failed callback failed validation", validationDetails(payload.error.issues));
    const row = await requireActiveWorker(env, runId, payload.data.workerId);
    const eventPayload = {
      failureClass: payload.data.failureClass,
      failureMessage: payload.data.failureMessage,
      ...(payload.data.exitCode !== undefined ? { exitCode: payload.data.exitCode } : {}),
    };
    await ensureCallbackIdAvailable(env, runId, payload.data.callbackId, "run.failed", payload.data.workerId, eventPayload);
    if (row.status === "failed") return successResponse(requestId, publicRun(row));
    const now = new Date().toISOString();
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
    });
    return successResponse(requestId, publicRun(updated));
  } catch (error) {
    return callbackError(error, requestId);
  }
}

async function cancelled(request: Request, env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    const body = await parseJsonBody(request, requestId);
    const payload = WorkerCancelledSchema.safeParse(body);
    if (!payload.success) throw new ApiError(422, "INVALID_WORKER_CALLBACK", "Cancelled callback failed validation", validationDetails(payload.error.issues));
    const row = await requireActiveWorker(env, runId, payload.data.workerId);
    const eventPayload = {
      ...(payload.data.reason ? { reason: payload.data.reason } : {}),
      ...(payload.data.exitCode !== undefined ? { exitCode: payload.data.exitCode } : {}),
    };
    await ensureCallbackIdAvailable(env, runId, payload.data.callbackId, "run.cancelled", payload.data.workerId, eventPayload);
    if (row.status === "cancelled") return successResponse(requestId, publicRun(row));
    const now = new Date().toISOString();
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
    });
    return successResponse(requestId, publicRun(updated));
  } catch (error) {
    return callbackError(error, requestId);
  }
}

async function requireActiveWorker(env: Env, runId: string, workerId: string): Promise<RunRow> {
  const row = await getRun(env.DB, runId);
  if (!row) throw new ApiError(404, "RUN_NOT_FOUND", "Run was not found");
  if (row.worker_id !== workerId) throw new ApiError(409, "WORKER_MISMATCH", "Worker does not own this run");
  if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") return row;
  if (row.status !== "running" && row.status !== "cancel_requested") {
    throw new ApiError(409, "INVALID_STATE_TRANSITION", `Run in ${row.status} state cannot accept a terminal callback`);
  }
  return row;
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
  if (!existing) return;
  if (existing.type !== expectedType
    || existing.worker_id !== workerId
    || existing.payload_json !== stableStringify(payload)) {
    throw new ApiError(409, "CALLBACK_ID_REUSED", "callbackId was already used for a different callback");
  }
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

function publicEvent(row: RunEventRow): Record<string, unknown> {
  return {
    contractVersion: row.contract_version,
    runId: row.run_id,
    sequence: row.sequence,
    eventId: row.event_id,
    type: row.type,
    workerId: row.worker_id,
    stage: row.stage,
    step: row.step,
    timestamp: row.occurred_at,
    recordedAt: row.recorded_at,
    payload: parseEventPayload(row),
  };
}

function isRunId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

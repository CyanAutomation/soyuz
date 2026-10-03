import { IdempotencyKeySchema, RunRequestSchema, type RunRequest } from "../contracts/run-request";
import { CONTRACT_VERSION, type QueuedRun } from "../contracts/queue-message";
import { RUN_STATUSES, canTransition, type RunStatus } from "../domain/run-state-machine";
import {
  findRunEvent,
  getRun,
  getRunByIdempotencyKey,
  insertRun,
  listRunEvents,
  listRuns,
  parseEventPayload,
  parseRequest,
  parseResult,
  transitionRun,
  RunNotFoundError,
  RunTransitionError,
  type RunCursor,
  type RunEventInput,
  type RunEventRow,
  type RunRow,
} from "../db/runs";
import type { Env } from "../env";
import { sha256Hex, stableStringify } from "../lib/json";
import { createRunId } from "../lib/uuidv7";
import { ApiError, errorResponse, parseJsonBody, successResponse, validationDetails } from "./http";

const MAX_QUEUE_MESSAGE_BYTES = 96 * 1024;

export async function handleClientRuns(request: Request, env: Env, url: URL, requestId: string): Promise<Response | null> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/v1/runs" && request.method === "POST") {
    return submitRun(request, env, requestId);
  }
  if (url.pathname === "/v1/runs" && request.method === "GET") {
    return listRunRoute(url, env, requestId);
  }
  if (segments[0] !== "v1" || segments[1] !== "runs" || !segments[2]) return null;

  const runId = segments[2];
  if (!isRunId(runId)) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");

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
    const parsed = RunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, "INVALID_RUN_REQUEST", "Run request failed validation", validationDetails(parsed.error.issues));
    }

    let runRequest = parsed.data as RunRequest;
    if (runRequest.idempotencyKey) {
      runRequest = { ...runRequest, idempotencyKey: runRequest.idempotencyKey.toLowerCase() };
    }
    const headerKey = request.headers.get("idempotency-key");
    if (headerKey) {
      const normalizedHeaderKey = headerKey.toLowerCase();
      if (!IdempotencyKeySchema.safeParse(normalizedHeaderKey).success) {
        throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a UUID");
      }
      if (runRequest.idempotencyKey && runRequest.idempotencyKey.toLowerCase() !== normalizedHeaderKey) {
        throw new ApiError(400, "IDEMPOTENCY_KEY_MISMATCH", "Body idempotencyKey must match the Idempotency-Key header");
      }
      runRequest = { ...runRequest, idempotencyKey: normalizedHeaderKey };
    }

    const idempotencyKey = runRequest.idempotencyKey ?? null;
    const requestHash = await runRequestFingerprint(runRequest);
    if (idempotencyKey) {
      const existing = await getRunByIdempotencyKey(env.DB, idempotencyKey);
      if (existing) return replayOrConflict(existing, requestHash, requestId);
    }

    const now = new Date().toISOString();
    const runId = createRunId();
    const correlationId = runRequest.tracing?.correlationId ?? requestId;
    const traceRequestId = runRequest.tracing?.requestId ?? requestId;
    try {
      await insertRun(env.DB, {
        id: runId,
        request: runRequest,
        requestHash,
        idempotencyKey,
        correlationId,
        requestId: traceRequestId,
        createdAt: now,
      });
    } catch {
      if (idempotencyKey) {
        const raced = await getRunByIdempotencyKey(env.DB, idempotencyKey);
        if (raced) return replayOrConflict(raced, requestHash, requestId);
      }
      throw new ApiError(503, "RUN_PERSISTENCE_UNAVAILABLE", "Soyuz could not persist the run request");
    }

    const queuedRun: QueuedRun = {
      contractVersion: CONTRACT_VERSION,
      runId,
      createdAt: now,
      correlationId,
      requestId: traceRequestId,
      request: runRequest,
    };
    if (new TextEncoder().encode(JSON.stringify(queuedRun)).byteLength > MAX_QUEUE_MESSAGE_BYTES) {
      await failAdmission(env, runId, now, "queue_message_too_large", "Queue message exceeds the configured size limit");
      throw new ApiError(422, "RUN_REQUEST_TOO_LARGE", "Run request is too large for the queue contract", { runId });
    }

    try {
      await env.RUN_QUEUE.send(queuedRun, { contentType: "json" });
    } catch {
      // A send exception can mean that Queue accepted the message but its response was lost.
      // Keep the run admitting so reconciliation can safely retry with the same run ID.
      throw new ApiError(503, "QUEUE_PUBLISH_UNCERTAIN", "Soyuz could not confirm Queue publication; the run remains pending and will be reconciled. Retry with the same idempotency key", { runId });
    }

    const queuedAt = new Date().toISOString();
    let row: RunRow;
    try {
      row = await transitionRun(env.DB, runId, "queued", { queued_at: queuedAt }, {
        eventId: "system:admission:queued",
        type: "run.queued",
        occurredAt: queuedAt,
        recordedAt: queuedAt,
        payload: { queue: "soyuz-runs" },
      });
    } catch {
      const current = await getRun(env.DB, runId).catch(() => null);
      if (current?.status === "cancelled") return successResponse(requestId, publicRun(current), 202);
      throw new ApiError(503, "RUN_ADMISSION_PENDING", "Run publication succeeded but canonical status is being reconciled; retry with the same idempotency key", { runId });
    }
    return successResponse(requestId, publicRun(row), 202);
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse(requestId);
    return errorResponse(requestId, 503, "RUN_ADMISSION_UNAVAILABLE", "Soyuz could not complete run admission");
  }
}

async function runRequestFingerprint(request: RunRequest): Promise<string> {
  const { idempotencyKey: _key, tracing: _tracing, ...executionRequest } = request;
  return sha256Hex(stableStringify(executionRequest));
}

function replayOrConflict(row: RunRow, requestHash: string, requestId: string): Response {
  if (row.request_hash !== requestHash) {
    return errorResponse(requestId, 409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used with a different run request", { details: { runId: row.id } });
  }
  if (row.status === "admitting") {
    return errorResponse(requestId, 503, "RUN_ADMISSION_PENDING", "Run admission is still being reconciled; retry with the same idempotency key", { details: { runId: row.id } });
  }
  return successResponse(requestId, publicRun(row), 200);
}

async function failAdmission(env: Env, runId: string, now: string, failureClass: string, failureMessage: string): Promise<void> {
  await transitionRun(env.DB, runId, "admission_failed", {
    completed_at: now,
    failure_class: failureClass,
    failure_message: failureMessage,
  }, {
    eventId: "system:admission:failed",
    type: "run.admission_failed",
    occurredAt: now,
    recordedAt: now,
    payload: { failureClass },
  });
}

async function listRunRoute(url: URL, env: Env, requestId: string): Promise<Response> {
  const limitValue = url.searchParams.get("limit") ?? "25";
  const limit = Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return errorResponse(requestId, 400, "INVALID_LIMIT", "limit must be an integer from 1 to 100");
  }

  const rawStatus = url.searchParams.get("status");
  let status: RunStatus | undefined;
  if (rawStatus) {
    if (!(RUN_STATUSES as readonly string[]).includes(rawStatus)) {
      return errorResponse(requestId, 400, "INVALID_STATUS_FILTER", "status is not a supported run state");
    }
    status = rawStatus as RunStatus;
  }

  const rawCursor = url.searchParams.get("cursor");
  let cursor: RunCursor | undefined;
  if (rawCursor) {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return errorResponse(requestId, 400, "INVALID_CURSOR", "cursor is malformed");
  }

  try {
    const rows = await listRuns(env.DB, limit + 1, status, cursor);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return successResponse(requestId, {
      runs: page.map(publicRunSummary),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch {
    return errorResponse(requestId, 503, "RUN_LIST_UNAVAILABLE", "Soyuz could not read run history");
  }
}

async function getRunRoute(runId: string, env: Env, requestId: string): Promise<Response> {
  try {
    const row = await getRun(env.DB, runId);
    if (!row) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
    return successResponse(requestId, publicRun(row));
  } catch {
    return errorResponse(requestId, 503, "RUN_READ_UNAVAILABLE", "Soyuz could not read the run");
  }
}

async function getRunEventsRoute(runId: string, url: URL, env: Env, requestId: string): Promise<Response> {
  const afterText = url.searchParams.get("after") ?? "0";
  const limitText = url.searchParams.get("limit") ?? "100";
  const after = Number(afterText);
  const limit = Number(limitText);
  if (!Number.isSafeInteger(after) || after < 0) return errorResponse(requestId, 400, "INVALID_EVENT_CURSOR", "after must be a non-negative sequence number");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return errorResponse(requestId, 400, "INVALID_LIMIT", "limit must be an integer from 1 to 200");

  try {
    const run = await getRun(env.DB, runId);
    if (!run) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
    const events = await listRunEvents(env.DB, runId, after, limit);
    return successResponse(requestId, { events: events.map(publicEvent), nextAfter: events.at(-1)?.sequence ?? after });
  } catch {
    return errorResponse(requestId, 503, "RUN_EVENTS_UNAVAILABLE", "Soyuz could not read run events");
  }
}

async function cancelRun(runId: string, env: Env, requestId: string): Promise<Response> {
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await getRun(env.DB, runId);
      if (!row) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
      if (row.status === "cancel_requested" || row.status === "cancelled") {
        return successResponse(requestId, publicRun(row), 200);
      }
      if (!canTransition(row.status, "cancelled") && !canTransition(row.status, "cancel_requested")) {
        return errorResponse(requestId, 409, "RUN_ALREADY_TERMINAL", `Run in ${row.status} state cannot be cancelled`);
      }

      const now = new Date().toISOString();
      const target: RunStatus = row.status === "running" ? "cancel_requested" : "cancelled";
      const event: RunEventInput = {
        eventId: `system:cancel:${target}`,
        type: target === "cancel_requested" ? "run.cancel_requested" : "run.cancelled",
        occurredAt: now,
        recordedAt: now,
        payload: { requestedBy: "client" },
      };
      try {
        const updated = await transitionRun(env.DB, runId, target, {
          cancel_requested_at: now,
          ...(target === "cancelled" ? { completed_at: now, claim_expires_at: null } : {}),
        }, event, { expectedStatus: row.status });
        return successResponse(requestId, publicRun(updated), 202);
      } catch (error) {
        if (!(error instanceof RunTransitionError) || attempt === 2) throw error;
        // Re-read and choose the cancellation transition from the new canonical state.
      }
    }
    return errorResponse(requestId, 409, "INVALID_STATE_TRANSITION", "Run changed before cancellation completed");
  } catch (error) {
    if (error instanceof RunNotFoundError) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
    if (error instanceof RunTransitionError) return errorResponse(requestId, 409, "INVALID_STATE_TRANSITION", `Run changed to ${error.current} before cancellation completed`);
    return errorResponse(requestId, 503, "CANCEL_UNAVAILABLE", "Soyuz could not record the cancellation request");
  }
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
    exitCode: row.exit_code,
    failureClass: row.failure_class,
  };
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

function encodeCursor(row: RunRow): string {
  const value = btoa(`${row.created_at}\n${row.id}`);
  return value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeCursor(value: string): RunCursor | undefined {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const [createdAt, id, extra] = atob(base64).split("\n");
    if (extra !== undefined || !createdAt || !isRunId(id)) return undefined;
    const date = new Date(createdAt);
    if (Number.isNaN(date.valueOf()) || date.toISOString() !== createdAt) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

function isRunId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

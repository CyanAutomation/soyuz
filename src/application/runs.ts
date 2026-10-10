import { IdempotencyKeySchema, RunRequestSchema, type RunRequest } from "../contracts/run-request";
import { CONTRACT_VERSION, type QueuedRun } from "../contracts/queue-message";
import { RUN_STATUSES, canTransition, type RunStatus } from "../domain/run-state-machine";
import {
  getRun as getRunRow,
  getRunByIdempotencyKey,
  insertRun,
  listRunEvents,
  listRuns as listRunRows,
  RunNotFoundError,
  RunTransitionError,
  transitionRun,
  type RunPatch,
  type RunCursor,
  type RunEventInput,
  type RunEventRow,
  type RunRow,
} from "../db/runs";
import type { Env } from "../env";
import { stableStringify } from "../lib/canonical-json";
import { sha256Hex } from "../lib/sha256";
import { isUuid } from "../lib/uuid";
import { createRunId } from "../lib/uuidv7";

const MAX_QUEUE_MESSAGE_BYTES = 96 * 1024;

export class RunApplicationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly details?: unknown,
    readonly retryable = status >= 500,
  ) {
    super(publicMessage);
  }
}

export interface RunAdmission {
  row: RunRow;
  statusCode: 200 | 202;
}

export interface RunListPage {
  rows: RunRow[];
  nextCursor: string | null;
}

export interface RunEventsPage {
  run: RunRow;
  events: RunEventRow[];
  nextAfter: number;
}

export async function createRun(
  env: Env,
  input: unknown,
  requestId: string,
  headerIdempotencyKey?: string | null,
): Promise<RunAdmission> {
  try {
    const runRequest = parseRunRequest(input, headerIdempotencyKey);
    const idempotencyKey = runRequest.idempotencyKey ?? null;
    const requestHash = await runRequestFingerprint(runRequest);
    if (idempotencyKey) {
      const existing = await getRunByIdempotencyKey(env.DB, idempotencyKey);
      if (existing) return replayOrConflict(existing, requestHash);
    }

    const now = new Date().toISOString();
    const runId = createRunId();
    const correlationId = runRequest.tracing?.correlationId ?? requestId;
    const traceRequestId = runRequest.tracing?.requestId ?? requestId;
    const replay = await insertRunOrReplay(env, {
      runId,
      runRequest,
      requestHash,
      idempotencyKey,
      correlationId,
      requestId: traceRequestId,
      createdAt: now,
    });
    if (replay) return replay;

    const queuedRun: QueuedRun = {
      contractVersion: CONTRACT_VERSION,
      runId,
      createdAt: now,
      correlationId,
      requestId: traceRequestId,
      request: runRequest,
    };
    await publishQueuedRun(env, runId, now, queuedRun);
    return markAdmissionQueued(env, runId);
  } catch (error) {
    if (error instanceof RunApplicationError) throw error;
    throw new RunApplicationError(503, "RUN_ADMISSION_UNAVAILABLE", "Soyuz could not reach a required service to accept the run. Retry shortly; if this continues, contact the service administrator.", undefined, true);
  }
}

function parseRunRequest(input: unknown, headerIdempotencyKey?: string | null): RunRequest {
  const parsed = RunRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RunApplicationError(
      422,
      "INVALID_RUN_REQUEST",
      "Run request failed validation",
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }

  let runRequest = parsed.data as RunRequest;
  if (runRequest.idempotencyKey) {
    runRequest = { ...runRequest, idempotencyKey: runRequest.idempotencyKey.toLowerCase() };
  }
  if (!headerIdempotencyKey) return runRequest;

  const normalizedHeaderKey = headerIdempotencyKey.toLowerCase();
  if (!IdempotencyKeySchema.safeParse(normalizedHeaderKey).success) {
    throw new RunApplicationError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a UUID");
  }
  if (runRequest.idempotencyKey && runRequest.idempotencyKey !== normalizedHeaderKey) {
    throw new RunApplicationError(
      400,
      "IDEMPOTENCY_KEY_MISMATCH",
      "Body idempotencyKey must match the Idempotency-Key header",
    );
  }
  return { ...runRequest, idempotencyKey: normalizedHeaderKey };
}

interface RunPersistenceInput {
  runId: string;
  runRequest: RunRequest;
  requestHash: string;
  idempotencyKey: string | null;
  correlationId: string;
  requestId: string;
  createdAt: string;
}

async function insertRunOrReplay(env: Env, input: RunPersistenceInput): Promise<RunAdmission | null> {
  try {
    await insertRun(env.DB, {
      id: input.runId,
      request: input.runRequest,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      requestId: input.requestId,
      createdAt: input.createdAt,
    });
  } catch {
    if (input.idempotencyKey) {
      const raced = await getRunByIdempotencyKey(env.DB, input.idempotencyKey);
      if (raced) return replayOrConflict(raced, input.requestHash);
    }
    throw new RunApplicationError(
      503,
      "RUN_PERSISTENCE_UNAVAILABLE",
      "Soyuz could not save the run request. Retry shortly with the same Idempotency-Key.",
      undefined,
      true,
    );
  }
  return null;
}

async function publishQueuedRun(env: Env, runId: string, now: string, queuedRun: QueuedRun): Promise<void> {
  if (new TextEncoder().encode(JSON.stringify(queuedRun)).byteLength > MAX_QUEUE_MESSAGE_BYTES) {
    await failAdmission(env, runId, now, "queue_message_too_large", "Queue message exceeds the configured size limit");
    throw new RunApplicationError(
      422,
      "RUN_REQUEST_TOO_LARGE",
      "Run request is too large for the queue contract",
      { runId },
    );
  }

  try {
    await env.RUN_QUEUE.send(queuedRun, { contentType: "json" });
  } catch {
    throw new RunApplicationError(
      503,
      "QUEUE_PUBLISH_UNCERTAIN",
      "Soyuz could not confirm Queue publication. The run remains pending while Soyuz retries. Retry with the same Idempotency-Key to avoid creating duplicate work.",
      { runId },
      true,
    );
  }
}

async function markAdmissionQueued(env: Env, runId: string): Promise<RunAdmission> {
  const queuedAt = new Date().toISOString();
  try {
    const row = await transitionRun(env.DB, runId, "queued", { queued_at: queuedAt }, {
      eventId: "system:admission:queued",
      type: "run.queued",
      occurredAt: queuedAt,
      recordedAt: queuedAt,
      payload: { queue: "soyuz-runs" },
    });
    return { row, statusCode: 202 };
  } catch {
    const current = await getRunRow(env.DB, runId).catch(() => null);
    if (current?.status === "cancelled") return { row: current, statusCode: 202 };
    throw new RunApplicationError(
      503,
      "RUN_ADMISSION_PENDING",
      "Run publication succeeded but canonical status is being reconciled; retry with the same idempotency key",
      { runId },
      true,
    );
  }
}

export async function listRunsPage(
  env: Env,
  query: { limit?: string | number | null; status?: string | null; cursor?: string | null },
): Promise<RunListPage> {
  const limitValue = query.limit ?? "25";
  const limit = Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RunApplicationError(400, "INVALID_LIMIT", "limit must be an integer from 1 to 100");
  }

  let status: RunStatus | undefined;
  if (query.status) {
    if (!(RUN_STATUSES as readonly string[]).includes(query.status)) {
      throw new RunApplicationError(400, "INVALID_STATUS_FILTER", "status is not a supported run state");
    }
    status = query.status as RunStatus;
  }

  let cursor: RunCursor | undefined;
  if (query.cursor) {
    cursor = decodeCursor(query.cursor);
    if (!cursor) throw new RunApplicationError(400, "INVALID_CURSOR", "cursor is malformed");
  }

  try {
    const rows = await listRunRows(env.DB, limit + 1, status, cursor);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      rows: page,
      nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
    };
  } catch {
    throw new RunApplicationError(503, "RUN_LIST_UNAVAILABLE", "Soyuz cannot reach its run database to read run history. Retry shortly.", undefined, true);
  }
}

export async function readRun(env: Env, runId: string): Promise<RunRow> {
  try {
    const row = await getRunRow(env.DB, runId);
    if (!row) throw new RunApplicationError(404, "RUN_NOT_FOUND", "Run was not found");
    return row;
  } catch (error) {
    if (error instanceof RunApplicationError) throw error;
    throw new RunApplicationError(503, "RUN_READ_UNAVAILABLE", "Soyuz cannot reach its run database to read this run. Retry shortly.", undefined, true);
  }
}

export async function readRunEventsPage(
  env: Env,
  runId: string,
  query: { after?: string | number | null; limit?: string | number | null },
): Promise<RunEventsPage> {
  const afterValue = query.after ?? "0";
  const limitValue = query.limit ?? "100";
  const after = Number(afterValue);
  const limit = Number(limitValue);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new RunApplicationError(400, "INVALID_EVENT_CURSOR", "after must be a non-negative sequence number");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RunApplicationError(400, "INVALID_LIMIT", "limit must be an integer from 1 to 200");
  }

  try {
    const run = await getRunRow(env.DB, runId);
    if (!run) throw new RunApplicationError(404, "RUN_NOT_FOUND", "Run was not found");
    const events = await listRunEvents(env.DB, runId, after, limit);
    return { run, events, nextAfter: events.at(-1)?.sequence ?? after };
  } catch (error) {
    if (error instanceof RunApplicationError) throw error;
    throw new RunApplicationError(503, "RUN_EVENTS_UNAVAILABLE", "Soyuz cannot reach its run database to read run events. Retry shortly.", undefined, true);
  }
}

export async function requestRunCancellation(
  env: Env,
  runId: string,
  requestedBy = "client",
): Promise<{ row: RunRow; statusCode: 200 | 202 }> {
  try {
    return await retryCancellation(env, runId, requestedBy);
  } catch (error) {
    if (error instanceof RunApplicationError) throw error;
    if (error instanceof RunNotFoundError) throw new RunApplicationError(404, "RUN_NOT_FOUND", "Run was not found");
    if (error instanceof RunTransitionError) {
      throw new RunApplicationError(409, "INVALID_STATE_TRANSITION", `Run changed to ${error.current} before cancellation completed`);
    }
    throw new RunApplicationError(503, "CANCEL_UNAVAILABLE", "Soyuz cannot reach its run database to record the cancellation request. Retry shortly.", undefined, true);
  }
}

async function retryCancellation(
  env: Env,
  runId: string,
  requestedBy: string,
): Promise<{ row: RunRow; statusCode: 200 | 202 }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await cancelOnce(env, runId, requestedBy);
    } catch (error) {
      if (!(error instanceof RunTransitionError) || attempt === 2) throw error;
      // Re-read canonical state and choose the cancellation transition again.
    }
  }
  throw new RunApplicationError(409, "INVALID_STATE_TRANSITION", "Run changed before cancellation completed");
}

async function cancelOnce(
  env: Env,
  runId: string,
  requestedBy: string,
): Promise<{ row: RunRow; statusCode: 200 | 202 }> {
  const row = await getRunRow(env.DB, runId);
  if (!row) throw new RunApplicationError(404, "RUN_NOT_FOUND", "Run was not found");
  if (row.status === "cancel_requested" || row.status === "cancelled") return { row, statusCode: 200 };

  const now = new Date().toISOString();
  const transition = cancellationTransition(row.status, requestedBy, now);
  const updated = await transitionRun(
    env.DB,
    runId,
    transition.target,
    transition.patch,
    transition.event,
    { expectedStatus: row.status },
  );
  return { row: updated, statusCode: 202 };
}

function cancellationTransition(
  status: RunStatus,
  requestedBy: string,
  now: string,
): { target: RunStatus; patch: RunPatch; event: RunEventInput } {
  if (!canTransition(status, "cancelled") && !canTransition(status, "cancel_requested")) {
    throw new RunApplicationError(409, "RUN_ALREADY_TERMINAL", `Run in ${status} state cannot be cancelled`);
  }
  const target: RunStatus = status === "running" ? "cancel_requested" : "cancelled";
  return {
    target,
    patch: {
      cancel_requested_at: now,
      ...(target === "cancelled" ? { completed_at: now, claim_expires_at: null } : {}),
    },
    event: {
      eventId: `system:cancel:${target}`,
      type: target === "cancel_requested" ? "run.cancel_requested" : "run.cancelled",
      occurredAt: now,
      recordedAt: now,
      payload: { requestedBy },
    },
  };
}

async function runRequestFingerprint(request: RunRequest): Promise<string> {
  const { idempotencyKey: _key, tracing: _tracing, ...executionRequest } = request;
  return sha256Hex(stableStringify(executionRequest));
}

function replayOrConflict(row: RunRow, requestHash: string): RunAdmission {
  if (row.request_hash !== requestHash) {
    throw new RunApplicationError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was already used with a different run request",
      { runId: row.id },
    );
  }
  if (row.status === "admitting") {
    throw new RunApplicationError(
      503,
      "RUN_ADMISSION_PENDING",
      "Run admission is still being reconciled; retry with the same idempotency key",
      { runId: row.id },
      true,
    );
  }
  return { row, statusCode: 200 };
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

function encodeCursor(row: RunRow): string {
  const value = btoa(`${row.created_at}\n${row.id}`);
  return value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeCursor(value: string): RunCursor | undefined {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const [createdAt, id, extra] = atob(base64).split("\n");
    if (extra !== undefined || !createdAt || !isUuid(id)) return undefined;
    const date = new Date(createdAt);
    if (Number.isNaN(date.valueOf()) || date.toISOString() !== createdAt) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

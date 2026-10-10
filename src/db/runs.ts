import type { RunRequest } from "../contracts/run-request";
import { CONTRACT_VERSION } from "../contracts/queue-message";
import { canTransition, type RunStatus } from "../domain/run-state-machine";
import { stableStringify } from "../lib/canonical-json";

export interface RunRow {
  id: string;
  contract_version: string;
  repo_url: string;
  git_ref: string;
  project_name: string | null;
  status: RunStatus;
  stage: string | null;
  task_mode: "patch" | "inspect";
  publish_mode: "auto" | "none" | "branch" | "pr";
  request_json: string;
  request_hash: string;
  result_json: string | null;
  created_at: string;
  queued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  worker_id: string | null;
  claim_expires_at: string | null;
  exit_code: number | null;
  failure_class: string | null;
  failure_message: string | null;
  cancel_requested_at: string | null;
  idempotency_key: string | null;
  correlation_id: string;
  request_id: string;
  admission_attempts: number;
  admission_last_attempt_at: string | null;
  last_heartbeat_at: string | null;
  operational_health: "unknown" | "healthy" | "suspect_stalled";
  /** Event ID of the currently valid claim attempt, derived from append-only run_events. */
  claim_callback_id?: string | null;
}

export interface RunEventRow {
  sequence: number;
  run_id: string;
  contract_version: string;
  event_id: string;
  type: string;
  worker_id: string | null;
  stage: string | null;
  step: string | null;
  occurred_at: string;
  recorded_at: string;
  payload_json: string;
}

export interface RunEventInput {
  eventId: string;
  type: string;
  workerId?: string | null;
  claimCallbackId?: string;
  stage?: string | null;
  step?: string | null;
  occurredAt: string;
  recordedAt: string;
  payload: Record<string, unknown>;
}

export type RunPatch = Partial<Pick<RunRow,
  | "stage"
  | "queued_at"
  | "started_at"
  | "completed_at"
  | "worker_id"
  | "claim_expires_at"
  | "exit_code"
  | "failure_class"
  | "failure_message"
  | "cancel_requested_at"
  | "result_json"
  | "admission_attempts"
  | "admission_last_attempt_at"
  | "last_heartbeat_at"
  | "operational_health"
>>;

const RUN_PATCH_COLUMNS: ReadonlySet<keyof RunPatch> = new Set([
  "stage",
  "queued_at",
  "started_at",
  "completed_at",
  "worker_id",
  "claim_expires_at",
  "exit_code",
  "failure_class",
  "failure_message",
  "cancel_requested_at",
  "result_json",
  "admission_attempts",
  "admission_last_attempt_at",
  "last_heartbeat_at",
  "operational_health",
]);

export class RunNotFoundError extends Error {}

export class RunTransitionError extends Error {
  constructor(readonly current: RunStatus, readonly requested: RunStatus) {
    super(`Cannot transition run from ${current} to ${requested}`);
  }
}

export class RunEventError extends Error {
  constructor(readonly code: "WORKER_MISMATCH" | "RUN_NOT_ACTIVE" | "EVENT_ID_REUSED" | "CLAIM_EXPIRED" | "STALE_CLAIM", message: string) {
    super(message);
  }
}

export async function getRun(db: D1Database, id: string): Promise<RunRow | null> {
  return db.prepare(`
    SELECT runs.*,
      (SELECT event_id FROM run_events
       WHERE run_id = runs.id AND type = 'run.claimed'
       ORDER BY sequence DESC LIMIT 1) AS claim_callback_id
    FROM runs WHERE id = ?
  `).bind(id).first<RunRow>();
}

export async function getRunByIdempotencyKey(db: D1Database, key: string): Promise<RunRow | null> {
  return db.prepare("SELECT * FROM runs WHERE idempotency_key = ?").bind(key).first<RunRow>();
}

export async function insertRun(
  db: D1Database,
  input: {
    id: string;
    request: RunRequest;
    requestHash: string;
    idempotencyKey: string | null;
    correlationId: string;
    requestId: string;
    createdAt: string;
  },
): Promise<void> {
  const { id, request, requestHash, idempotencyKey, correlationId, requestId, createdAt } = input;
  const initialEvent: RunEventInput = {
    eventId: "system:admission:started",
    type: "run.admitting",
    occurredAt: createdAt,
    recordedAt: createdAt,
    payload: { status: "admitting" },
  };

  await db.batch([
    db.prepare(`
      INSERT INTO runs (
        id, contract_version, repo_url, git_ref, project_name, status, task_mode,
        publish_mode, request_json, request_hash, created_at, updated_at,
        idempotency_key, correlation_id, request_id, admission_attempts,
        admission_last_attempt_at
      ) VALUES (?, ?, ?, ?, ?, 'admitting', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      id,
      CONTRACT_VERSION,
      request.repoUrl,
      request.ref,
      request.projectName ?? null,
      request.taskMode,
      request.publishMode,
      stableStringify(request),
      requestHash,
      createdAt,
      createdAt,
      idempotencyKey,
      correlationId,
      requestId,
      createdAt,
    ),
    eventStatement(db, id, initialEvent),
  ]);
}

export async function transitionRun(
  db: D1Database,
  id: string,
  to: RunStatus,
  patch: RunPatch,
  event: RunEventInput,
  guard?: { claimOwner?: string; claimNotExpiredAt?: string; claimCallbackId?: string; expectedStatus?: RunStatus },
): Promise<RunRow> {
  const current = await getRun(db, id);
  if (!current) throw new RunNotFoundError(`Run ${id} was not found`);
  if (guard?.expectedStatus && current.status !== guard.expectedStatus) {
    throw new RunTransitionError(current.status, to);
  }
  if (guard?.claimCallbackId && current.claim_callback_id !== guard.claimCallbackId) {
    throw new RunEventError("STALE_CLAIM", "Worker claim was superseded by a newer execution attempt");
  }
  if (current.status === to) return current;
  if (!canTransition(current.status, to)) throw new RunTransitionError(current.status, to);

  const assignments = ["status = ?", "updated_at = ?"];
  const values: Array<string | number | null> = [to, event.recordedAt];
  for (const [column, value] of Object.entries(patch) as Array<[keyof RunPatch, string | number | null]>) {
    if (value === undefined) continue;
    if (!RUN_PATCH_COLUMNS.has(column)) throw new Error(`Invalid run patch column: ${String(column)}`);
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  let where = "id = ? AND status = ?";
  values.push(id, current.status);
  if (guard?.claimOwner) {
    where += " AND worker_id = ?";
    values.push(guard.claimOwner);
  }
  if (guard?.claimNotExpiredAt) {
    where += " AND julianday(claim_expires_at) > julianday(?)";
    values.push(guard.claimNotExpiredAt);
  }
  if (guard?.claimCallbackId) {
    where += " AND ? = (SELECT event_id FROM run_events WHERE run_id = ? AND type = 'run.claimed' ORDER BY sequence DESC LIMIT 1)";
    values.push(guard.claimCallbackId, id);
  }

  const results = await db.batch([
    db.prepare(`UPDATE runs SET ${assignments.join(", ")} WHERE ${where}`).bind(...values),
    eventStatement(db, id, event, to, true),
  ]);

  const changed = Number(results[0]?.meta?.changes ?? 0);
  const latest = await getRun(db, id);
  if (!latest) throw new RunNotFoundError(`Run ${id} was not found`);
  if (guard?.claimCallbackId && latest.claim_callback_id !== guard.claimCallbackId) {
    throw new RunEventError("STALE_CLAIM", "Worker claim was superseded by a newer execution attempt");
  }
  if (changed === 0 && latest.status !== to) throw new RunTransitionError(latest.status, to);
  return latest;
}

export async function updateStartedRun(
  db: D1Database,
  id: string,
  workerId: string,
  startedAt: string,
  stage: string | null,
  event: RunEventInput,
  claimCallbackId?: string,
): Promise<RunRow> {
  const current = await getRun(db, id);
  if (!current) throw new RunNotFoundError(`Run ${id} was not found`);
  if (current.worker_id && current.worker_id !== workerId) {
    throw new RunEventError("WORKER_MISMATCH", "A different worker already owns this run");
  }
  if (claimCallbackId && current.claim_callback_id !== claimCallbackId) {
    throw new RunEventError("STALE_CLAIM", "Worker claim was superseded by a newer execution attempt");
  }

  if (current.status === "claimed") {
    if (!current.claim_expires_at || Date.parse(current.claim_expires_at) <= Date.parse(event.recordedAt)) {
      throw new RunEventError("CLAIM_EXPIRED", "Worker claim expired before the run started");
    }
    try {
      return await transitionRun(db, id, "running", {
        worker_id: workerId,
        started_at: current.started_at ?? startedAt,
        stage: stage ?? current.stage,
        claim_expires_at: null,
        last_heartbeat_at: event.recordedAt,
        operational_health: "healthy",
      }, event, { claimOwner: workerId, claimNotExpiredAt: event.recordedAt, claimCallbackId });
    } catch (error) {
      if (error instanceof RunTransitionError && error.current === "claimed") {
        const latest = await getRun(db, id);
        if (claimCallbackId && latest?.claim_callback_id !== claimCallbackId) {
          throw new RunEventError("STALE_CLAIM", "Worker claim was superseded by a newer execution attempt");
        }
        if (latest?.claim_expires_at && Date.parse(latest.claim_expires_at) <= Date.parse(event.recordedAt)) {
          throw new RunEventError("CLAIM_EXPIRED", "Worker claim expired before the run started");
        }
      }
      throw error;
    }
  }

  throw new RunEventError("RUN_NOT_ACTIVE", "Run is not in a state that accepts a started callback");
}

function eventStatement(
  db: D1Database,
  runId: string,
  event: RunEventInput,
  requiredStatus?: RunStatus,
  requirePriorChange = false,
): D1PreparedStatement {
  const condition = requiredStatus ? " AND status = ?" : "";
  const changedCondition = requirePriorChange ? "changes() = 1 AND " : "";
  const parameters: Array<string | null> = [
    runId,
    CONTRACT_VERSION,
    event.eventId,
    event.type,
    event.workerId ?? null,
    event.stage ?? null,
    event.step ?? null,
    event.occurredAt,
    event.recordedAt,
    stableStringify(event.payload),
    runId,
  ];
  if (requiredStatus) parameters.push(requiredStatus);
  return db.prepare(`
    INSERT OR IGNORE INTO run_events (
      run_id, contract_version, event_id, type, worker_id, stage, step,
      occurred_at, recorded_at, payload_json
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${changedCondition}EXISTS (SELECT 1 FROM runs WHERE id = ?${condition})
  `).bind(...parameters);
}

export async function findRunEvent(db: D1Database, runId: string, eventId: string): Promise<RunEventRow | null> {
  return db.prepare("SELECT * FROM run_events WHERE run_id = ? AND event_id = ?").bind(runId, eventId).first<RunEventRow>();
}

export async function recordWorkerEvent(db: D1Database, runId: string, input: RunEventInput): Promise<RunEventRow> {
  const current = await getRun(db, runId);
  if (!current) throw new RunNotFoundError(`Run ${runId} was not found`);
  if (current.worker_id !== input.workerId) {
    throw new RunEventError("WORKER_MISMATCH", "Worker does not own this run");
  }
  if (input.claimCallbackId && current.claim_callback_id !== input.claimCallbackId) {
    throw new RunEventError("STALE_CLAIM", "Worker claim was superseded by a newer execution attempt");
  }
  const existing = await findRunEvent(db, runId, input.eventId);
  if (existing) {
    assertSameEvent(existing, input);
    await updateLatestStage(db, runId, input);
    return existing;
  }
  if (current.status !== "running" && current.status !== "cancel_requested") {
    throw new RunEventError("RUN_NOT_ACTIVE", "Run no longer accepts operational events");
  }

  const claimGuard = input.claimCallbackId
    ? " AND ? = (SELECT event_id FROM run_events WHERE run_id = ? AND type = 'run.claimed' ORDER BY sequence DESC LIMIT 1)"
    : "";
  const insertParameters: Array<string | null> = [
    runId,
    CONTRACT_VERSION,
    input.eventId,
    input.type,
    input.workerId ?? null,
    input.stage ?? null,
    input.step ?? null,
    input.occurredAt,
    input.recordedAt,
    stableStringify(input.payload),
    runId,
    input.workerId ?? "",
  ];
  if (input.claimCallbackId) insertParameters.push(input.claimCallbackId, runId);
  const inserted = await db.prepare(`
    INSERT OR IGNORE INTO run_events (
      run_id, contract_version, event_id, type, worker_id, stage, step,
      occurred_at, recorded_at, payload_json
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM runs WHERE id = ? AND worker_id = ?
        AND status IN ('running', 'cancel_requested')
    )${claimGuard}
  `).bind(...insertParameters).run();

  const saved = await findRunEvent(db, runId, input.eventId);
  if (!saved) {
    const latest = await getRun(db, runId);
    if (input.claimCallbackId && latest?.claim_callback_id !== input.claimCallbackId) {
      throw new RunEventError("STALE_CLAIM", "Worker claim was superseded by a newer execution attempt");
    }
    if (latest?.worker_id !== input.workerId) {
      throw new RunEventError("WORKER_MISMATCH", "Worker does not own this run");
    }
    throw new RunEventError("RUN_NOT_ACTIVE", "Run no longer accepts operational events");
  }
  assertSameEvent(saved, input);
  if (Number(inserted.meta.changes ?? 0) > 0 || input.type === "stage.changed") {
    await updateLatestStage(db, runId, input);
  }
  if (input.type === "worker.heartbeat") {
    const heartbeatClaimGuard = input.claimCallbackId
      ? " AND ? = (SELECT event_id FROM run_events WHERE run_id = ? AND type = 'run.claimed' ORDER BY sequence DESC LIMIT 1)"
      : "";
    const heartbeatParameters: Array<string | number> = [
      input.recordedAt,
      input.recordedAt,
      runId,
      input.workerId ?? "",
      input.recordedAt,
    ];
    if (input.claimCallbackId) heartbeatParameters.push(input.claimCallbackId, runId);
    await db.prepare(`
      UPDATE runs SET last_heartbeat_at = ?, operational_health = 'healthy', updated_at = ?
      WHERE id = ? AND worker_id = ? AND status IN ('running', 'cancel_requested')
        AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at) <= julianday(?))
      ${heartbeatClaimGuard}
    `).bind(...heartbeatParameters).run();
  }
  return saved;
}

export async function listStaleRunningRuns(
  db: D1Database,
  olderThan: string,
  limit: number,
): Promise<RunRow[]> {
  const rows = await db.prepare(`
    SELECT * FROM runs
    WHERE status IN ('running', 'cancel_requested')
      AND operational_health != 'suspect_stalled'
      AND COALESCE(last_heartbeat_at, started_at) <= ?
    ORDER BY COALESCE(last_heartbeat_at, started_at) ASC
    LIMIT ?
  `).bind(olderThan, limit).all<RunRow>();
  return rows.results;
}

/** Mark stale liveness as a health classification without changing lifecycle status or requeueing. */
export async function markRunSuspectedStalled(
  db: D1Database,
  row: RunRow,
  observedAt: string,
): Promise<boolean> {
  const heartbeatAt = row.last_heartbeat_at ?? row.started_at;
  if (!heartbeatAt) return false;
  const eventId = `system:stalled:${heartbeatAt}`;
  const payload = stableStringify({
    lastHeartbeatAt: row.last_heartbeat_at,
    startedAt: row.started_at,
    observedAt,
    automaticRetry: false,
  });
  const results = await db.batch([
    db.prepare(`
      UPDATE runs SET operational_health = 'suspect_stalled', updated_at = ?
      WHERE id = ? AND status IN ('running', 'cancel_requested')
        AND operational_health != 'suspect_stalled'
        AND COALESCE(last_heartbeat_at, started_at) = ?
    `).bind(observedAt, row.id, heartbeatAt),
    db.prepare(`
      INSERT INTO run_events (
        run_id, contract_version, event_id, type, worker_id, stage, step,
        occurred_at, recorded_at, payload_json
      )
      SELECT id, ?, ?, 'run.suspected_stalled', worker_id, stage, NULL, ?, ?, ?
      FROM runs WHERE id = ? AND operational_health = 'suspect_stalled'
      ON CONFLICT(run_id, event_id) DO NOTHING
    `).bind(CONTRACT_VERSION, eventId, heartbeatAt, observedAt, payload, row.id),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) === 1;
}

function assertSameEvent(saved: RunEventRow, input: RunEventInput): void {
  const same = saved.type === input.type
    && saved.worker_id === (input.workerId ?? null)
    && saved.stage === (input.stage ?? null)
    && saved.step === (input.step ?? null)
    && saved.payload_json === stableStringify(input.payload);
  if (!same) throw new RunEventError("EVENT_ID_REUSED", "eventId was already used for a different event");
}

async function updateLatestStage(db: D1Database, runId: string, input: RunEventInput): Promise<void> {
  if (input.type !== "stage.changed" || !input.stage) return;
  await db.prepare(`
    UPDATE runs SET stage = ?, updated_at = ?
    WHERE id = ? AND status IN ('running', 'cancel_requested')
      AND worker_id = ?
      AND ? = (
        SELECT event_id FROM run_events
        WHERE run_id = ? AND type = 'stage.changed'
        ORDER BY sequence DESC LIMIT 1
      )
  `).bind(input.stage, input.recordedAt, runId, input.workerId ?? "", input.eventId, runId).run();
}

export interface RunCursor {
  createdAt: string;
  id: string;
}

export async function listRuns(
  db: D1Database,
  limit: number,
  status?: RunStatus,
  cursor?: RunCursor,
): Promise<RunRow[]> {
  const rows = await db.prepare(`
    SELECT * FROM runs
    WHERE (? IS NULL OR status = ?)
      AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).bind(
    status ?? null,
    status ?? null,
    cursor ? 1 : null,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    limit,
  ).all<RunRow>();
  return rows.results;
}

export async function listRunEvents(db: D1Database, runId: string, after: number, limit: number): Promise<RunEventRow[]> {
  const rows = await db.prepare(`
    SELECT * FROM run_events WHERE run_id = ? AND sequence > ?
    ORDER BY sequence ASC LIMIT ?
  `).bind(runId, after, limit).all<RunEventRow>();
  return rows.results;
}

export async function listStaleAdmissions(db: D1Database, olderThan: string, limit: number): Promise<RunRow[]> {
  const rows = await db.prepare(`
    SELECT * FROM runs
    WHERE status = 'admitting' AND admission_last_attempt_at <= ?
    ORDER BY admission_last_attempt_at ASC LIMIT ?
  `).bind(olderThan, limit).all<RunRow>();
  return rows.results;
}

export async function listExpiredClaims(db: D1Database, at: string, limit: number): Promise<RunRow[]> {
  const rows = await db.prepare(`
    SELECT * FROM runs WHERE status = 'claimed' AND claim_expires_at <= ?
    ORDER BY claim_expires_at ASC LIMIT ?
  `).bind(at, limit).all<RunRow>();
  return rows.results;
}

export async function reserveAdmissionRetry(db: D1Database, run: RunRow, attemptedAt: string): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE runs SET admission_attempts = admission_attempts + 1,
      admission_last_attempt_at = ?, updated_at = ?
    WHERE id = ? AND status = 'admitting' AND admission_last_attempt_at = ?
  `).bind(attemptedAt, attemptedAt, run.id, run.admission_last_attempt_at).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export function parseRequest(row: RunRow): RunRequest {
  return JSON.parse(row.request_json) as RunRequest;
}

export function parseResult(row: RunRow): Record<string, unknown> | null {
  return row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : null;
}

export function parseEventPayload(row: RunEventRow): Record<string, unknown> {
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

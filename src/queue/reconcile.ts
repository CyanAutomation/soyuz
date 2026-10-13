import { CONTRACT_VERSION, type QueuedRun } from "../contracts/queue-message";
import { listExpiredClaims, listStaleAdmissions, listStaleQueuedRuns, listStaleRunningRuns, markRunSuspectedStalled, parseRequest, reserveAdmissionRetry, reserveQueuedRunRecovery, transitionRun } from "../db/runs";
import type { Env } from "../env";

const RETRY_AFTER_MS = 60_000;
const MAX_ADMISSION_ATTEMPTS = 5;
const RECONCILE_BATCH_SIZE = 50;
const MAX_QUEUE_MESSAGE_BYTES = 96 * 1024;
const QUEUED_RUN_RECOVERY_AFTER_MS = 12 * 60 * 60_000;
const STALE_RUNNING_HEARTBEAT_MS = 5 * 60_000;

export async function reconcileAdmissions(env: Env, at = new Date()): Promise<void> {
  const now = at.toISOString();
  const cutoff = new Date(at.getTime() - RETRY_AFTER_MS).toISOString();

  await reconcileExpiredClaims(env, now, cutoff);
  await retryStaleAdmissions(env, now, cutoff);

  const staleQueuedCutoff = new Date(at.getTime() - QUEUED_RUN_RECOVERY_AFTER_MS).toISOString();
  await recoverStaleQueuedRuns(env, now, staleQueuedCutoff);
}

async function reconcileExpiredClaims(env: Env, now: string, cutoff: string): Promise<void> {
  const expiredClaims = await listExpiredClaims(env.DB, now, RECONCILE_BATCH_SIZE);
  for (const row of expiredClaims) {
    if (!row.claim_expires_at) continue;
    try {
      await transitionRun(env.DB, row.id, "admitting", {
        worker_id: null,
        claim_expires_at: null,
        admission_attempts: 0,
        admission_last_attempt_at: cutoff,
      }, {
        eventId: `system:claim-expired:${row.claim_expires_at}`,
        type: "run.claim_expired",
        workerId: row.worker_id,
        occurredAt: row.claim_expires_at,
        recordedAt: now,
        payload: { previousWorkerId: row.worker_id },
      });
    } catch {
      // A cancellation or start transition may have won the race.
    }
  }
}

async function retryStaleAdmissions(env: Env, now: string, cutoff: string): Promise<void> {
  const stale = await listStaleAdmissions(env.DB, cutoff, RECONCILE_BATCH_SIZE);
  for (const row of stale) await retryStaleAdmission(env, row, now);
}

async function retryStaleAdmission(
  env: Env,
  row: Parameters<typeof reserveAdmissionRetry>[1],
  now: string,
): Promise<void> {
  if (!(await reserveAdmissionRetry(env.DB, row, now))) return;
  const attempts = row.admission_attempts + 1;
  try {
    await publishQueuedRun(env, queuedRunMessage(row));
  } catch {
    await markAdmissionFailedAfterLastAttempt(env, row.id, attempts, now);
    return;
  }

  try {
    await transitionRun(env.DB, row.id, "queued", { queued_at: now }, {
      eventId: `system:admission:queued:${attempts}`,
      type: "run.queued",
      occurredAt: now,
      recordedAt: now,
      payload: { queue: "soyuz-runs", reconciled: true, attempts },
    });
  } catch {
    // A successful send followed by a D1 failure is retried with the same run ID.
    // The Kaseki consumer must check canonical state and deduplicate before starting.
  }
}

async function markAdmissionFailedAfterLastAttempt(env: Env, runId: string, attempts: number, now: string): Promise<void> {
  if (attempts < MAX_ADMISSION_ATTEMPTS) return;
  try {
    await transitionRun(env.DB, runId, "admission_failed", {
      completed_at: now,
      failure_class: "queue_publish_failed",
      failure_message: "Soyuz could not publish this run to its Queue after five attempts. Check Queue availability or configuration, then submit a new run with a new Idempotency-Key.",
    }, {
      eventId: "system:admission:failed",
      type: "run.admission_failed",
      occurredAt: now,
      recordedAt: now,
      payload: { failureClass: "queue_publish_failed", attempts },
    });
  } catch {
    // Keep the row eligible for a later reconciliation if D1 was unavailable.
  }
}

async function recoverStaleQueuedRuns(env: Env, now: string, staleQueuedCutoff: string): Promise<void> {
  const staleQueued = await listStaleQueuedRuns(env.DB, staleQueuedCutoff, RECONCILE_BATCH_SIZE);
  for (const row of staleQueued) {
    if (!(await reserveQueuedRunRecovery(env.DB, row, now))) continue;
    try {
      await publishQueuedRun(env, queuedRunMessage(row));
    } catch (error) {
      console.warn(JSON.stringify({
        event: "soyuz_queued_run_recovery_failed",
        runId: row.id,
        errorClass: error instanceof Error ? error.name : "Error",
        retryAfterMs: QUEUED_RUN_RECOVERY_AFTER_MS,
      }));
    }
  }
}

function queuedRunMessage(row: Parameters<typeof parseRequest>[0]): QueuedRun {
  return {
    contractVersion: CONTRACT_VERSION,
    runId: row.id,
    createdAt: row.created_at,
    correlationId: row.correlation_id,
    requestId: row.request_id,
    request: parseRequest(row),
  };
}

async function publishQueuedRun(env: Env, message: QueuedRun): Promise<void> {
  if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_QUEUE_MESSAGE_BYTES) {
    throw new Error("queue message too large");
  }
  await env.RUN_QUEUE.send(message, { contentType: "json" });
}

/** Flag missing run liveness for operators without changing lifecycle state or launching a duplicate. */
export async function reconcileStalledRuns(env: Env, at = new Date()): Promise<void> {
  const cutoff = new Date(at.getTime() - STALE_RUNNING_HEARTBEAT_MS).toISOString();
  const stale = await listStaleRunningRuns(env.DB, cutoff, RECONCILE_BATCH_SIZE);
  for (const row of stale) {
    try {
      if (await markRunSuspectedStalled(env.DB, row, at.toISOString())) {
        console.warn(JSON.stringify({
          event: "soyuz_run_suspected_stalled",
          runId: row.id,
          workerId: row.worker_id,
          lastHeartbeatAt: row.last_heartbeat_at,
          action: "operator_review_required_no_automatic_retry",
        }));
      }
    } catch {
      // A heartbeat, terminal callback, or D1 failure may have won the race. Reconcile on the next cron tick.
    }
  }
}

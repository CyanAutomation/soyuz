import { CONTRACT_VERSION, type QueuedRun } from "../contracts/queue-message";
import { listExpiredClaims, listStaleAdmissions, parseRequest, reserveAdmissionRetry, transitionRun } from "../db/runs";
import type { Env } from "../env";

const RETRY_AFTER_MS = 60_000;
const MAX_ADMISSION_ATTEMPTS = 5;
const RECONCILE_BATCH_SIZE = 50;
const MAX_QUEUE_MESSAGE_BYTES = 96 * 1024;

export async function reconcileAdmissions(env: Env, at = new Date()): Promise<void> {
  const now = at.toISOString();
  const cutoff = new Date(at.getTime() - RETRY_AFTER_MS).toISOString();

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

  const stale = await listStaleAdmissions(env.DB, cutoff, RECONCILE_BATCH_SIZE);

  for (const row of stale) {
    if (!(await reserveAdmissionRetry(env.DB, row, now))) continue;
    const attempts = row.admission_attempts + 1;
    const request = parseRequest(row);
    const message: QueuedRun = {
      contractVersion: CONTRACT_VERSION,
      runId: row.id,
      createdAt: row.created_at,
      correlationId: row.correlation_id,
      requestId: row.request_id,
      request,
    };

    try {
      if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_QUEUE_MESSAGE_BYTES) {
        throw new Error("queue message too large");
      }
      await env.RUN_QUEUE.send(message, { contentType: "json" });
    } catch {
      if (attempts >= MAX_ADMISSION_ATTEMPTS) {
        try {
          await transitionRun(env.DB, row.id, "admission_failed", {
            completed_at: now,
            failure_class: "queue_publish_failed",
            failure_message: "Queue publication failed after automatic retries",
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
      continue;
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
}

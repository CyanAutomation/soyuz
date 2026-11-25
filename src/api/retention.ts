import type { Env } from "../env";
import { recordArtifactReconciliationMetric } from "./artifact-reconciliation";

const RUN_EXPIRY_BATCH_SIZE = 30;
const ARTIFACT_DELETION_BATCH_SIZE = 100;
const ARTIFACT_DELETION_BATCHES_PER_SWEEP = 10;

/** Delete canonical runs only after their creation-anchored 90-day deadline. */
export async function purgeOldRuns(env: Env, at = new Date()): Promise<number> {
  const cutoff = at.toISOString();
  const page = await env.DB.prepare(`
    SELECT id FROM runs WHERE expires_at <= ?
    ORDER BY expires_at ASC, id ASC LIMIT ?
  `).bind(cutoff, RUN_EXPIRY_BATCH_SIZE).all<{ id: string }>();
  let deleted = 0;
  let queued = 0;

  for (const { id } of page.results ?? []) {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO artifact_deletion_queue (object_key, queued_at)
        SELECT object_key, ? FROM run_artifacts WHERE run_id = ? AND expires_at <= ?`)
        .bind(cutoff, id, cutoff),
      env.DB.prepare(`INSERT OR IGNORE INTO artifact_deletion_queue (object_key, queued_at)
        SELECT object_key, ? FROM publication_manifest_artifacts WHERE run_id = ? AND expires_at <= ?`)
        .bind(cutoff, id, cutoff),
      env.DB.prepare(`DELETE FROM publication_events WHERE run_id = ? AND expires_at <= ?`).bind(id, cutoff),
      env.DB.prepare(`DELETE FROM publications WHERE run_id = ? AND expires_at <= ?`).bind(id, cutoff),
      env.DB.prepare(`DELETE FROM publication_intents WHERE run_id = ? AND expires_at <= ?`).bind(id, cutoff),
      env.DB.prepare(`DELETE FROM publication_manifest_artifacts WHERE run_id = ? AND expires_at <= ?`).bind(id, cutoff),
      env.DB.prepare(`DELETE FROM run_events WHERE run_id = ? AND expires_at <= ?`).bind(id, cutoff),
      env.DB.prepare(`DELETE FROM run_artifacts WHERE run_id = ? AND expires_at <= ?`).bind(id, cutoff),
      env.DB.prepare(`DELETE FROM run_idempotency_keys WHERE run_id = ? AND expires_at <= ?`).bind(id, cutoff),
      env.DB.prepare(`DELETE FROM runs WHERE id = ? AND expires_at <= ?`).bind(id, cutoff),
    ]);
    queued += Number(results[0]?.meta?.changes ?? 0) + Number(results[1]?.meta?.changes ?? 0);
    deleted += Number(results[9]?.meta?.changes ?? 0);
  }

  const deletion = await purgeQueuedArtifactObjects(env, cutoff);
  console.info({
    event: "soyuz.retention.sweep",
    expiredRuns: deleted,
    newlyQueuedObjects: queued,
    deletedObjects: deletion.deleted,
    failedBatches: deletion.failedBatches,
    at: cutoff,
  });
  return deleted;
}

/** Compatibility entry point; publication expiry now follows its canonical run deadline. */
export async function purgeExpiredPublicationManifests(env: Env, at = new Date()): Promise<number> {
  return purgeOldRuns(env, at);
}

/** Request payloads expire with the owning run. There is no separate 365-day redaction window. */
export async function purgeExpiredRunRequests(_env: Env, _at = new Date()): Promise<number> {
  return 0;
}

async function purgeQueuedArtifactObjects(env: Env, sweepAt: string): Promise<{ deleted: number; failedBatches: number }> {
  if (!env.ARTIFACTS) return { deleted: 0, failedBatches: 0 };
  let deleted = 0;
  let failedBatches = 0;
  for (let batch = 0; batch < ARTIFACT_DELETION_BATCHES_PER_SWEEP; batch += 1) {
    const rows = await env.DB.prepare(`
      SELECT object_key FROM artifact_deletion_queue
      WHERE last_attempt_at IS NULL OR last_attempt_at < ?
      ORDER BY last_attempt_at ASC, queued_at ASC, object_key ASC LIMIT ?
    `).bind(sweepAt, ARTIFACT_DELETION_BATCH_SIZE).all<{ object_key: string }>();
    const objectKeys = (rows.results ?? []).map((row) => row.object_key);
    if (!objectKeys.length) break;
    const placeholders = objectKeys.map(() => "?").join(", ");
    try {
      await env.ARTIFACTS.delete(objectKeys);
      await env.DB.prepare(`DELETE FROM artifact_deletion_queue WHERE object_key IN (${placeholders})`)
        .bind(...objectKeys).run();
      deleted += objectKeys.length;
    } catch {
      await env.DB.prepare(`UPDATE artifact_deletion_queue SET last_attempt_at = ? WHERE object_key IN (${placeholders})`)
        .bind(sweepAt, ...objectKeys).run().catch(() => undefined);
      failedBatches += 1;
    }
  }
  if (failedBatches) {
    await recordArtifactReconciliationMetric(env, "cleanup_failure", new Date(sweepAt), failedBatches).catch(() => undefined);
    console.warn({ event: "soyuz.artifact.cleanup_failed", failedBatches, at: sweepAt });
  }
  return { deleted, failedBatches };
}

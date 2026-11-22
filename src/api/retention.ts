import type { Env } from "../env";
import { MAX_RETAINED_RUNS } from "../db/runs";

const RUN_REQUEST_RETENTION_DAYS = 365;
const RUN_REQUEST_RETENTION_MS = RUN_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const RUN_REQUEST_RETENTION_BATCH_SIZE = 100;
const REDACTED_PROMPT = `[redacted after ${RUN_REQUEST_RETENTION_DAYS} days]`;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "admission_failed"] as const;
const RUN_HISTORY_CULL_BATCH_SIZE = 30;
const ARTIFACT_DELETION_BATCH_SIZE = 100;
const ARTIFACT_DELETION_BATCHES_PER_SWEEP = 10;

interface RetentionCandidate {
  id: string;
  repo_url: string;
  git_ref: string;
  task_mode: "patch" | "inspect";
  publish_mode: "auto" | "none" | "branch" | "pr";
  idempotency_key: string | null;
}

/** Redact old submitted request content but keep run and idempotency history intact. */
export async function purgeExpiredRunRequests(env: Env, at = new Date()): Promise<number> {
  const redactedAt = at.toISOString();
  const cutoff = new Date(at.getTime() - RUN_REQUEST_RETENTION_MS).toISOString();
  const page = await env.DB.prepare(`
    SELECT id, repo_url, git_ref, task_mode, publish_mode, idempotency_key
    FROM runs
    WHERE status IN (?, ?, ?, ?)
      AND completed_at IS NOT NULL
      AND completed_at < ?
      AND request_redacted_at IS NULL
    ORDER BY completed_at ASC, id ASC
    LIMIT ?
  `).bind(...TERMINAL_STATUSES, cutoff, RUN_REQUEST_RETENTION_BATCH_SIZE).all<RetentionCandidate>();
  const candidates = page.results ?? [];
  if (!candidates.length) return 0;

  const statements = candidates.map((row) => {
    const request = {
      repoUrl: row.repo_url,
      ref: row.git_ref,
      taskMode: row.task_mode,
      publishMode: row.publish_mode,
      taskPrompt: REDACTED_PROMPT,
      ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    };
    return env.DB.prepare(`
      UPDATE runs
      SET request_json = ?, request_redacted_at = ?
      WHERE id = ?
        AND status IN (?, ?, ?, ?)
        AND completed_at IS NOT NULL
        AND completed_at < ?
        AND request_redacted_at IS NULL
    `).bind(JSON.stringify(request), redactedAt, row.id, ...TERMINAL_STATUSES, cutoff);
  });
  const results = await env.DB.batch(statements);
  return results.reduce((count, result) => count + Number(result.meta?.changes ?? 0), 0);
}

/** Remove runs beyond the newest 30, queue their R2 objects, then drain the deletion queue. */
export async function purgeOldRuns(env: Env): Promise<number> {
  const page = await env.DB.prepare(`
    SELECT id FROM runs
    WHERE id NOT IN (
      SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?
    )
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).bind(MAX_RETAINED_RUNS, RUN_HISTORY_CULL_BATCH_SIZE).all<{ id: string }>();
  const candidates = page.results ?? [];

  let deleted = 0;
  for (const { id } of candidates) {
    const pinCheckAt = new Date().toISOString();
    const retainedRunPredicate = `id = ? AND id NOT IN (
      SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?
    )`;
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO artifact_deletion_queue (object_key, queued_at)
        SELECT object_key, ? FROM run_artifacts
        WHERE run_id = ? AND NOT EXISTS (
          SELECT 1 FROM publication_intents i LEFT JOIN publications p ON p.publication_id = i.publication_id
          WHERE i.artifact_object_key = run_artifacts.object_key AND (
            i.state = 'authorized'
            OR (i.state = 'abandoned' AND (i.retained_until IS NULL OR i.retained_until > ?))
            OR p.state IN ('pending', 'publishing', 'retryable_failure')
            OR (p.state IN ('published', 'blocked') AND (p.retained_until IS NULL OR p.retained_until > ?))
          )
        ) AND EXISTS (
          SELECT 1 FROM runs AS candidate
          WHERE candidate.id = ? AND candidate.id NOT IN (
            SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?
          )
        )
      `).bind(pinCheckAt, id, pinCheckAt, pinCheckAt, id, MAX_RETAINED_RUNS),
      env.DB.prepare(`DELETE FROM run_events WHERE run_id = ? AND run_id NOT IN (
        SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?
      )`).bind(id, MAX_RETAINED_RUNS),
      env.DB.prepare(`DELETE FROM run_artifacts WHERE run_id = ? AND run_id NOT IN (
        SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?
      )`).bind(id, MAX_RETAINED_RUNS),
      env.DB.prepare(`DELETE FROM runs WHERE ${retainedRunPredicate}`).bind(id, MAX_RETAINED_RUNS),
    ]);
    deleted += Number(results[3]?.meta?.changes ?? 0);
  }

  await purgeQueuedArtifactObjects(env);
  return deleted;
}

async function purgeQueuedArtifactObjects(env: Env): Promise<void> {
  if (!env.ARTIFACTS) return;

  const sweepAt = new Date().toISOString();
  for (let batch = 0; batch < ARTIFACT_DELETION_BATCHES_PER_SWEEP; batch += 1) {
    const rows = await env.DB.prepare(`
      SELECT object_key FROM artifact_deletion_queue
      WHERE (last_attempt_at IS NULL OR last_attempt_at < ?)
        AND NOT EXISTS (
          SELECT 1 FROM publication_intents i LEFT JOIN publications p ON p.publication_id = i.publication_id
          WHERE i.artifact_object_key = artifact_deletion_queue.object_key AND (
            i.state = 'authorized'
            OR (i.state = 'abandoned' AND (i.retained_until IS NULL OR i.retained_until > ?))
            OR p.state IN ('pending', 'publishing', 'retryable_failure')
            OR (p.state = 'published' AND (p.retained_until IS NULL OR p.retained_until > ?))
            OR (p.state = 'blocked' AND (p.retained_until IS NULL OR p.retained_until > ?))
          )
        )
      ORDER BY last_attempt_at ASC, queued_at ASC, object_key ASC
      LIMIT ?
    `).bind(sweepAt, sweepAt, sweepAt, sweepAt, ARTIFACT_DELETION_BATCH_SIZE).all<{ object_key: string }>();
    const objectKeys = (rows.results ?? []).map((row) => row.object_key);
    if (!objectKeys.length) return;
    const placeholders = objectKeys.map(() => "?").join(", ");

    try {
      await env.ARTIFACTS.delete(objectKeys);
    } catch {
      await env.DB.prepare(`
        UPDATE artifact_deletion_queue SET last_attempt_at = ?
        WHERE object_key IN (${placeholders})
      `).bind(sweepAt, ...objectKeys).run();
      continue;
    }

    await env.DB.prepare(`
      DELETE FROM artifact_deletion_queue WHERE object_key IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM publication_intents i LEFT JOIN publications p ON p.publication_id = i.publication_id
          WHERE i.artifact_object_key = artifact_deletion_queue.object_key AND (
            i.state = 'authorized'
            OR (i.state = 'abandoned' AND (i.retained_until IS NULL OR i.retained_until > ?))
            OR p.state IN ('pending', 'publishing', 'retryable_failure')
            OR (p.state = 'published' AND (p.retained_until IS NULL OR p.retained_until > ?))
            OR (p.state = 'blocked' AND (p.retained_until IS NULL OR p.retained_until > ?))
          )
        )
    `).bind(...objectKeys, sweepAt, sweepAt, sweepAt).run();
  }
}

/** Queue expired publication manifests only after their active or operator-review pin ends. */
export async function purgeExpiredPublicationManifests(env: Env, at = new Date()): Promise<number> {
  const now = at.toISOString();
  const rows = await env.DB.prepare(`
    SELECT a.artifact_id, a.object_key FROM publication_manifest_artifacts a
    WHERE a.expires_at <= ? AND NOT EXISTS (
      SELECT 1 FROM publication_intents i LEFT JOIN publications p ON p.publication_id = i.publication_id
      WHERE i.artifact_id = a.artifact_id AND (
        i.state = 'authorized'
        OR (i.state = 'abandoned' AND (i.retained_until IS NULL OR i.retained_until > ?))
        OR p.state IN ('pending', 'publishing', 'retryable_failure')
        OR (p.state = 'published' AND (p.retained_until IS NULL OR p.retained_until > ?))
        OR (p.state = 'blocked' AND (p.retained_until IS NULL OR p.retained_until > ?))
      )
    ) ORDER BY a.expires_at, a.artifact_id LIMIT 100
  `).bind(now, now, now, now).all<{ artifact_id: string; object_key: string }>();
  for (const artifact of rows.results ?? []) {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO artifact_deletion_queue (object_key, queued_at)
        SELECT ?, ? WHERE NOT EXISTS (
          SELECT 1 FROM publication_intents i LEFT JOIN publications p ON p.publication_id = i.publication_id
          WHERE i.artifact_id = ? AND (
            i.state = 'authorized'
            OR (i.state = 'abandoned' AND (i.retained_until IS NULL OR i.retained_until > ?))
            OR p.state IN ('pending', 'publishing', 'retryable_failure')
            OR (p.state = 'published' AND (p.retained_until IS NULL OR p.retained_until > ?))
            OR (p.state = 'blocked' AND (p.retained_until IS NULL OR p.retained_until > ?))
          )
        )`).bind(artifact.object_key, now, artifact.artifact_id, now, now, now),
      env.DB.prepare(`DELETE FROM publications WHERE publication_id IN (
        SELECT publication_id FROM publication_intents WHERE artifact_id = ? AND state IN ('consumed', 'abandoned')
          AND retained_until IS NOT NULL AND retained_until <= ?
      )`).bind(artifact.artifact_id, now),
      env.DB.prepare(`DELETE FROM publication_events WHERE publication_id IN (
        SELECT publication_id FROM publication_intents WHERE artifact_id = ? AND state IN ('consumed', 'abandoned')
          AND retained_until IS NOT NULL AND retained_until <= ?
      )`).bind(artifact.artifact_id, now),
      env.DB.prepare(`DELETE FROM publication_intents WHERE artifact_id = ? AND state IN ('consumed', 'abandoned')
        AND retained_until IS NOT NULL AND retained_until <= ?`).bind(artifact.artifact_id, now),
      env.DB.prepare(`DELETE FROM publication_manifest_artifacts WHERE artifact_id = ? AND expires_at <= ?
        AND NOT EXISTS (SELECT 1 FROM publication_intents WHERE artifact_id = ?)`)
        .bind(artifact.artifact_id, now, artifact.artifact_id),
    ]);
  }
  return rows.results?.length ?? 0;
}

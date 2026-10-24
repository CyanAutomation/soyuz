import type { Env } from "../env";
import { MAX_RETAINED_RUNS } from "../db/runs";

const RUN_REQUEST_RETENTION_DAYS = 365;
const RUN_REQUEST_RETENTION_MS = RUN_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const RUN_REQUEST_RETENTION_BATCH_SIZE = 100;
const REDACTED_PROMPT = `[redacted after ${RUN_REQUEST_RETENTION_DAYS} days]`;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "admission_failed"] as const;
const RUN_HISTORY_CULL_BATCH_SIZE = 30;

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

interface RunArtifactObjectKey {
  object_key: string;
}

/** Remove run history beyond the newest 30 runs, including its events and stored artifacts. */
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
  if (!candidates.length) return 0;

  let deleted = 0;
  for (const { id } of candidates) {
    const artifacts = await env.DB.prepare(`
      SELECT object_key FROM run_artifacts WHERE run_id = ?
    `).bind(id).all<RunArtifactObjectKey>();
    const objectKeys = (artifacts.results ?? []).map((row) => row.object_key);
    if (objectKeys.length) {
      if (!env.ARTIFACTS) continue;
      try {
        for (let offset = 0; offset < objectKeys.length; offset += 100) {
          await env.ARTIFACTS.delete(objectKeys.slice(offset, offset + 100));
        }
      } catch {
        // Keep this run and its metadata so the next sweep can retry the R2 deletion.
        continue;
      }
    }

    const retainedRunPredicate = `id = ? AND id NOT IN (
      SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?
    )`;
    const results = await env.DB.batch([
      env.DB.prepare(`DELETE FROM run_events WHERE run_id = ? AND run_id NOT IN (
        SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?
      )`).bind(id, MAX_RETAINED_RUNS),
      env.DB.prepare(`DELETE FROM run_artifacts WHERE run_id = ? AND run_id NOT IN (
        SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ?
      )`).bind(id, MAX_RETAINED_RUNS),
      env.DB.prepare(`DELETE FROM runs WHERE ${retainedRunPredicate}`).bind(id, MAX_RETAINED_RUNS),
    ]);
    deleted += Number(results[2]?.meta?.changes ?? 0);
  }
  return deleted;
}

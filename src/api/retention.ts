import type { Env } from "../env";

const RUN_REQUEST_RETENTION_DAYS = 365;
const RUN_REQUEST_RETENTION_MS = RUN_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const RUN_REQUEST_RETENTION_BATCH_SIZE = 100;
const REDACTED_PROMPT = `[redacted after ${RUN_REQUEST_RETENTION_DAYS} days]`;
const TERMINAL_STATUSES = "'completed', 'failed', 'cancelled', 'admission_failed'";

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
    WHERE status IN (${TERMINAL_STATUSES})
      AND completed_at IS NOT NULL
      AND completed_at < ?
      AND request_redacted_at IS NULL
    ORDER BY completed_at ASC, id ASC
    LIMIT ?
  `).bind(cutoff, RUN_REQUEST_RETENTION_BATCH_SIZE).all<RetentionCandidate>();
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
        AND status IN (${TERMINAL_STATUSES})
        AND completed_at IS NOT NULL
        AND completed_at < ?
        AND request_redacted_at IS NULL
    `).bind(JSON.stringify(request), redactedAt, row.id, cutoff);
  });
  const results = await env.DB.batch(statements);
  return results.reduce((count, result) => count + Number(result.meta?.changes ?? 0), 0);
}

import type { Env } from "../env";
import { retentionExpiry } from "../persistence/retention-policy";

const ORPHAN_SCAN_PAGE_SIZE = 100;
const REFERENCE_SCAN_PAGE_SIZE = 50;
const MAX_ORPHAN_AGE_MS = 10 * 60 * 1_000;
const RECONCILIATION_PREFIXES = ["runs/", "publication-manifests/"] as const;

type ReconciliationSummary = { orphanObjectsQueued: number; missingObjects: number; errors: number };

/** Bounded D1/R2 consistency checks. Content remains inaccessible at its D1 expiry boundary. */
export async function reconcileArtifactStorage(env: Env, at = new Date()): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = { orphanObjectsQueued: 0, missingObjects: 0, errors: 0 };
  if (!env.ARTIFACTS) return summary;

  try {
    summary.missingObjects += await scanMissingReferences(env, at, "generic-artifacts");
    summary.missingObjects += await scanMissingReferences(env, at, "publication-manifests");
  } catch {
    summary.errors += 1;
    await recordMetric(env, "reconciliation_error", at, 1).catch(() => undefined);
    console.warn({ event: "soyuz.artifact.reconciliation_failed", stage: "missing-object-scan", at: at.toISOString() });
  }

  for (const prefix of RECONCILIATION_PREFIXES) {
    try {
      summary.orphanObjectsQueued += await scanOrphanPage(env, prefix, at);
    } catch {
      summary.errors += 1;
      await recordMetric(env, "reconciliation_error", at, 1).catch(() => undefined);
      console.warn({ event: "soyuz.artifact.reconciliation_failed", stage: "orphan-object-scan", prefix, at: at.toISOString() });
    }
  }

  if (summary.missingObjects) await recordMetric(env, "missing_object", at, summary.missingObjects);
  if (summary.orphanObjectsQueued) await recordMetric(env, "orphan_object", at, summary.orphanObjectsQueued);
  console.info({ event: "soyuz.artifact.reconciliation", ...summary, at: at.toISOString() });
  return summary;
}

async function scanMissingReferences(env: Env, at: Date, scanId: string): Promise<number> {
  const cutoff = at.toISOString();
  const cursor = await readCursor(env, scanId, at);
  const page = await readReferencePage(env, scanId, cutoff, cursor);
  let missing = 0;
  for (const row of page) {
    if (await checkReferenceObject(env, row, scanId, cutoff)) missing += 1;
  }
  await advanceReferenceCursor(env, scanId, cursor, page, at);
  return missing;
}

async function readReferencePage(
  env: Env,
  scanId: string,
  cutoff: string,
  cursor: string | null,
): Promise<Array<{ id: string; run_id: string; object_key: string }>> {
  const rows = scanId === "generic-artifacts"
    ? await env.DB.prepare(`SELECT id, run_id, object_key FROM run_artifacts
        WHERE state = 'ready' AND object_status = 'present' AND expires_at > ? AND (? IS NULL OR id > ?)
        ORDER BY id LIMIT ?`).bind(cutoff, cursor, cursor, REFERENCE_SCAN_PAGE_SIZE).all<{ id: string; run_id: string; object_key: string }>()
    : await env.DB.prepare(`SELECT artifact_id AS id, run_id, object_key FROM publication_manifest_artifacts
        WHERE expires_at > ? AND (? IS NULL OR artifact_id > ?)
        ORDER BY artifact_id LIMIT ?`).bind(cutoff, cursor, cursor, REFERENCE_SCAN_PAGE_SIZE).all<{ id: string; run_id: string; object_key: string }>();
  return rows.results ?? [];
}

async function checkReferenceObject(
  env: Env,
  row: { id: string; run_id: string; object_key: string },
  scanId: string,
  cutoff: string,
): Promise<boolean> {
  if (await env.ARTIFACTS!.head(row.object_key)) return false;
  if (scanId !== "generic-artifacts") return true;

  const updates = await env.DB.batch([
    env.DB.prepare(`UPDATE run_artifacts SET object_status = 'missing'
      WHERE id = ? AND object_key = ? AND state = 'ready' AND object_status = 'present' AND expires_at > ?`)
      .bind(row.id, row.object_key, cutoff),
    env.DB.prepare(`UPDATE runs SET artifact_delivery_status = 'partial'
      WHERE id = ? AND expires_at > ? AND artifact_delivery_status IN ('not_reported', 'complete')`)
      .bind(row.run_id, cutoff),
  ]);
  return Number(updates[0]?.meta?.changes ?? 0) > 0;
}

async function advanceReferenceCursor(
  env: Env,
  scanId: string,
  previousCursor: string | null,
  page: Array<{ id: string }>,
  at: Date,
): Promise<void> {
  if (page.length < REFERENCE_SCAN_PAGE_SIZE) {
    await clearCursor(env, scanId);
    return;
  }
  await saveCursor(env, scanId, page.at(-1)?.id ?? previousCursor ?? "", at);
}

async function scanOrphanPage(env: Env, prefix: string, at: Date): Promise<number> {
  const scanId = `orphan:${prefix}`;
  const cursor = await readCursor(env, scanId, at);
  const page = await env.ARTIFACTS!.list({ prefix, cursor: cursor ?? undefined, limit: ORPHAN_SCAN_PAGE_SIZE });
  const threshold = at.getTime() - MAX_ORPHAN_AGE_MS;
  const candidates = page.objects.filter((object) => {
    const uploadedAt = object.uploaded instanceof Date ? object.uploaded.getTime() : Number.NaN;
    return Number.isFinite(uploadedAt) && uploadedAt <= threshold;
  });
  let queued = 0;

  for (let offset = 0; offset < candidates.length; offset += 30) {
    const batch = candidates.slice(offset, offset + 30);
    const placeholders = batch.map(() => "?").join(", ");
    const keys = batch.map((object) => object.key);
    const known = await env.DB.prepare(`
      SELECT object_key FROM run_artifacts WHERE object_key IN (${placeholders})
      UNION SELECT object_key FROM publication_manifest_artifacts WHERE object_key IN (${placeholders})
      UNION SELECT object_key FROM artifact_deletion_queue WHERE object_key IN (${placeholders})
    `).bind(...keys, ...keys, ...keys).all<{ object_key: string }>();
    const knownKeys = new Set((known.results ?? []).map((row) => row.object_key));
    const orphans = keys.filter((key) => !knownKeys.has(key));
    if (orphans.length) {
      const queuedAt = at.toISOString();
      const inserts = await env.DB.batch(orphans.map((key) => env.DB.prepare(
        "INSERT OR IGNORE INTO artifact_deletion_queue (object_key, queued_at) VALUES (?, ?)",
      ).bind(key, queuedAt)));
      queued += inserts.reduce((count, result) => count + Number(result.meta?.changes ?? 0), 0);
    }
  }

  if (page.truncated && page.cursor) await saveCursor(env, scanId, page.cursor, at);
  else await clearCursor(env, scanId);
  return queued;
}

async function readCursor(env: Env, id: string, at: Date): Promise<string | null> {
  const row = await env.DB.prepare("SELECT cursor, expires_at FROM artifact_reconciliation_state WHERE reconciliation_id = ?")
    .bind(id).first<{ cursor: string | null; expires_at: string }>();
  if (!row) return null;
  if (row.expires_at <= at.toISOString()) {
    await clearCursor(env, id);
    return null;
  }
  return row.cursor;
}

async function saveCursor(env: Env, id: string, cursor: string, at: Date): Promise<void> {
  const createdAt = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())).toISOString();
  const expiresAt = retentionExpiry(createdAt);
  await env.DB.prepare(`INSERT INTO artifact_reconciliation_state
      (reconciliation_id, cursor, created_at, updated_at, expires_at, retention_policy_version)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(reconciliation_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`)
    .bind(id, cursor, createdAt, at.toISOString(), expiresAt).run();
}

async function clearCursor(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM artifact_reconciliation_state WHERE reconciliation_id = ?").bind(id).run();
}

async function recordMetric(env: Env, outcome: "orphan_object" | "missing_object" | "reconciliation_error", at: Date, count: number): Promise<void> {
  return recordArtifactReconciliationMetric(env, outcome, at, count);
}

export async function recordArtifactReconciliationMetric(env: Env, outcome: "orphan_object" | "missing_object" | "reconciliation_error" | "cleanup_failure", at: Date, count: number): Promise<void> {
  const metricDay = at.toISOString().slice(0, 10);
  const createdAt = `${metricDay}T00:00:00.000Z`;
  const expiresAt = retentionExpiry(createdAt);
  await env.DB.prepare(`INSERT INTO artifact_reconciliation_metrics
      (metric_day, outcome, count, created_at, expires_at, retention_policy_version)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(metric_day, outcome) DO UPDATE SET count = artifact_reconciliation_metrics.count + excluded.count`)
    .bind(metricDay, outcome, count, createdAt, expiresAt).run();
}

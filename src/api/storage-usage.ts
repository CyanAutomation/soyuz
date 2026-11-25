import type { Env } from "../env";
import { MAXIMUM_RETENTION_DAYS, RETENTION_POLICY_VERSION } from "../persistence/retention-policy";
import { errorResponse, successResponse } from "./http";

type StorageSummary = { artifact_count: number; total_bytes: number; run_count: number };
type ArtifactBreakdown = { artifact_type: string; artifact_count: number; total_bytes: number };
type EngineBreakdown = { engine_id: string; artifact_count: number; total_bytes: number };
type CleanupStats = { pending_objects: number; retrying_objects: number | null };
type UploadRejection = { metric_day: string; code: string; count: number };
type GrowthStats = { bytes: number; uploads: number };
type ImpactStats = {
  expired_runs: number; expired_events: number; expired_artifacts: number; expired_manifests: number;
  expired_publication_records: number; estimated_expired_bytes: number; expired_object_references: number;
  missing_indexed_objects: number; queued_object_deletes: number; invalid_expiry_records: number;
  artifacts_without_checksum: number;
};
type ReconciliationStats = { outcome: string; count: number };

type StorageMetrics = {
  summary: StorageSummary | null;
  byCategory: ArtifactBreakdown[];
  byEngine: EngineBreakdown[];
  cleanup: CleanupStats | null;
  rejections: UploadRejection[];
  growth: GrowthStats | null;
  impact: ImpactStats | null;
  reconciliation: ReconciliationStats[];
  expiredArtifactMetadata: number;
};

export async function handleStorageUsage(request: Request, env: Env, requestId: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/storage-usage") return null;
  if (request.method !== "GET") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Storage usage accepts GET requests.");

  const now = new Date().toISOString();
  try {
    const metrics = await readStorageMetrics(env, now);
    return successResponse(requestId, {
      asOf: now,
      retentionPolicyVersion: RETENTION_POLICY_VERSION,
      maximumRetentionDays: MAXIMUM_RETENTION_DAYS,
      usage: buildUsage(metrics),
      dryRunRetentionImpact: buildRetentionImpact(metrics, now),
    });
  } catch {
    return errorResponse(requestId, 503, "STORAGE_USAGE_UNAVAILABLE", "Soyuz could not read artifact storage usage. Retry shortly.");
  }
}

async function readStorageMetrics(env: Env, now: string): Promise<StorageMetrics> {
  const [usage, operational, impact, expiredArtifactMetadata] = await Promise.all([
    readUsageMetrics(env, now),
    readOperationalMetrics(env, now),
    readRetentionImpactMetrics(env, now),
    countExpiredArtifactMetadata(env, now),
  ]);
  return { ...usage, ...operational, impact, expiredArtifactMetadata };
}

async function readUsageMetrics(env: Env, now: string): Promise<Pick<StorageMetrics, "summary" | "byCategory" | "byEngine" | "growth">> {
  const [summary, byCategory, byEngine, growth] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS artifact_count, COALESCE(SUM(size_bytes), 0) AS total_bytes,
      COUNT(DISTINCT run_id) AS run_count
      FROM run_artifacts WHERE state = 'ready' AND expires_at > ?`).bind(now).first<StorageSummary>(),
    env.DB.prepare(`SELECT artifact_type, COUNT(*) AS artifact_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
      FROM run_artifacts WHERE state = 'ready' AND expires_at > ?
      GROUP BY artifact_type ORDER BY artifact_type`).bind(now).all<ArtifactBreakdown>(),
    env.DB.prepare(`SELECT engine_id, COUNT(*) AS artifact_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
      FROM run_artifacts WHERE state = 'ready' AND expires_at > ?
      GROUP BY engine_id ORDER BY engine_id`).bind(now).all<EngineBreakdown>(),
    env.DB.prepare(`SELECT COALESCE(SUM(total_bytes), 0) AS bytes, COALESCE(SUM(count), 0) AS uploads
      FROM artifact_upload_metrics WHERE outcome = 'stored' AND metric_day >= date(?, '-6 days') AND expires_at > ?`)
      .bind(now, now).first<GrowthStats>(),
  ]);
  return {
    summary,
    byCategory: byCategory.results ?? [],
    byEngine: byEngine.results ?? [],
    growth,
  };
}

async function readOperationalMetrics(env: Env, now: string): Promise<Pick<StorageMetrics, "cleanup" | "rejections" | "reconciliation">> {
  const [cleanup, rejections, reconciliation] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS pending_objects,
      SUM(CASE WHEN last_attempt_at IS NOT NULL THEN 1 ELSE 0 END) AS retrying_objects
      FROM artifact_deletion_queue`).first<CleanupStats>(),
    env.DB.prepare(`SELECT metric_day, code, count FROM artifact_upload_metrics
      WHERE outcome = 'rejected' AND expires_at > ? ORDER BY metric_day DESC, code LIMIT 100`)
      .bind(now).all<UploadRejection>(),
    env.DB.prepare(`SELECT outcome, SUM(count) AS count FROM artifact_reconciliation_metrics
      WHERE expires_at > ? GROUP BY outcome ORDER BY outcome`).bind(now).all<ReconciliationStats>(),
  ]);
  return {
    cleanup,
    rejections: rejections.results ?? [],
    reconciliation: reconciliation.results ?? [],
  };
}

async function readRetentionImpactMetrics(env: Env, now: string): Promise<ImpactStats | null> {
  return env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM runs WHERE expires_at <= ?) AS expired_runs,
    (SELECT COUNT(*) FROM run_events WHERE expires_at <= ?) AS expired_events,
    (SELECT COUNT(*) FROM run_artifacts WHERE expires_at <= ?) AS expired_artifacts,
    (SELECT COUNT(*) FROM publication_manifest_artifacts WHERE expires_at <= ?) AS expired_manifests,
    ((SELECT COUNT(*) FROM publications WHERE expires_at <= ?) +
     (SELECT COUNT(*) FROM publication_intents WHERE expires_at <= ?) +
     (SELECT COUNT(*) FROM publication_events WHERE expires_at <= ?)) AS expired_publication_records,
    (COALESCE((SELECT SUM(size_bytes) FROM run_artifacts WHERE expires_at <= ?), 0) +
     COALESCE((SELECT SUM(size_bytes) FROM publication_manifest_artifacts WHERE expires_at <= ?), 0)) AS estimated_expired_bytes,
    ((SELECT COUNT(*) FROM run_artifacts WHERE expires_at <= ?) +
     (SELECT COUNT(*) FROM publication_manifest_artifacts WHERE expires_at <= ?)) AS expired_object_references,
    (SELECT COUNT(*) FROM run_artifacts WHERE object_status = 'missing' AND expires_at > ?) AS missing_indexed_objects,
    (SELECT COUNT(*) FROM artifact_deletion_queue) AS queued_object_deletes,
    ((SELECT COUNT(*) FROM runs WHERE expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days')) +
     (SELECT COUNT(*) FROM run_events WHERE expires_at IS NULL OR expires_at > (SELECT expires_at FROM runs WHERE runs.id = run_events.run_id)) +
     (SELECT COUNT(*) FROM run_artifacts WHERE expires_at IS NULL OR expires_at > (SELECT expires_at FROM runs WHERE runs.id = run_artifacts.run_id)) +
     (SELECT COUNT(*) FROM run_idempotency_keys WHERE expires_at IS NULL OR expires_at > (SELECT expires_at FROM runs WHERE runs.id = run_idempotency_keys.run_id)) +
     (SELECT COUNT(*) FROM publication_manifest_artifacts WHERE expires_at IS NULL OR expires_at > (SELECT expires_at FROM runs WHERE runs.id = publication_manifest_artifacts.run_id)) +
     (SELECT COUNT(*) FROM publications WHERE expires_at IS NULL OR expires_at > (SELECT expires_at FROM runs WHERE runs.id = publications.run_id)) +
     (SELECT COUNT(*) FROM publication_intents WHERE expires_at IS NULL OR expires_at > (SELECT expires_at FROM runs WHERE runs.id = publication_intents.run_id)) +
     (SELECT COUNT(*) FROM publication_events WHERE expires_at IS NULL OR expires_at > (SELECT expires_at FROM runs WHERE runs.id = publication_events.run_id))) AS invalid_expiry_records,
    (SELECT COUNT(*) FROM run_artifacts WHERE state = 'ready' AND sha256 IS NULL) AS artifacts_without_checksum`)
    .bind(now, now, now, now, now, now, now, now, now, now, now, now)
    .first<ImpactStats>();
}

function buildUsage(metrics: StorageMetrics) {
  const summary = metrics.summary ?? { artifact_count: 0, total_bytes: 0, run_count: 0 };
  const growth = metrics.growth ?? { bytes: 0, uploads: 0 };
  const cleanup = metrics.cleanup ?? { pending_objects: 0, retrying_objects: 0 };
  const totalBytes = Number(summary.total_bytes);
  const runCount = Number(summary.run_count);
  return {
    artifactCount: Number(summary.artifact_count),
    totalBytes,
    runCount,
    averageBytesPerRun: averageBytesPerRun(totalBytes, runCount),
    growth: {
      successfulUploadsLast7Days: Number(growth.uploads),
      bytesUploadedLast7Days: Number(growth.bytes),
    },
    byCategory: metrics.byCategory.map((row) => ({
      category: row.artifact_type, artifactCount: row.artifact_count, totalBytes: row.total_bytes,
    })),
    byExecutionEngine: metrics.byEngine.map((row) => ({
      engineId: row.engine_id, artifactCount: row.artifact_count, totalBytes: row.total_bytes,
    })),
    expiredMetadataCount: metrics.expiredArtifactMetadata,
    cleanup: {
      pendingObjectDeletes: Number(cleanup.pending_objects),
      retriedObjectDeletes: Number(cleanup.retrying_objects ?? 0),
    },
    uploadRejections: metrics.rejections.map((row) => ({ day: row.metric_day, code: row.code, count: row.count })),
    reconciliation: Object.fromEntries(metrics.reconciliation.map((row) => [row.outcome, Number(row.count)])),
  };
}

function averageBytesPerRun(totalBytes: number, runCount: number): number {
  return runCount > 0 ? Math.round(totalBytes / runCount) : 0;
}

function buildRetentionImpact(metrics: StorageMetrics, now: string) {
  const impact = metrics.impact ?? {
    expired_runs: 0, expired_events: 0, expired_artifacts: 0, expired_manifests: 0,
    expired_publication_records: 0, estimated_expired_bytes: 0, expired_object_references: 0,
    missing_indexed_objects: 0, queued_object_deletes: 0, invalid_expiry_records: 0,
    artifacts_without_checksum: 0,
  };
  const invalidExpiryRecords = Number(impact.invalid_expiry_records);
  return {
    asOf: now,
    expiredRuns: Number(impact.expired_runs),
    expiredEvents: Number(impact.expired_events),
    expiredArtifacts: Number(impact.expired_artifacts),
    expiredPublicationManifests: Number(impact.expired_manifests),
    expiredPublicationRecords: Number(impact.expired_publication_records),
    expiredObjectReferences: Number(impact.expired_object_references),
    estimatedObjectBytes: Number(impact.estimated_expired_bytes),
    queuedObjectDeletions: Number(impact.queued_object_deletes),
    recordsWithInvalidExpiry: invalidExpiryRecords,
    recordsRequiringManualReconciliation: invalidExpiryRecords + Number(impact.missing_indexed_objects),
    recordsRequiringChecksumReconciliation: Number(impact.artifacts_without_checksum),
  };
}

async function countExpiredArtifactMetadata(env: Env, at: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM run_artifacts WHERE expires_at <= ?")
    .bind(at).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

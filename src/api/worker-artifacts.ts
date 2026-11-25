import type { Env } from "../env";
import { getRun } from "../db/runs";
import { isUuid } from "../lib/uuid";
import { sha256Hex } from "../lib/sha256";
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES_PER_RUN, RETENTION_POLICY_VERSION, retentionExpiry } from "../persistence/retention-policy";
import { errorResponse, successResponse } from "./http";
import { MAX_ARTIFACTS_PER_RUN, publicArtifact, type ArtifactRow } from "./artifact-model";

const ARTIFACT_KINDS = new Set(["log", "patch", "report", "other"]);
const ARTIFACT_ENGINES = new Set(["kaseki-agent", "rusty-fossil", "unknown"]);

class ArtifactBodyError extends Error {
  constructor(readonly code: "ARTIFACT_SIZE_MISMATCH" | "ARTIFACT_TOO_LARGE") {
    super(code);
  }
}

class ArtifactStoreError extends Error {
  constructor(readonly code: "ARTIFACT_STORAGE_UNAVAILABLE" | "ARTIFACT_INDEX_UPDATE_FAILED" | "ARTIFACT_INTEGRITY_MISMATCH") {
    super(code);
  }
}

export async function handleWorkerArtifacts(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
): Promise<Response | null> {
  const response = await handleWorkerArtifactUpload(request, env, url, requestId);
  if (response && url.pathname.includes("/artifacts/") && response.status >= 400) {
    const errorBody = await response.clone().json().catch(() => null) as { error?: { code?: unknown } } | null;
    const code = typeof errorBody?.error?.code === "string" ? errorBody.error.code : "ARTIFACT_UPLOAD_REJECTED";
    await recordUploadRejection(env, response.status, code, new Date()).catch(() => undefined);
    console.warn({ event: "soyuz.artifact.upload", outcome: "rejected", status: response.status, code });
  }
  return response;
}

async function handleWorkerArtifactUpload(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
): Promise<Response | null> {
  const route = matchWorkerArtifactRoute(request, env, url, requestId);
  if (route.kind === "skip") return null;
  if (route.kind === "error") return route.response;

  const metadata = parseWorkerArtifactMetadata(request, route.artifactId, requestId);
  if (metadata.kind === "error") return metadata.response;

  const access = await authorizeWorkerArtifact(request, env, route.runId, requestId);
  if (!access.ok) return access.response;

  const createdAt = new Date().toISOString();
  const expiresAt = access.run.expires_at;
  const row: ArtifactRow = {
    id: route.artifactId,
    run_id: route.runId,
    ...metadata.value,
    object_key: artifactObjectKey(route.runId, route.artifactId),
    created_at: createdAt,
    expires_at: expiresAt,
    state: "pending",
    artifact_type: metadata.value.artifact_type,
    artifact_schema_version: 1,
    content_encoding: "identity",
    sha256: null,
    producer_id: access.workerId,
    engine_id: metadata.value.engine_id,
    engine_version: metadata.value.engine_version,
    retention_policy_version: RETENTION_POLICY_VERSION,
    object_status: "present",
  };

  const reservationError = await reserveArtifactUpload(request, env, row, access, requestId);
  if (reservationError) return reservationError;
  logArtifactUpload("attempted", requestId, row);
  const storageError = await storeArtifactUpload(request, env, row, requestId);
  if (storageError) return storageError;
  logArtifactUpload("stored", requestId, row);
  await recordUploadStored(env, row, new Date()).catch(() => undefined);
  return successResponse(requestId, publicArtifact(row), 201);
}

type WorkerArtifactRoute =
  | { kind: "skip" }
  | { kind: "error"; response: Response }
  | { kind: "route"; runId: string; artifactId: string };

function matchWorkerArtifactRoute(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
): WorkerArtifactRoute {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 6 || parts[0] !== "v1" || parts[1] !== "worker" || parts[2] !== "runs" || parts[4] !== "artifacts") {
    return { kind: "skip" };
  }
  if (request.method !== "PUT") {
    return { kind: "error", response: errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Worker artifact routes accept PUT requests") };
  }

  const [, , , runId, , artifactId] = parts;
  if (!isUuid(runId) || !isUuid(artifactId)) {
    return { kind: "error", response: errorResponse(requestId, 404, "ARTIFACT_NOT_FOUND", "Artifact was not found") };
  }
  if (!env.ARTIFACTS) {
    return { kind: "error", response: errorResponse(requestId, 503, "ARTIFACT_STORAGE_UNAVAILABLE", "Artifact storage is not configured.") };
  }
  return { kind: "route", runId, artifactId };
}

type ArtifactUploadMetadata = Pick<ArtifactRow, "kind" | "name" | "content_type" | "size_bytes" | "artifact_type" | "engine_id" | "engine_version">;
type ArtifactMetadataResult = { kind: "error"; response: Response } | { kind: "valid"; value: ArtifactUploadMetadata };

function parseWorkerArtifactMetadata(request: Request, artifactId: string, requestId: string): ArtifactMetadataResult {
  const declaredLength = parseContentLength(request.headers.get("content-length"));
  if (declaredLength === null) {
    return { kind: "error", response: errorResponse(requestId, 411, "CONTENT_LENGTH_REQUIRED", "Artifact uploads require a valid Content-Length header.") };
  }
  if (declaredLength < 1 || declaredLength > MAX_ARTIFACT_BYTES) {
    return { kind: "error", response: errorResponse(requestId, 413, "ARTIFACT_TOO_LARGE", "Artifacts must be between 1 byte and 25,000,000 bytes.") };
  }
  if (!request.body) {
    return { kind: "error", response: errorResponse(requestId, 400, "ARTIFACT_BODY_REQUIRED", "Artifact content is required.") };
  }

  const kind = request.headers.get("x-artifact-kind") ?? "other";
  if (!ARTIFACT_KINDS.has(kind)) {
    return { kind: "error", response: errorResponse(requestId, 400, "ARTIFACT_KIND_INVALID", "Artifact kind must be log, patch, report, or other.") };
  }
  const name = safeArtifactName(request.headers.get("x-artifact-name"), artifactId);
  if (!name) {
    return { kind: "error", response: errorResponse(requestId, 400, "ARTIFACT_NAME_INVALID", "Artifact name must be a printable filename of 1 to 255 characters.") };
  }
  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  if (contentType.length > 255 || /[\r\n\u0000-\u001f]/.test(contentType)) {
    return { kind: "error", response: errorResponse(requestId, 400, "ARTIFACT_CONTENT_TYPE_INVALID", "Artifact content type is invalid.") };
  }
  const engine = parseArtifactEngine(request);
  return artifactMetadataResult(kind, name, contentType, declaredLength, engine);
}

function artifactMetadataResult(
  kind: string,
  name: string,
  contentType: string,
  declaredLength: number,
  engine: { id: string; version: string | null },
): ArtifactMetadataResult {
  return {
    kind: "valid",
    value: {
      kind: kind as ArtifactRow["kind"], name, content_type: contentType, size_bytes: declaredLength,
      artifact_type: artifactTypeFor(name, kind as ArtifactRow["kind"]),
      engine_id: engine.id, engine_version: engine.version,
    },
  };
}

function parseArtifactEngine(request: Request): { id: string; version: string | null } {
  const requestedId = request.headers.get("x-soyuz-engine-id")?.trim() || "unknown";
  const requestedVersion = request.headers.get("x-soyuz-engine-version")?.trim() || null;
  const id = ARTIFACT_ENGINES.has(requestedId) ? requestedId : "unknown";
  const version = requestedVersion && /^[A-Za-z0-9._+-]{1,120}$/.test(requestedVersion) ? requestedVersion : null;
  return { id, version };
}

type WorkerArtifactAccess = { ok: true; workerId: string; claimCallbackId: string; run: NonNullable<Awaited<ReturnType<typeof getRun>>> } | { ok: false; response: Response };

async function authorizeWorkerArtifact(request: Request, env: Env, runId: string, requestId: string): Promise<WorkerArtifactAccess> {
  let run;
  try {
    run = await getRun(env.DB, runId);
  } catch {
    return { ok: false, response: errorResponse(requestId, 503, "RUN_READ_UNAVAILABLE", "Soyuz could not read the run state. Retry shortly.") };
  }
  if (!run) return { ok: false, response: errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found") };
  if (run.status !== "running" && run.status !== "cancel_requested") {
    return { ok: false, response: errorResponse(requestId, 409, "RUN_NOT_ACTIVE", "Artifacts can only be added while the run is executing.") };
  }
  const workerId = request.headers.get("x-soyuz-worker-id")?.trim() ?? "";
  const claimCallbackId = request.headers.get("x-soyuz-claim-callback-id")?.trim() ?? "";
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(workerId)) {
    return { ok: false, response: errorResponse(requestId, 400, "WORKER_ID_REQUIRED", "Artifact uploads require a valid worker ID.") };
  }
  if (!isUuid(claimCallbackId)) {
    return { ok: false, response: errorResponse(requestId, 400, "CLAIM_CALLBACK_ID_REQUIRED", "Artifact uploads require the current claim callback ID.") };
  }
  if (run.worker_id !== workerId) {
    return { ok: false, response: errorResponse(requestId, 409, "WORKER_MISMATCH", "Worker does not own this run") };
  }
  if (!run.claim_callback_id || run.claim_callback_id !== claimCallbackId) {
    return { ok: false, response: errorResponse(requestId, 409, "STALE_CLAIM", "This claim attempt is no longer current") };
  }
  return { ok: true, workerId, claimCallbackId, run };
}

async function reserveArtifactUpload(
  request: Request,
  env: Env,
  row: ArtifactRow,
  access: Extract<WorkerArtifactAccess, { ok: true }>,
  requestId: string,
): Promise<Response | null> {
  const existing = await checkExistingArtifact(request, env, row, requestId);
  if (existing) return existing;
  return reserveNewArtifact(env, row, access, requestId);
}

async function checkExistingArtifact(request: Request, env: Env, row: ArtifactRow, requestId: string): Promise<Response | null> {
  let existing: ArtifactRow | null;
  try {
    existing = await env.DB.prepare(`
      SELECT * FROM run_artifacts WHERE id = ? AND run_id = ?
    `).bind(row.id, row.run_id).first<ArtifactRow>();
  } catch {
    return errorResponse(requestId, 503, "ARTIFACT_INDEX_UNAVAILABLE", "Soyuz could not check artifact metadata. Retry shortly.");
  }
  if (existing) {
    if (existing.expires_at <= row.created_at) return errorResponse(requestId, 410, "ARTIFACT_EXPIRED", "Artifact has expired.");
    if (!artifactMetadataMatches(existing, row)) {
      return errorResponse(requestId, 409, "ARTIFACT_ID_CONFLICT", "An artifact with this ID already exists with different content or metadata.");
    }
    return verifyIdempotentArtifact(request, env, existing, requestId);
  }
  return null;
}

function artifactMetadataMatches(existing: ArtifactRow, incoming: ArtifactRow): boolean {
  return existing.state === "ready" && existing.kind === incoming.kind && existing.artifact_type === incoming.artifact_type
    && existing.name === incoming.name && existing.content_type === incoming.content_type && existing.size_bytes === incoming.size_bytes;
}

async function reserveNewArtifact(
  env: Env,
  row: ArtifactRow,
  access: Extract<WorkerArtifactAccess, { ok: true }>,
  requestId: string,
): Promise<Response | null> {
  try {
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id = ? AND state = 'ready' AND expires_at > ?")
      .bind(row.run_id, row.created_at).first<{ count: number }>();
    if ((count?.count ?? 0) >= MAX_ARTIFACTS_PER_RUN) {
      return errorResponse(requestId, 413, "ARTIFACT_LIMIT_REACHED", "A run may store at most 100 artifacts.");
    }
    const inserted = await env.DB.prepare(`
      INSERT INTO run_artifacts (
        id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state,
        artifact_type, artifact_schema_version, content_encoding, producer_id, engine_id, engine_version, retention_policy_version
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, 'identity', ?, ?, ?, ?
      FROM runs
      WHERE id = ? AND status IN ('running', 'cancel_requested') AND worker_id = ?
        AND expires_at > ?
        AND (SELECT event_id FROM run_events WHERE run_id = runs.id AND type = 'run.claimed' ORDER BY sequence DESC LIMIT 1) = ?
    `).bind(row.id, row.run_id, row.kind, row.name, row.content_type, row.size_bytes, row.object_key, row.created_at, row.expires_at,
      row.artifact_type, access.workerId, row.engine_id, row.engine_version, RETENTION_POLICY_VERSION,
      row.run_id, access.workerId, row.created_at, access.claimCallbackId).run();
    if (Number(inserted.meta?.changes ?? 0) !== 1) {
      return await artifactOwnershipChanged(env, row.run_id, access.workerId, access.claimCallbackId, requestId);
    }
  } catch (error) {
    return artifactReservationFailure(error, requestId);
  }
  return null;
}

function artifactReservationFailure(error: unknown, requestId: string): Response {
  const message = String(error);
  if (message.includes("ARTIFACT_LIMIT_REACHED")) {
    return errorResponse(requestId, 413, "ARTIFACT_LIMIT_REACHED", "A run may store at most 100 artifacts.");
  }
  if (message.includes("ARTIFACT_AGGREGATE_LIMIT_REACHED")) {
    return errorResponse(requestId, 413, "ARTIFACT_AGGREGATE_LIMIT_REACHED", `A run may store at most ${MAX_ARTIFACT_BYTES_PER_RUN.toLocaleString("en-US")} artifact bytes.`);
  }
  if (message.includes("UNIQUE constraint failed")) {
    return errorResponse(requestId, 409, "ARTIFACT_ID_CONFLICT", "An artifact with this ID already exists for a run.");
  }
  return errorResponse(requestId, 503, "ARTIFACT_INDEX_UNAVAILABLE", "Soyuz could not reserve artifact metadata. Retry shortly.");
}

async function storeArtifactUpload(request: Request, env: Env, row: ArtifactRow, requestId: string): Promise<Response | null> {
  if (!request.body) return errorResponse(requestId, 400, "ARTIFACT_BODY_REQUIRED", "Artifact content is required.");
  const bucket = env.ARTIFACTS;
  if (!bucket) return errorResponse(requestId, 503, "ARTIFACT_STORAGE_UNAVAILABLE", "Artifact storage is not configured.");

  try {
    const bytes = await readExactBytes(request.body, row.size_bytes);
    row.sha256 = await sha256Hex(bytes);
    await writeArtifactAndIndex(bytes, bucket, env, row);
  } catch (error) {
    await cleanupFailedArtifactUpload(bucket, env, row);
    logArtifactUpload("failed", requestId, row,
      error instanceof ArtifactStoreError || error instanceof ArtifactBodyError ? error.code : "ARTIFACT_STORE_FAILED");
    return artifactUploadFailure(error, requestId);
  }
  return null;
}

async function writeArtifactAndIndex(
  body: Uint8Array,
  bucket: R2Bucket,
  env: Env,
  row: ArtifactRow,
): Promise<void> {
  const checksum = sha256Bytes(row.sha256);
  const stored = await putArtifactObject(bucket, row, body, checksum);
  if (stored?.checksums?.sha256 && !equalBytes(new Uint8Array(stored.checksums.sha256), checksum)) {
    throw new ArtifactStoreError("ARTIFACT_INTEGRITY_MISMATCH");
  }
  await markArtifactReady(env, row);
}

function sha256Bytes(value: string | null): Uint8Array {
  return Uint8Array.from((value ?? "").match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

async function putArtifactObject(bucket: R2Bucket, row: ArtifactRow, body: Uint8Array, checksum: Uint8Array): Promise<R2Object> {
  let stored: R2Object;
  try {
    stored = await bucket.put(row.object_key, body, {
      sha256: checksum,
      httpMetadata: { contentType: row.content_type },
      customMetadata: {
        runId: row.run_id,
        artifactId: row.id,
        kind: row.kind,
        name: row.name,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        artifactType: row.artifact_type,
        artifactSchemaVersion: String(row.artifact_schema_version),
        contentEncoding: row.content_encoding,
        sha256: row.sha256 ?? "",
        producerId: row.producer_id,
        engineId: row.engine_id,
        ...(row.engine_version ? { engineVersion: row.engine_version } : {}),
        retentionPolicyVersion: String(row.retention_policy_version),
      },
    });
  } catch {
    throw new ArtifactStoreError("ARTIFACT_STORAGE_UNAVAILABLE");
  }
  return stored;
}

async function markArtifactReady(env: Env, row: ArtifactRow): Promise<void> {
  let update: D1Result;
  try {
    update = await env.DB.prepare("UPDATE run_artifacts SET state = 'ready', sha256 = ? WHERE id = ? AND state = 'pending' AND expires_at > ?")
      .bind(row.sha256, row.id, new Date().toISOString()).run();
  } catch {
    throw new ArtifactStoreError("ARTIFACT_INDEX_UPDATE_FAILED");
  }
  if (Number(update.meta?.changes ?? 0) !== 1) throw new ArtifactStoreError("ARTIFACT_INDEX_UPDATE_FAILED");
}

async function cleanupFailedArtifactUpload(bucket: R2Bucket, env: Env, row: ArtifactRow): Promise<void> {
  let objectDeleted = false;
  try {
    await bucket.delete(row.object_key);
    objectDeleted = true;
  } catch {
    // Keep the pending index row so the scheduled retention sweep can retry this deletion.
  }
  if (objectDeleted) {
    await env.DB.prepare("DELETE FROM run_artifacts WHERE id = ? AND state = 'pending'").bind(row.id).run().catch(() => undefined);
  }
}

function artifactUploadFailure(error: unknown, requestId: string): Response {
  if (error instanceof ArtifactBodyError) {
    const status = error.code === "ARTIFACT_TOO_LARGE" ? 413 : 400;
    const message = error.code === "ARTIFACT_TOO_LARGE"
      ? "Artifacts cannot exceed 25,000,000 bytes."
      : "Artifact body size did not match its declared Content-Length.";
    return errorResponse(requestId, status, error.code, message);
  }
  if (error instanceof ArtifactStoreError) {
    const integrityFailure = error.code === "ARTIFACT_INTEGRITY_MISMATCH";
    return errorResponse(requestId, integrityFailure ? 502 : 503, error.code, integrityFailure
      ? "Stored artifact checksum did not match the uploaded content."
      : "Soyuz could not persist artifact content and metadata. Retry shortly.");
  }
  return errorResponse(requestId, 503, "ARTIFACT_STORE_FAILED", "Soyuz could not store the artifact. Retry with a new artifact ID.");
}

async function verifyIdempotentArtifact(request: Request, env: Env, row: ArtifactRow, requestId: string): Promise<Response> {
  if (!request.body || !env.ARTIFACTS) return errorResponse(requestId, 400, "ARTIFACT_BODY_REQUIRED", "Artifact content is required.");
  try {
    const stored = await env.ARTIFACTS.get(row.object_key);
    if (!stored || stored.size !== row.size_bytes) {
      return errorResponse(requestId, 409, "ARTIFACT_ID_CONFLICT", "An artifact with this ID already exists with different content or metadata.");
    }
    if (!await matchesStoredArtifactContent(request.body, row, stored)) {
      return errorResponse(requestId, 409, "ARTIFACT_ID_CONFLICT", "An artifact with this ID already exists with different content or metadata.");
    }
    return successResponse(requestId, publicArtifact(row), 200);
  } catch (error) {
    if (error instanceof ArtifactBodyError) {
      return errorResponse(requestId, 400, error.code, "Artifact body size did not match its declared Content-Length.");
    }
    return errorResponse(requestId, 503, "ARTIFACT_READ_UNAVAILABLE", "Soyuz could not verify the existing artifact. Retry shortly.");
  }
}

async function matchesStoredArtifactContent(body: ReadableStream<Uint8Array>, row: ArtifactRow, stored: R2ObjectBody): Promise<boolean> {
  const [incomingBytes, storedBytes] = await Promise.all([
    readExactBytes(body, row.size_bytes),
    stored.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
  ]);
  return incomingBytes.byteLength === storedBytes.byteLength
    && equalBytes(incomingBytes, storedBytes)
    && (row.sha256 === null || await sha256Hex(incomingBytes) === row.sha256);
}

async function artifactOwnershipChanged(
  env: Env,
  runId: string,
  workerId: string,
  claimCallbackId: string,
  requestId: string,
): Promise<Response> {
  let latest;
  try {
    latest = await getRun(env.DB, runId);
  } catch {
    return errorResponse(requestId, 503, "RUN_READ_UNAVAILABLE", "Soyuz could not recheck the run state. Retry shortly.");
  }
  if (!latest) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
  if (latest.status !== "running" && latest.status !== "cancel_requested") {
    return errorResponse(requestId, 409, "RUN_NOT_ACTIVE", "Artifacts can only be added while the run is executing.");
  }
  if (latest.worker_id !== workerId) return errorResponse(requestId, 409, "WORKER_MISMATCH", "Worker does not own this run");
  if (latest.claim_callback_id !== claimCallbackId) return errorResponse(requestId, 409, "STALE_CLAIM", "This claim attempt is no longer current");
  return errorResponse(requestId, 409, "ARTIFACT_ID_CONFLICT", "An artifact with this ID already exists for a run.");
}

async function readExactBytes(stream: ReadableStream<Uint8Array>, expectedLength: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expectedLength || total > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      throw new ArtifactBodyError(total > MAX_ARTIFACT_BYTES ? "ARTIFACT_TOO_LARGE" : "ARTIFACT_SIZE_MISMATCH");
    }
    chunks.push(value);
  }
  if (total !== expectedLength) throw new ArtifactBodyError("ARTIFACT_SIZE_MISMATCH");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function artifactObjectKey(runId: string, artifactId: string): string {
  return `runs/${runId}/${artifactId}`;
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeArtifactName(value: string | null, artifactId: string): string | null {
  const name = value?.trim() || `artifact-${artifactId}`;
  if (name.length > 255 || /[\r\n\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function artifactTypeFor(name: string, kind: ArtifactRow["kind"]): ArtifactRow["artifact_type"] {
  const known: Record<string, ArtifactRow["artifact_type"]> = {
    "result-summary.md": "execution.summary",
    "failure.json": "execution.failure",
    "git.diff": "code.diff",
    "changed-files.txt": "code.changed-files",
    "run-scorecard.json": "evaluation.scorecard",
    "run-evaluation.json": "evaluation.result",
    "validation.json": "validation.result",
    "publication-manifest.json": "publication.manifest",
  };
  if (known[name]) return known[name];
  if (kind === "log") return "execution.log";
  if (kind === "patch") return "code.patch";
  if (kind === "report") return "execution.report";
  return "execution.other";
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function logArtifactUpload(outcome: "attempted" | "stored" | "failed", requestId: string, row: ArtifactRow, code?: string): void {
  const record = {
    event: "soyuz.artifact.upload",
    outcome,
    requestId,
    runId: row.run_id,
    artifactId: row.id,
    artifactType: row.artifact_type,
    engineId: row.engine_id,
    sizeBytes: row.size_bytes,
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(code ? { code } : {}),
  };
  if (outcome === "failed") console.warn(record);
  else console.info(record);
}

async function recordUploadRejection(env: Env, status: number, code: string, at: Date): Promise<void> {
  const metricDay = at.toISOString().slice(0, 10);
  const createdAt = `${metricDay}T00:00:00.000Z`;
  await env.DB.prepare(`
    INSERT INTO artifact_upload_metrics (metric_day, outcome, code, count, created_at, expires_at, retention_policy_version)
    VALUES (?, 'rejected', ?, 1, ?, ?, ?)
    ON CONFLICT(metric_day, outcome, code) DO UPDATE SET count = artifact_upload_metrics.count + 1
  `).bind(metricDay, `${status}:${code}`.slice(0, 120), createdAt, retentionExpiry(createdAt), RETENTION_POLICY_VERSION).run();
}

async function recordUploadStored(env: Env, row: ArtifactRow, at: Date): Promise<void> {
  const metricDay = at.toISOString().slice(0, 10);
  const createdAt = `${metricDay}T00:00:00.000Z`;
  const expiresAt = retentionExpiry(createdAt);
  await env.DB.prepare(`INSERT INTO artifact_upload_metrics
      (metric_day, outcome, code, count, total_bytes, created_at, expires_at, retention_policy_version)
    VALUES (?, 'stored', ?, 1, ?, ?, ?, 1)
    ON CONFLICT(metric_day, outcome, code) DO UPDATE SET
      count = artifact_upload_metrics.count + 1,
      total_bytes = artifact_upload_metrics.total_bytes + excluded.total_bytes`)
    .bind(metricDay, row.artifact_type, row.size_bytes, createdAt, expiresAt).run();
}

import type { Env } from "../env";
import { getRun } from "../db/runs";
import { isUuid } from "../lib/uuid";
import { errorResponse, successResponse } from "./http";

const MAX_ARTIFACT_BYTES = 25_000_000;
const MAX_ARTIFACTS_PER_RUN = 100;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ARTIFACT_KINDS = new Set(["log", "patch", "report", "other"]);

class ArtifactBodyError extends Error {
  constructor(readonly code: "ARTIFACT_SIZE_MISMATCH" | "ARTIFACT_TOO_LARGE") {
    super(code);
  }
}

interface ArtifactRow {
  id: string;
  run_id: string;
  kind: "log" | "patch" | "report" | "other";
  name: string;
  content_type: string;
  size_bytes: number;
  object_key: string;
  created_at: string;
  expires_at: string;
  state: "pending" | "ready";
}

export async function handleWorkerArtifacts(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
): Promise<Response | null> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 6 || parts[0] !== "v1" || parts[1] !== "worker" || parts[2] !== "runs" || parts[4] !== "artifacts") return null;
  if (request.method !== "PUT") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Worker artifact routes accept PUT requests");

  const [, , , runId, , artifactId] = parts;
  if (!isUuid(runId) || !isUuid(artifactId)) return errorResponse(requestId, 404, "ARTIFACT_NOT_FOUND", "Artifact was not found");
  if (!env.ARTIFACTS) return errorResponse(requestId, 503, "ARTIFACT_STORAGE_UNAVAILABLE", "Artifact storage is not configured.");

  const declaredLength = parseContentLength(request.headers.get("content-length"));
  if (declaredLength === null) return errorResponse(requestId, 411, "CONTENT_LENGTH_REQUIRED", "Artifact uploads require a valid Content-Length header.");
  if (declaredLength < 1 || declaredLength > MAX_ARTIFACT_BYTES) {
    return errorResponse(requestId, 413, "ARTIFACT_TOO_LARGE", "Artifacts must be between 1 byte and 25,000,000 bytes.");
  }
  if (!request.body) return errorResponse(requestId, 400, "ARTIFACT_BODY_REQUIRED", "Artifact content is required.");

  const kind = request.headers.get("x-artifact-kind") ?? "other";
  if (!ARTIFACT_KINDS.has(kind)) return errorResponse(requestId, 400, "ARTIFACT_KIND_INVALID", "Artifact kind must be log, patch, report, or other.");
  const name = safeArtifactName(request.headers.get("x-artifact-name"), artifactId);
  if (!name) return errorResponse(requestId, 400, "ARTIFACT_NAME_INVALID", "Artifact name must be a printable filename of 1 to 255 characters.");
  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  if (contentType.length > 255 || /[\r\n\u0000-\u001f]/.test(contentType)) {
    return errorResponse(requestId, 400, "ARTIFACT_CONTENT_TYPE_INVALID", "Artifact content type is invalid.");
  }

  let run;
  try {
    run = await getRun(env.DB, runId);
  } catch {
    return errorResponse(requestId, 503, "RUN_READ_UNAVAILABLE", "Soyuz could not read the run state. Retry shortly.");
  }
  if (!run) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
  if (run.status !== "running" && run.status !== "cancel_requested") {
    return errorResponse(requestId, 409, "RUN_NOT_ACTIVE", "Artifacts can only be added while the run is executing.");
  }
  const workerId = request.headers.get("x-soyuz-worker-id")?.trim() ?? "";
  const claimCallbackId = request.headers.get("x-soyuz-claim-callback-id")?.trim() ?? "";
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(workerId)) {
    return errorResponse(requestId, 400, "WORKER_ID_REQUIRED", "Artifact uploads require a valid worker ID.");
  }
  if (!isUuid(claimCallbackId)) {
    return errorResponse(requestId, 400, "CLAIM_CALLBACK_ID_REQUIRED", "Artifact uploads require the current claim callback ID.");
  }
  if (run.worker_id !== workerId) {
    return errorResponse(requestId, 409, "WORKER_MISMATCH", "Worker does not own this run");
  }
  if (!run.claim_callback_id || run.claim_callback_id !== claimCallbackId) {
    return errorResponse(requestId, 409, "STALE_CLAIM", "This claim attempt is no longer current");
  }

  const objectKey = artifactObjectKey(runId, artifactId);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
  const row: ArtifactRow = {
    id: artifactId,
    run_id: runId,
    kind: kind as ArtifactRow["kind"],
    name,
    content_type: contentType,
    size_bytes: declaredLength,
    object_key: objectKey,
    created_at: createdAt,
    expires_at: expiresAt,
    state: "pending",
  };

  let existing: ArtifactRow | null;
  try {
    existing = await env.DB.prepare(`
      SELECT id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state
      FROM run_artifacts WHERE id = ? AND run_id = ?
    `).bind(artifactId, runId).first<ArtifactRow>();
  } catch {
    return errorResponse(requestId, 503, "ARTIFACT_INDEX_UNAVAILABLE", "Soyuz could not check artifact metadata. Retry shortly.");
  }
  if (existing) {
    if (existing.expires_at <= createdAt) return errorResponse(requestId, 410, "ARTIFACT_EXPIRED", "Artifact has expired.");
    if (existing.state !== "ready" || existing.kind !== kind || existing.name !== name
      || existing.content_type !== contentType || existing.size_bytes !== declaredLength) {
      return errorResponse(requestId, 409, "ARTIFACT_ID_CONFLICT", "An artifact with this ID already exists with different content or metadata.");
    }
    return verifyIdempotentArtifact(request, env, existing, requestId);
  }

  try {
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id = ? AND state = 'ready' AND expires_at > ?")
      .bind(runId, createdAt).first<{ count: number }>();
    if ((count?.count ?? 0) >= MAX_ARTIFACTS_PER_RUN) {
      return errorResponse(requestId, 413, "ARTIFACT_LIMIT_REACHED", "A run may store at most 100 artifacts.");
    }
    const inserted = await env.DB.prepare(`
      INSERT INTO run_artifacts (id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
      FROM runs
      WHERE id = ? AND status IN ('running', 'cancel_requested') AND worker_id = ?
        AND (SELECT event_id FROM run_events WHERE run_id = runs.id AND type = 'run.claimed' ORDER BY sequence DESC LIMIT 1) = ?
    `).bind(row.id, row.run_id, row.kind, row.name, row.content_type, row.size_bytes, row.object_key, row.created_at, row.expires_at,
      runId, workerId, claimCallbackId).run();
    if (Number(inserted.meta?.changes ?? 0) !== 1) {
      return await artifactOwnershipChanged(env, runId, workerId, claimCallbackId, requestId);
    }
  } catch (error) {
    if (String(error).includes("ARTIFACT_LIMIT_REACHED")) {
      return errorResponse(requestId, 413, "ARTIFACT_LIMIT_REACHED", "A run may store at most 100 artifacts.");
    }
    return errorResponse(requestId, 409, "ARTIFACT_ID_CONFLICT", "An artifact with this ID already exists for a run.");
  }

  try {
    let streamedLength = 0;
    const boundedBody = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        streamedLength += chunk.byteLength;
        if (streamedLength > MAX_ARTIFACT_BYTES) throw new ArtifactBodyError("ARTIFACT_TOO_LARGE");
        if (streamedLength > declaredLength) throw new ArtifactBodyError("ARTIFACT_SIZE_MISMATCH");
        controller.enqueue(chunk);
      },
      flush() {
        if (streamedLength !== declaredLength) throw new ArtifactBodyError("ARTIFACT_SIZE_MISMATCH");
      },
    }));
    await env.ARTIFACTS.put(objectKey, boundedBody, {
      httpMetadata: { contentType },
      customMetadata: { runId, artifactId, kind, name, createdAt, expiresAt },
    });
    const update = await env.DB.prepare("UPDATE run_artifacts SET state = 'ready' WHERE id = ? AND state = 'pending'")
      .bind(artifactId).run();
    if (Number(update.meta?.changes ?? 0) !== 1) throw new Error("ARTIFACT_INDEX_UPDATE_FAILED");
  } catch (error) {
    let objectDeleted = false;
    try {
      await env.ARTIFACTS.delete(objectKey);
      objectDeleted = true;
    } catch {
      // Keep the pending index row so the scheduled retention sweep can retry this deletion.
    }
    if (objectDeleted) {
      await env.DB.prepare("DELETE FROM run_artifacts WHERE id = ? AND state = 'pending'").bind(artifactId).run().catch(() => undefined);
    }
    if (error instanceof ArtifactBodyError) {
      const status = error.code === "ARTIFACT_TOO_LARGE" ? 413 : 400;
      const message = error.code === "ARTIFACT_TOO_LARGE"
        ? "Artifacts cannot exceed 25,000,000 bytes."
        : "Artifact body size did not match its declared Content-Length.";
      return errorResponse(requestId, status, error.code, message);
    }
    return errorResponse(requestId, 503, "ARTIFACT_STORE_FAILED", "Soyuz could not store the artifact. Retry with a new artifact ID.");
  }

  return successResponse(requestId, publicArtifact(row), 201);
}

async function verifyIdempotentArtifact(request: Request, env: Env, row: ArtifactRow, requestId: string): Promise<Response> {
  if (!request.body || !env.ARTIFACTS) return errorResponse(requestId, 400, "ARTIFACT_BODY_REQUIRED", "Artifact content is required.");
  try {
    const stored = await env.ARTIFACTS.get(row.object_key);
    if (!stored || stored.size !== row.size_bytes) {
      return errorResponse(requestId, 409, "ARTIFACT_ID_CONFLICT", "An artifact with this ID already exists with different content or metadata.");
    }
    const [incomingBytes, storedBytes] = await Promise.all([
      readExactBytes(request.body, row.size_bytes),
      stored.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    ]);
    if (incomingBytes.byteLength !== storedBytes.byteLength || !incomingBytes.every((byte, index) => byte === storedBytes[index])) {
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

export async function handleClientArtifacts(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
): Promise<Response | null> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "v1" || parts[1] !== "runs" || parts[3] !== "artifacts") return null;
  const runId = parts[2];
  if (!isUuid(runId)) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
  if (!env.ARTIFACTS) return errorResponse(requestId, 503, "ARTIFACT_STORAGE_UNAVAILABLE", "Artifact storage is not configured.");

  if (parts.length === 4 && request.method === "GET") {
    try {
      const rows = await env.DB.prepare(`
        SELECT id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state
        FROM run_artifacts WHERE run_id = ? AND state = 'ready' AND expires_at > ?
        ORDER BY created_at DESC, id LIMIT ?
      `).bind(runId, new Date().toISOString(), MAX_ARTIFACTS_PER_RUN).all<ArtifactRow>();
      return successResponse(requestId, { artifacts: rows.results.map(publicArtifact) });
    } catch {
      return errorResponse(requestId, 503, "ARTIFACT_LIST_UNAVAILABLE", "Soyuz could not read artifact metadata. Retry shortly.");
    }
  }

  if (parts.length !== 5 || request.method !== "GET") return errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
  const artifactId = parts[4];
  if (!isUuid(artifactId)) return errorResponse(requestId, 404, "ARTIFACT_NOT_FOUND", "Artifact was not found");

  let row: ArtifactRow | null;
  try {
    row = await env.DB.prepare(`
      SELECT id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state
      FROM run_artifacts WHERE run_id = ? AND id = ? AND state = 'ready'
    `).bind(runId, artifactId).first<ArtifactRow>();
  } catch {
    return errorResponse(requestId, 503, "ARTIFACT_READ_UNAVAILABLE", "Soyuz could not read artifact metadata. Retry shortly.");
  }
  if (!row) return errorResponse(requestId, 404, "ARTIFACT_NOT_FOUND", "Artifact was not found");
  if (Date.parse(row.expires_at) <= Date.now()) {
    await expireArtifact(env, row);
    return errorResponse(requestId, 410, "ARTIFACT_EXPIRED", "Artifact has expired.");
  }

  let object: R2ObjectBody | null;
  try {
    object = await env.ARTIFACTS.get(row.object_key);
  } catch {
    return errorResponse(requestId, 503, "ARTIFACT_READ_UNAVAILABLE", "Soyuz could not read artifact content. Retry shortly.");
  }
  if (!object) return errorResponse(requestId, 404, "ARTIFACT_CONTENT_NOT_FOUND", "Artifact content was not found");

  const headers = new Headers({
    "content-type": row.content_type,
    "content-disposition": `attachment; filename="artifact-${artifactId}"`,
    "content-length": String(row.size_bytes),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  return new Response(object.body, { status: 200, headers });
}

export async function purgeExpiredArtifacts(env: Env, at = new Date()): Promise<void> {
  if (!env.ARTIFACTS) return;
  const cutoff = at.toISOString();
  let afterId = "";
  for (let batch = 0; batch < 10; batch += 1) {
    const rows = await env.DB.prepare(`
      SELECT id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state
      FROM run_artifacts WHERE expires_at <= ? AND id > ? ORDER BY id LIMIT 500
    `).bind(cutoff, afterId).all<ArtifactRow>();
    if (rows.results.length === 0) return;
    for (const row of rows.results) {
      afterId = row.id;
      try {
        await env.ARTIFACTS.delete(row.object_key);
        await env.DB.prepare("DELETE FROM run_artifacts WHERE id = ? AND expires_at <= ?").bind(row.id, cutoff).run();
      } catch {
        // Retain metadata for the next daily sweep; advancing the cursor lets this sweep reach other rows.
      }
    }
  }
}

export function artifactObjectKey(runId: string, artifactId: string): string {
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

function publicArtifact(row: ArtifactRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    contentType: row.content_type,
    size: row.size_bytes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

async function expireArtifact(env: Env, row: ArtifactRow): Promise<void> {
  if (!env.ARTIFACTS) return;
  try {
    await env.ARTIFACTS.delete(row.object_key);
    await env.DB.prepare("DELETE FROM run_artifacts WHERE id = ?").bind(row.id).run();
  } catch {
    // The scheduled retention sweep retries if either store is temporarily unavailable.
  }
}

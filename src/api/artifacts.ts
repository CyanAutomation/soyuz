import type { Env } from "../env";
import { isWithinRetention } from "../persistence/retention-policy";
import { isRunRetained } from "../db/runs";
import { isUuid } from "../lib/uuid";
import { errorResponse, successResponse } from "./http";
import { MAX_ARTIFACTS_PER_RUN, publicArtifact, type ArtifactRow } from "./artifact-model";
import { purgeQueuedArtifactObjects } from "./retention";

const MAX_CACHED_ARTIFACT_BYTES = 1_000_000;
const MAX_ARTIFACT_CACHE_TTL_SECONDS = 60 * 60;

function artifactResponseCache(): Cache {
  // Cloudflare exposes this default cache in addition to the standard CacheStorage interface.
  return (caches as CacheStorage & { readonly default: Cache }).default;
}

export async function handleClientArtifacts(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
  context: ExecutionContext,
): Promise<Response | null> {
  const route = clientArtifactRoute(request, env, url, requestId);
  if (route.kind === "skip") return null;
  if (route.kind === "error") return route.response;
  if (route.kind === "list") return listClientArtifacts(env, route.runId, requestId);
  return readClientArtifact(env, route.runId, route.artifactId, requestId, context);
}

type ClientArtifactRoute =
  | { kind: "skip" }
  | { kind: "error"; response: Response }
  | { kind: "list"; runId: string }
  | { kind: "read"; runId: string; artifactId: string };

function clientArtifactRoute(request: Request, env: Env, url: URL, requestId: string): ClientArtifactRoute {
  const parts = url.pathname.split("/").filter(Boolean);
  if (!isClientArtifactPath(parts)) return { kind: "skip" };
  const runId = parts[2];
  if (!isUuid(runId)) return { kind: "error", response: errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found") };
  if (!env.ARTIFACTS) {
    return { kind: "error", response: errorResponse(requestId, 503, "ARTIFACT_STORAGE_UNAVAILABLE", "Artifact storage is not configured.") };
  }

  if (isArtifactListRequest(parts, request)) return { kind: "list", runId };
  if (!isArtifactReadRequest(parts, request)) {
    return { kind: "error", response: errorResponse(requestId, 404, "NOT_FOUND", "Route was not found") };
  }
  const artifactId = parts[4];
  if (!isUuid(artifactId)) {
    return { kind: "error", response: errorResponse(requestId, 404, "ARTIFACT_NOT_FOUND", "Artifact was not found") };
  }
  return { kind: "read", runId, artifactId };
}

function isClientArtifactPath(parts: string[]): boolean {
  if (parts.length < 4) return false;
  if (parts[0] !== "v1") return false;
  if (parts[1] !== "runs") return false;
  return parts[3] === "artifacts";
}

function isArtifactListRequest(parts: string[], request: Request): boolean {
  return parts.length === 4 && request.method === "GET";
}

function isArtifactReadRequest(parts: string[], request: Request): boolean {
  return parts.length === 5 && request.method === "GET";
}

async function listClientArtifacts(env: Env, runId: string, requestId: string): Promise<Response> {
  try {
    if (!(await isRunRetained(env.DB, runId))) {
      return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
    }
    const rows = await env.DB.prepare(`
      SELECT *
      FROM run_artifacts WHERE run_id = ? AND state = 'ready' AND expires_at > ?
      ORDER BY created_at DESC, id LIMIT ?
    `).bind(runId, new Date().toISOString(), MAX_ARTIFACTS_PER_RUN).all<ArtifactRow>();
    return successResponse(requestId, { artifacts: rows.results.map(publicArtifact) });
  } catch {
    return errorResponse(requestId, 503, "ARTIFACT_LIST_UNAVAILABLE", "Soyuz could not read artifact metadata. Retry shortly.");
  }
}

async function readClientArtifact(
  env: Env,
  runId: string,
  artifactId: string,
  requestId: string,
  context: ExecutionContext,
): Promise<Response> {
  let row: ArtifactRow | null;
  try {
    if (!(await isRunRetained(env.DB, runId))) {
      return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
    }
    row = await findReadyArtifact(env, runId, artifactId);
  } catch {
    return errorResponse(requestId, 503, "ARTIFACT_READ_UNAVAILABLE", "Soyuz could not read artifact metadata. Retry shortly.");
  }
  if (!row) return errorResponse(requestId, 404, "ARTIFACT_NOT_FOUND", "Artifact was not found");
  if (!isWithinRetention(row.expires_at)) {
    await expireArtifact(env, row);
    return errorResponse(requestId, 410, "ARTIFACT_EXPIRED", "Artifact has expired.");
  }

  const headers = artifactDownloadHeaders(row);
  const cacheKey = artifactCacheKey(row.object_key);
  try {
    const cached = await artifactResponseCache().match(cacheKey);
    if (cached) return new Response(cached.body, { status: 200, headers });
  } catch {
    // Cache failures must not make otherwise available artifacts unreadable.
  }

  let object: R2ObjectBody | null;
  try {
    object = await readArtifactObject(env, row);
  } catch {
    return errorResponse(requestId, 503, "ARTIFACT_READ_UNAVAILABLE", "Soyuz could not read artifact content. Retry shortly.");
  }
  const objectResult = validateArtifactObject(row, object, requestId);
  if ("response" in objectResult) return objectResult.response;
  const verifiedObject = objectResult.object;

  const response = new Response(verifiedObject.body, { status: 200, headers });
  const ttl = Math.min(
    MAX_ARTIFACT_CACHE_TTL_SECONDS,
    Math.floor((Date.parse(row.expires_at) - Date.now()) / 1_000),
  );
  if (row.size_bytes <= MAX_CACHED_ARTIFACT_BYTES && ttl > 0) {
    const cacheable = response.clone();
    cacheable.headers.set("cache-control", `public, max-age=${ttl}`);
    context.waitUntil(artifactResponseCache().put(cacheKey, cacheable).catch(() => undefined));
  }
  return response;
}

function artifactCacheKey(objectKey: string): Request {
  return new Request(`https://soyuz-artifact-cache.internal/${objectKey.split("/").map(encodeURIComponent).join("/")}`);
}

async function findReadyArtifact(env: Env, runId: string, artifactId: string): Promise<ArtifactRow | null> {
  return env.DB.prepare(`
    SELECT *
    FROM run_artifacts WHERE run_id = ? AND id = ? AND state = 'ready' AND object_status = 'present'
  `).bind(runId, artifactId).first<ArtifactRow>();
}

async function readArtifactObject(env: Env, row: ArtifactRow): Promise<R2ObjectBody | null> {
  return env.ARTIFACTS!.get(row.object_key);
}

function matchesSha256(checksum: ArrayBuffer, expectedHex: string): boolean {
  const bytes = new Uint8Array(checksum);
  const actual = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return actual === expectedHex;
}

function artifactChecksumMatches(row: ArtifactRow, object: R2ObjectBody): boolean {
  if (!row.sha256) return true;
  return Boolean(object.checksums?.sha256 && matchesSha256(object.checksums.sha256, row.sha256));
}

function validateArtifactObject(
  row: ArtifactRow,
  object: R2ObjectBody | null,
  requestId: string,
): { object: R2ObjectBody } | { response: Response } {
  if (!object) return { response: errorResponse(requestId, 404, "ARTIFACT_CONTENT_NOT_FOUND", "Artifact content was not found") };
  if (!artifactChecksumMatches(row, object)) {
    return { response: errorResponse(requestId, 502, "ARTIFACT_INTEGRITY_MISMATCH", "Stored artifact content did not match its recorded checksum.") };
  }
  return { object };
}

function artifactDownloadHeaders(row: ArtifactRow): Headers {
  const filenameFallback = row.name.replace(/[^A-Za-z0-9._-]/g, "_") || "artifact";
  const encodedFilename = encodeURIComponent(row.name).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Headers({
    "content-type": row.content_type,
    "content-disposition": `attachment; filename="${filenameFallback}"; filename*=UTF-8''${encodedFilename}`,
    "content-length": String(row.size_bytes),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
}

export async function purgeExpiredArtifacts(env: Env, at = new Date()): Promise<void> {
  const cutoff = at.toISOString();
  let removed = 0;
  for (let batch = 0; batch < 10; batch += 1) {
    const rows = await env.DB.prepare(`
      SELECT id, object_key FROM run_artifacts WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 100
    `).bind(cutoff).all<{ id: string; object_key: string }>();
    if (!rows.results.length) break;
    const statements = rows.results.flatMap((row) => [
      env.DB.prepare("INSERT OR IGNORE INTO artifact_deletion_queue (object_key, queued_at) VALUES (?, ?)").bind(row.object_key, cutoff),
      env.DB.prepare("DELETE FROM run_artifacts WHERE id = ? AND expires_at <= ?").bind(row.id, cutoff),
    ]);
    const results = await env.DB.batch(statements);
    removed += results.reduce((count, result, index) => count + (index % 2 === 1 ? Number(result.meta?.changes ?? 0) : 0), 0);
  }
  const deletion = await purgeQueuedArtifactObjects(env, cutoff);
  console.info({ event: "soyuz.artifact.expiry", removedMetadata: removed, deletedObjects: deletion.deleted, failedBatches: deletion.failedBatches, at: cutoff });
}

async function expireArtifact(env: Env, row: ArtifactRow): Promise<void> {
  try {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO artifact_deletion_queue (object_key, queued_at) SELECT ?, ? FROM run_artifacts WHERE expires_at <= ? AND id = ?")
        .bind(row.object_key, now, now, row.id),
      env.DB.prepare("DELETE FROM run_artifacts WHERE id = ? AND expires_at <= ?").bind(row.id, now),
    ]);
  } catch {
    // The scheduled expiry sweep retries if D1 is temporarily unavailable.
  }
}

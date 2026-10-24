import type { Env } from "../env";
import { isRunRetained } from "../db/runs";
import { isUuid } from "../lib/uuid";
import { errorResponse, successResponse } from "./http";
import { MAX_ARTIFACTS_PER_RUN, publicArtifact, type ArtifactRow } from "./artifact-model";

export async function handleClientArtifacts(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
): Promise<Response | null> {
  const route = clientArtifactRoute(request, env, url, requestId);
  if (route.kind === "skip") return null;
  if (route.kind === "error") return route.response;
  if (route.kind === "list") return listClientArtifacts(env, route.runId, requestId);
  return readClientArtifact(env, route.runId, route.artifactId, requestId);
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
      SELECT id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state
      FROM run_artifacts WHERE run_id = ? AND state = 'ready' AND expires_at > ?
      ORDER BY created_at DESC, id LIMIT ?
    `).bind(runId, new Date().toISOString(), MAX_ARTIFACTS_PER_RUN).all<ArtifactRow>();
    return successResponse(requestId, { artifacts: rows.results.map(publicArtifact) });
  } catch {
    return errorResponse(requestId, 503, "ARTIFACT_LIST_UNAVAILABLE", "Soyuz could not read artifact metadata. Retry shortly.");
  }
}

async function readClientArtifact(env: Env, runId: string, artifactId: string, requestId: string): Promise<Response> {
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
  if (Date.parse(row.expires_at) <= Date.now()) {
    await expireArtifact(env, row);
    return errorResponse(requestId, 410, "ARTIFACT_EXPIRED", "Artifact has expired.");
  }

  let object: R2ObjectBody | null;
  try {
    object = await readArtifactObject(env, row);
  } catch {
    return errorResponse(requestId, 503, "ARTIFACT_READ_UNAVAILABLE", "Soyuz could not read artifact content. Retry shortly.");
  }
  if (!object) return errorResponse(requestId, 404, "ARTIFACT_CONTENT_NOT_FOUND", "Artifact content was not found");

  return new Response(object.body, { status: 200, headers: artifactDownloadHeaders(row) });
}

async function findReadyArtifact(env: Env, runId: string, artifactId: string): Promise<ArtifactRow | null> {
  return env.DB.prepare(`
    SELECT id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state
    FROM run_artifacts WHERE run_id = ? AND id = ? AND state = 'ready'
  `).bind(runId, artifactId).first<ArtifactRow>();
}

async function readArtifactObject(env: Env, row: ArtifactRow): Promise<R2ObjectBody | null> {
  return env.ARTIFACTS!.get(row.object_key);
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

async function expireArtifact(env: Env, row: ArtifactRow): Promise<void> {
  if (!env.ARTIFACTS) return;
  try {
    await env.ARTIFACTS.delete(row.object_key);
    await env.DB.prepare("DELETE FROM run_artifacts WHERE id = ?").bind(row.id).run();
  } catch {
    // The scheduled retention sweep retries if either store is temporarily unavailable.
  }
}

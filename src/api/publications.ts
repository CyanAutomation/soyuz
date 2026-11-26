import type { Env } from "../env";
import { getRun } from "../db/runs";
import { safeHttpUrlForDisplay } from "../lib/safe-url";
import { isUuid } from "../lib/uuid";
import { ApiError, errorResponse, parseJsonBody, readRequestBodyBytes, successResponse } from "./http";
import { canonicalJson, digestHex, githubRepository, validatePublicationArtifact, type PublicationArtifact, type PublicationRequest } from "../publication/contract-v1";
import { PublicationIntentSchema } from "../publication/rpc-v1";
import { buildPublicationRequest, legacyPublishedUrl, reconcilePublicationEligibility, safePublicationProjection, type PublicationIntentRow, type PublicationRow } from "../publication/lifecycle";
import { createUuidV7 } from "../publication/uuid-v7";
import { isPublicationAllowed } from "../publication/policy";

const MAX_MANIFEST_UPLOAD_BYTES = 9 * 1024 * 1024;
const SENSITIVE_VALIDATION_EVIDENCE_LIMIT = 100;

type WorkerAccess = { workerId: string; claimCallbackId: string; run: NonNullable<Awaited<ReturnType<typeof getRun>>> };
type ManifestArtifactRow = {
  artifact_id: string;
  run_id: string;
  content_digest: string;
  object_key: string;
  state: string;
  worker_id: string;
  claim_callback_id: string;
};
type PublicationIntentInput = ReturnType<typeof PublicationIntentSchema.parse>;
type UploadedPublicationManifest = {
  object_key: string;
  size_bytes: number;
  artifact: PublicationArtifact;
};

export async function handleWorkerPublication(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
): Promise<Response | null> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "v1" || segments[1] !== "worker" || segments[2] !== "runs") return null;
  if (segments.length === 6 && segments[4] === "publication-manifests") {
    if (request.method !== "PUT") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Publication manifest routes accept PUT requests");
    const runId = segments[3]!;
    const artifactId = segments[5]!;
    if (!isUuid7(runId) || !isUuid7(artifactId)) return errorResponse(requestId, 404, "ARTIFACT_NOT_FOUND", "Publication manifest was not found");
    const access = await authorizeCurrentClaim(request, env, runId, requestId);
    if (access instanceof Response) return access;
    return uploadManifest(request, env, access, artifactId, requestId);
  }
  if (segments.length === 5 && segments[4] === "publication-intents") {
    if (request.method !== "POST") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Publication intent routes accept POST requests");
    const runId = segments[3]!;
    if (!isUuid7(runId)) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
    const access = await authorizeCurrentClaim(request, env, runId, requestId);
    if (access instanceof Response) return access;
    return registerPublicationIntent(request, env, access, requestId);
  }
  return null;
}

export async function handleClientPublicationStatus(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
): Promise<Response | null> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "v1" || segments[1] !== "runs" || segments[3] !== "publication") return null;
  if (request.method !== "GET") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Publication status is read-only");
  const runId = segments[2]!;
  if (!isUuid(runId)) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
  try {
    const publication = await env.DB.prepare("SELECT * FROM publications WHERE run_id = ? AND expires_at > ?")
      .bind(runId, new Date().toISOString()).first<PublicationRow>();
    const run = await getRun(env.DB, runId);
    return successResponse(requestId, {
      publication: publication ? safePublicationProjection(publication) : null,
      legacyPublishedUrl: legacyPublishedUrl(run) ? safeHttpUrlForDisplay(legacyPublishedUrl(run)!) : null,
    });
  } catch {
    return errorResponse(requestId, 503, "PUBLICATION_STATUS_UNAVAILABLE", "Soyuz could not read publication status. Retry shortly.");
  }
}

async function authorizeCurrentClaim(request: Request, env: Env, runId: string, requestId: string): Promise<WorkerAccess | Response> {
  const workerId = request.headers.get("x-soyuz-worker-id")?.trim() ?? "";
  const claimCallbackId = request.headers.get("x-soyuz-claim-callback-id")?.trim() ?? "";
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(workerId)) {
    return errorResponse(requestId, 400, "WORKER_ID_REQUIRED", "Publication callbacks require a valid worker ID.");
  }
  if (!isUuid(claimCallbackId)) {
    return errorResponse(requestId, 400, "CLAIM_CALLBACK_ID_REQUIRED", "Publication callbacks require the current claim callback ID.");
  }
  let run;
  try {
    run = await getRun(env.DB, runId);
  } catch {
    return errorResponse(requestId, 503, "RUN_READ_UNAVAILABLE", "Soyuz could not read the run state. Retry shortly.");
  }
  if (!run) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");
  if (run.status !== "running") return errorResponse(requestId, 409, "RUN_NOT_ACTIVE", "Publication intents require a running execution.");
  if (run.worker_id !== workerId) return errorResponse(requestId, 409, "WORKER_MISMATCH", "Worker does not own this run");
  if (!run.claim_callback_id || run.claim_callback_id !== claimCallbackId) {
    return errorResponse(requestId, 409, "STALE_CLAIM", "This claim attempt is no longer current");
  }
  return { run, workerId, claimCallbackId };
}

async function uploadManifest(
  request: Request,
  env: Env,
  access: WorkerAccess,
  artifactId: string,
  requestId: string,
): Promise<Response> {
  if (!env.ARTIFACTS) return errorResponse(requestId, 503, "ARTIFACT_STORAGE_UNAVAILABLE", "Artifact storage is not configured.");
  const body = await readManifestUpload(request, requestId);
  if ("response" in body) return body.response;
  const validation = await validateUploadedManifest(body.value, access, artifactId, requestId);
  if ("response" in validation) return validation.response;

  const bytes = body.bytes;
  const rawDigest = await digestHex(bytes);
  const objectKey = `publication-manifests/${access.run.id}/${artifactId}`;
  const now = new Date().toISOString();
  const expiry = access.run.expires_at;

  let reservation: { existing: ManifestArtifactRow } | { response: Response };
  try {
    reservation = await reserveManifestUpload(env, access, artifactId, rawDigest, bytes.byteLength, objectKey, now, expiry, requestId);
  } catch {
    return errorResponse(requestId, 503, "MANIFEST_INDEX_RESERVATION_UNAVAILABLE", "Soyuz could not reserve the manifest in its D1 index. Retry with the same artifact ID.");
  }
  if ("response" in reservation) return reservation.response;

  try {
    await env.ARTIFACTS.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { runId: access.run.id, artifactId, kind: "publication_manifest", sha256: validation.digest },
    });
  } catch {
    return errorResponse(requestId, 503, "MANIFEST_OBJECT_WRITE_UNAVAILABLE", "Soyuz could not write the manifest object to R2. Retry with the same artifact ID.");
  }

  let ready: boolean;
  try {
    ready = await markManifestReady(env, access, artifactId, rawDigest);
  } catch {
    return errorResponse(requestId, 503, "MANIFEST_INDEX_FINALIZATION_UNAVAILABLE", "Soyuz wrote the manifest object but could not finalize its D1 index. Retry with the same artifact ID.");
  }
  if (!ready) {
    return errorResponse(requestId, 409, "STALE_CLAIM", "Worker claim changed while storing the publication manifest.");
  }
  return successResponse(requestId, {
    artifactId,
    runId: access.run.id,
    artifactDigest: validation.digest,
    size: bytes.byteLength,
    expiresAt: reservation.existing.state === "ready" ? undefined : expiry,
  }, reservation.existing.state === "ready" ? 200 : 201);
}

async function readManifestUpload(request: Request, requestId: string): Promise<
  { bytes: Uint8Array; value: unknown } | { response: Response }
> {
  const length = parseContentLength(request.headers.get("content-length"));
  if (length === null) {
    return { response: errorResponse(requestId, 411, "CONTENT_LENGTH_REQUIRED", "Manifest upload requires a valid Content-Length header.") };
  }
  if (length < 1 || length > MAX_MANIFEST_UPLOAD_BYTES) {
    return { response: errorResponse(requestId, 413, "MANIFEST_TOO_LARGE", "Publication manifests must be no larger than 9 MiB.") };
  }
  try {
    const bytes = await readRequestBodyBytes(request, MAX_MANIFEST_UPLOAD_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return { bytes, value };
  } catch {
    return { response: errorResponse(requestId, 400, "MANIFEST_INVALID", "Publication manifest must be valid UTF-8 JSON.") };
  }
}

async function validateUploadedManifest(
  value: unknown,
  access: WorkerAccess,
  artifactId: string,
  requestId: string,
): Promise<{ artifact: PublicationArtifact; digest: string } | { response: Response }> {
  if (!githubRepository(access.run.repo_url)) {
    return { response: errorResponse(requestId, 409, "PUBLICATION_DESTINATION_INVALID", "Run destination is not a canonical GitHub repository.") };
  }
  try {
    return await validatePublicationArtifact(value, {
      runId: access.run.id,
      artifactId,
      repositoryUrl: access.run.repo_url,
      baseRef: access.run.git_ref,
    });
  } catch {
    return { response: errorResponse(requestId, 422, "MANIFEST_INVALID", "Publication manifest did not satisfy Kirisame contract v1.") };
  }
}

async function reserveManifestUpload(
  env: Env,
  access: WorkerAccess,
  artifactId: string,
  rawDigest: string,
  size: number,
  objectKey: string,
  now: string,
  expiry: string,
  requestId: string,
): Promise<{ existing: ManifestArtifactRow } | { response: Response }> {
  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO publication_manifest_artifacts (
      artifact_id, run_id, content_digest, size_bytes, object_key, worker_id, claim_callback_id, state, created_at, expires_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? FROM runs
      WHERE id = ? AND status = 'running' AND worker_id = ? AND expires_at > ?
      AND (SELECT event_id FROM run_events WHERE run_id = runs.id AND type = 'run.claimed' ORDER BY sequence DESC LIMIT 1) = ?
  `).bind(artifactId, access.run.id, rawDigest, size, objectKey, access.workerId, access.claimCallbackId, now, expiry,
    access.run.id, access.workerId, now, access.claimCallbackId).run();
  let existing = await readManifestArtifact(env, artifactId);
  if (existing && (existing.run_id !== access.run.id || existing.content_digest !== rawDigest)) {
    return { response: errorResponse(requestId, 409, "ARTIFACT_ID_CONFLICT", "A different publication manifest already uses this artifact ID.") };
  }
  if (!existing) {
    const noClaim = Number(inserted.meta?.changes ?? 0) === 0;
    return { response: noClaim
      ? errorResponse(requestId, 409, "STALE_CLAIM", "Worker claim changed during manifest upload.")
      : errorResponse(requestId, 503, "MANIFEST_INDEX_UNAVAILABLE", "Soyuz could not index the publication manifest.") };
  }
  if (!isCurrentManifestClaim(existing, access)) {
    if (!await rebindManifestClaim(env, access, artifactId, rawDigest)) {
      return { response: errorResponse(requestId, 409, "STALE_CLAIM", "Worker claim changed before the manifest upload could be recovered.") };
    }
    const rebound = await readManifestArtifact(env, artifactId);
    if (!isCurrentManifestClaim(rebound, access)) {
      return { response: errorResponse(requestId, 409, "STALE_CLAIM", "Worker claim changed before the manifest upload could be recovered.") };
    }
    existing = rebound;
  }
  return { existing };
}

async function readManifestArtifact(env: Env, artifactId: string): Promise<ManifestArtifactRow | null> {
  return env.DB.prepare("SELECT * FROM publication_manifest_artifacts WHERE artifact_id = ?")
    .bind(artifactId).first<ManifestArtifactRow>();
}

function isCurrentManifestClaim(row: ManifestArtifactRow | null, access: WorkerAccess): row is ManifestArtifactRow {
  return Boolean(row && row.worker_id === access.workerId && row.claim_callback_id === access.claimCallbackId);
}

async function rebindManifestClaim(env: Env, access: WorkerAccess, artifactId: string, rawDigest: string): Promise<boolean> {
  const rebound = await env.DB.prepare(`UPDATE publication_manifest_artifacts
    SET worker_id = ?, claim_callback_id = ?, state = 'pending'
    WHERE artifact_id = ? AND run_id = ? AND content_digest = ? AND state IN ('pending', 'ready')
      AND NOT EXISTS (SELECT 1 FROM publication_intents WHERE artifact_id = ?)
      AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = 'running' AND worker_id = ?
        AND (SELECT event_id FROM run_events WHERE run_id = runs.id AND type = 'run.claimed' ORDER BY sequence DESC LIMIT 1) = ?)`)
    .bind(access.workerId, access.claimCallbackId, artifactId, access.run.id, rawDigest, artifactId,
      access.run.id, access.workerId, access.claimCallbackId).run();
  return Number(rebound.meta?.changes ?? 0) === 1;
}

async function markManifestReady(env: Env, access: WorkerAccess, artifactId: string, rawDigest: string): Promise<boolean> {
  const ready = await env.DB.prepare(`UPDATE publication_manifest_artifacts SET state = 'ready'
    WHERE artifact_id = ? AND run_id = ? AND content_digest = ? AND state IN ('pending', 'ready')
      AND worker_id = ? AND claim_callback_id = ?
      AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = 'running' AND worker_id = ?
        AND (SELECT event_id FROM run_events WHERE run_id = runs.id AND type = 'run.claimed' ORDER BY sequence DESC LIMIT 1) = ?)`)
    .bind(artifactId, access.run.id, rawDigest, access.workerId, access.claimCallbackId,
      access.run.id, access.workerId, access.claimCallbackId).run();
  return Number(ready.meta?.changes ?? 0) === 1;
}

async function registerPublicationIntent(request: Request, env: Env, access: WorkerAccess, requestId: string): Promise<Response> {
  if (!env.ARTIFACTS) return errorResponse(requestId, 503, "ARTIFACT_STORAGE_UNAVAILABLE", "Artifact storage is not configured.");
  let data: PublicationIntentInput;
  try {
    data = PublicationIntentSchema.parse(await parseJsonBody(request, requestId));
  } catch {
    return errorResponse(requestId, 422, "PUBLICATION_INTENT_INVALID", "Publication intent failed contract validation.");
  }
  if (access.run.publish_mode !== data.mode || access.run.task_mode !== "patch") {
    return errorResponse(requestId, 409, "RUN_PUBLICATION_NOT_AUTHORIZED", "The canonical run request did not authorize this publication mode and task type.");
  }

  try {
    const stored = await loadAuthorizedManifest(env, access, data, requestId);
    if ("response" in stored) return stored.response;
    const evidenceEvent = await findTrustedValidationEvidence(env, access, stored.artifact, data.artifactDigest);
    if (!evidenceEvent) return errorResponse(requestId, 409, "VALIDATION_EVIDENCE_REQUIRED", "The current authenticated worker claim has not recorded matching successful validation evidence.");
    if (!isPublicationAllowed(env, stored.artifact.repository, stored.artifact.baseRef, data.mode)) {
      return errorResponse(requestId, 403, "PUBLICATION_POLICY_DENIED", "Publication destination, base branch, or mode is not explicitly authorized.");
    }
    return await persistPublicationIntent(env, access, data, stored, evidenceEvent.event_id, requestId);
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse(requestId);
    return errorResponse(requestId, 503, "PUBLICATION_INTENT_UNAVAILABLE", "Soyuz could not verify or register this publication intent.");
  }
}

async function loadAuthorizedManifest(
  env: Env,
  access: WorkerAccess,
  data: PublicationIntentInput,
  requestId: string,
): Promise<UploadedPublicationManifest | { response: Response }> {
  const uploaded = await env.DB.prepare(`SELECT * FROM publication_manifest_artifacts WHERE artifact_id = ? AND run_id = ?`)
    .bind(data.artifactId, access.run.id).first<{
      artifact_id: string;
      run_id: string;
      object_key: string;
      content_digest: string;
      size_bytes: number;
      state: string;
      worker_id: string;
      claim_callback_id: string;
    }>();
  if (!uploaded || uploaded.state !== "ready" || uploaded.worker_id !== access.workerId || uploaded.claim_callback_id !== access.claimCallbackId) {
    return { response: errorResponse(requestId, 409, "MANIFEST_NOT_AUTHORIZED", "The matching uploaded manifest is unavailable for this worker claim.") };
  }
  const object = await env.ARTIFACTS!.get(uploaded.object_key);
  if (!object || object.size !== uploaded.size_bytes) {
    return { response: errorResponse(requestId, 409, "MANIFEST_NOT_FOUND", "Publication manifest content is unavailable.") };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await digestHex(bytes) !== uploaded.content_digest) {
    return { response: errorResponse(requestId, 409, "MANIFEST_INTEGRITY_FAILED", "Stored publication manifest failed integrity verification.") };
  }
  const manifestValue: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  try {
    const validated = await validatePublicationArtifact(manifestValue, {
      runId: access.run.id,
      artifactId: data.artifactId,
      repositoryUrl: access.run.repo_url,
      baseRef: access.run.git_ref,
    }, data.artifactDigest);
    return { object_key: uploaded.object_key, size_bytes: uploaded.size_bytes, artifact: validated.artifact };
  } catch {
    return { response: errorResponse(requestId, 422, "ARTIFACT_DIGEST_OR_PROVENANCE_INVALID", "The stored manifest does not match its authorized digest or run destination.") };
  }
}

async function persistPublicationIntent(
  env: Env,
  access: WorkerAccess,
  data: PublicationIntentInput,
  stored: UploadedPublicationManifest,
  validationEventId: string,
  requestId: string,
): Promise<Response> {
  const request = createPublicationRequest(access, data, stored.artifact);
  const fingerprint = await digestHex(new TextEncoder().encode(canonicalJson(request)));
  const now = new Date().toISOString();
  const inserted = await insertPublicationIntent(env, access, data, stored, request, fingerprint, validationEventId, now);
  const intent = await env.DB.prepare("SELECT * FROM publication_intents WHERE run_id = ?")
    .bind(access.run.id).first<PublicationIntentRow>();
  if (!intent) {
    if (Number(inserted.meta?.changes ?? 0) === 0) {
      return errorResponse(requestId, 409, "STALE_CLAIM", "Worker claim changed during publication authorization.");
    }
    return errorResponse(requestId, 503, "PUBLICATION_INTENT_UNAVAILABLE", "Soyuz could not persist publication authorization.");
  }
  if (!await matchesPublicationIntent(intent, data, stored.artifact)) {
    return errorResponse(requestId, 409, "PUBLICATION_INTENT_CONFLICT", "A different publication intent already exists for this run.");
  }
  const created = isNewPublicationIntent(inserted, intent, now);
  if (created) await insertPublicationRequestedEvent(env, access, intent, now);
  if (access.run.status === "completed") await reconcilePublicationEligibility(env, access.run.id);
  return successResponse(requestId, {
    publicationId: intent.publication_id,
    runId: intent.run_id,
    state: intent.state,
    mode: intent.mode,
    artifactDigest: intent.artifact_digest,
  }, created ? 201 : 200);
}

function isNewPublicationIntent(
  inserted: D1Result,
  intent: PublicationIntentRow,
  now: string,
): boolean {
  return Number(inserted.meta?.changes ?? 0) === 1 || intent.created_at === now;
}

function createPublicationRequest(
  access: WorkerAccess,
  data: PublicationIntentInput,
  artifact: PublicationArtifact,
): PublicationRequest {
  const publicationId = createUuidV7();
  return {
    contractVersion: "1",
    publicationId,
    runId: access.run.id,
    repository: artifact.repository,
    mode: data.mode,
    baseRef: artifact.baseRef,
    baseSha: artifact.baseSha,
    headRef: `kirisame/p/${publicationId}`,
    ...(data.mode === "pr" ? { title: data.title!, body: data.body! } : {}),
    artifact,
    artifactDigest: data.artifactDigest,
  };
}

async function insertPublicationIntent(
  env: Env,
  access: WorkerAccess,
  data: PublicationIntentInput,
  stored: UploadedPublicationManifest,
  request: PublicationRequest,
  fingerprint: string,
  validationEventId: string,
  now: string,
) {
  return env.DB.prepare(`
    INSERT OR IGNORE INTO publication_intents (
      publication_id, run_id, contract_version, request_fingerprint, artifact_id, artifact_digest, artifact_object_key,
      repository_owner, repository_name, mode, base_ref, base_sha, head_ref, title, body, worker_id, claim_callback_id,
      validation_event_id, state, created_at, updated_at
    )
    SELECT ?, ?, '1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?, ?
    FROM runs WHERE id = ? AND status = 'running' AND worker_id = ? AND expires_at > ?
      AND (SELECT event_id FROM run_events WHERE run_id = runs.id AND type = 'run.claimed' ORDER BY sequence DESC LIMIT 1) = ?
  `).bind(request.publicationId, access.run.id, fingerprint, data.artifactId, data.artifactDigest, stored.object_key,
    request.repository.owner, request.repository.name, data.mode, request.baseRef,
    request.baseSha, request.headRef, data.title ?? null, data.body ?? null, access.workerId,
    access.claimCallbackId, validationEventId, now, now, access.run.id, access.workerId, now, access.claimCallbackId).run();
}

async function matchesPublicationIntent(
  intent: PublicationIntentRow,
  data: PublicationIntentInput,
  artifact: PublicationArtifact,
): Promise<boolean> {
  const replayRequest = buildPublicationRequest(intent, artifact);
  const replayFingerprint = await digestHex(new TextEncoder().encode(canonicalJson(replayRequest)));
  return intent.request_fingerprint === replayFingerprint
    && intent.artifact_digest === data.artifactDigest
    && intent.artifact_id === data.artifactId
    && intent.mode === data.mode
    && intent.title === (data.title ?? null)
    && intent.body === (data.body ?? null)
    && intent.state !== "abandoned";
}

async function insertPublicationRequestedEvent(env: Env, access: WorkerAccess, intent: PublicationIntentRow, now: string): Promise<void> {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO publication_events (publication_id, event_id, run_id, event_type, state, occurred_at, metadata_json)
    VALUES (?, ?, ?, 'publication.requested', 'pending', ?, ?)
  `).bind(intent.publication_id, createUuidV7(), access.run.id, now,
    JSON.stringify({ mode: intent.mode, repository: `${intent.repository_owner}/${intent.repository_name}`, artifactDigest: intent.artifact_digest })).run();
}

async function findTrustedValidationEvidence(
  env: Env,
  access: WorkerAccess,
  artifact: PublicationArtifact,
  artifactDigest: string,
): Promise<{ event_id: string } | null> {
  const events = await env.DB.prepare(`
    SELECT event_id, payload_json FROM run_events
    WHERE run_id = ? AND worker_id = ? AND type = 'validation.completed'
    ORDER BY sequence DESC LIMIT ?
  `).bind(access.run.id, access.workerId, SENSITIVE_VALIDATION_EVIDENCE_LIMIT).all<{ event_id: string; payload_json: string }>();
  for (const event of events.results ?? []) {
    if (isTrustedValidationEvidence(event.payload_json, access, artifact, artifactDigest)) return { event_id: event.event_id };
  }
  return null;
}

function isTrustedValidationEvidence(
  payloadJson: string,
  access: WorkerAccess,
  artifact: PublicationArtifact,
  artifactDigest: string,
): boolean {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const evidence = payload.publicationEvidence as Record<string, unknown> | undefined;
    const repository = evidence?.repository as Record<string, unknown> | undefined;
    return payload.claimCallbackId === access.claimCallbackId
      && evidence?.evidenceVersion === "1"
      && evidence.outcome === "passed"
      && evidence.artifactId === artifact.artifactId
      && evidence.artifactDigest === artifactDigest
      && evidence.runId === artifact.runId
      && evidence.baseRef === artifact.baseRef
      && evidence.baseSha === artifact.baseSha
      && repository?.owner === artifact.repository.owner
      && repository?.name === artifact.repository.name;
  } catch {
    // Malformed historical callback data is not evidence.
    return false;
  }
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : null;
}

function isUuid7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

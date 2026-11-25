import type { Env } from "../env";
import { stableStringify } from "../lib/canonical-json";
import { parseResult, type RunRow } from "../db/runs";
import { canonicalJson, digestHex, validatePublicationArtifact, type PublicationArtifact, type PublicationRequest } from "./contract-v1";
import { KirisameErrorSchema, PublicationResultSchema, type KirisameError, type PublicationResult, type PublisherEntrypoint } from "./rpc-v1";
import { createUuidV7 } from "./uuid-v7";

const PUBLICATION_MAX_ATTEMPTS = 8;
export const PUBLICATION_DISPATCH_BATCH_SIZE = 10;
export const PUBLICATION_LEASE_MS = 2 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface PublicationRow {
  publication_id: string;
  run_id: string;
  contract_version: "1";
  request_fingerprint: string;
  artifact_id: string;
  artifact_digest: string;
  artifact_object_key: string;
  repository_owner: string;
  repository_name: string;
  mode: "branch" | "pr";
  base_ref: string;
  base_sha: string;
  head_ref: string;
  title: string | null;
  body: string | null;
  state: "pending" | "publishing" | "published" | "retryable_failure" | "blocked";
  attempt_count: number;
  attempt_id: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  last_error_code: string | null;
  branch_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  retained_until: string | null;
}

export interface PublicationIntentRow extends Omit<PublicationRow,
  "state" | "attempt_count" | "attempt_id" | "lease_expires_at" | "next_attempt_at" | "last_error_code"
  | "branch_sha" | "pr_number" | "pr_url" | "completed_at"> {
  worker_id: string;
  claim_callback_id: string;
  validation_event_id: string;
  state: "authorized" | "consumed" | "abandoned";
}

export function buildPublicationRequest(row: Pick<PublicationRow,
  "publication_id" | "run_id" | "repository_owner" | "repository_name" | "mode" | "base_ref" | "base_sha" | "head_ref" | "title" | "body" | "artifact_digest">,
  artifact: PublicationArtifact,
): PublicationRequest {
  return {
    contractVersion: "1",
    publicationId: row.publication_id,
    runId: row.run_id,
    repository: { owner: row.repository_owner, name: row.repository_name },
    mode: row.mode,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    headRef: row.head_ref,
    ...(row.mode === "pr" ? { title: row.title!, body: row.body! } : {}),
    artifact,
    artifactDigest: row.artifact_digest,
  };
}

/** Move explicitly registered, validated intent into the independent publication ledger. */
export async function reconcilePublicationEligibility(env: Env, runId?: string, at = new Date()): Promise<void> {
  const now = at.toISOString();
  const rows = runId
    ? await env.DB.prepare(`
        SELECT i.*, r.status AS run_status, r.result_json
        FROM publication_intents i LEFT JOIN runs r ON r.id = i.run_id
        WHERE i.state = 'authorized' AND i.run_id = ?
      `).bind(runId).all<PublicationIntentRow & { run_status: RunRow["status"] | null; result_json: string | null }>()
    : await env.DB.prepare(`
        SELECT i.*, r.status AS run_status, r.result_json
        FROM publication_intents i LEFT JOIN runs r ON r.id = i.run_id
        WHERE i.state = 'authorized' ORDER BY i.created_at LIMIT 100
      `).all<PublicationIntentRow & { run_status: RunRow["status"] | null; result_json: string | null }>();

  for (const row of rows.results ?? []) {
    const result = safeJsonRecord(row.result_json);
    if (row.run_status === "failed" || row.run_status === "cancelled" || row.run_status === "admission_failed"
      || (row.run_status === "completed" && typeof result.publishedUrl === "string")) {
      await abandonIntent(env, row, now);
      continue;
    }
    if (row.run_status !== "completed") continue;

    const eventId = createUuidV7(at.getTime());
    const statements = [
      env.DB.prepare(`
        INSERT OR IGNORE INTO publications (
          publication_id, run_id, contract_version, request_fingerprint, artifact_id, artifact_digest, artifact_object_key,
          repository_owner, repository_name, mode, base_ref, base_sha, head_ref, title, body, state, attempt_count,
          created_at, updated_at
        )
        SELECT i.publication_id, i.run_id, i.contract_version, i.request_fingerprint, i.artifact_id, i.artifact_digest,
          i.artifact_object_key, i.repository_owner, i.repository_name, i.mode, i.base_ref, i.base_sha, i.head_ref,
          i.title, i.body, 'pending', 0, ?, ?
        FROM publication_intents i JOIN runs r ON r.id = i.run_id
        WHERE i.publication_id = ? AND i.state = 'authorized' AND r.status = 'completed'
          AND (r.result_json IS NULL OR json_extract(r.result_json, '$.publishedUrl') IS NULL)
      `).bind(now, now, row.publication_id),
      env.DB.prepare(`
        UPDATE publication_intents SET state = 'consumed', updated_at = ?
        WHERE publication_id = ? AND state = 'authorized'
          AND EXISTS (SELECT 1 FROM publications p WHERE p.publication_id = publication_intents.publication_id)
      `).bind(now, row.publication_id),
      env.DB.prepare(`
        INSERT OR IGNORE INTO publication_events (publication_id, event_id, run_id, event_type, state, occurred_at, metadata_json)
        SELECT publication_id, ?, run_id, 'publication.reconciled', 'pending', ?, '{"reason":"execution_completed"}'
        FROM publications WHERE publication_id = ?
      `).bind(eventId, now, row.publication_id),
    ];
    await env.DB.batch(statements);
  }
}

async function abandonIntent(env: Env, row: PublicationIntentRow, at: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE publication_intents SET state = 'abandoned', updated_at = ?, retained_until = ?
    WHERE publication_id = ? AND state = 'authorized'
      AND NOT EXISTS (SELECT 1 FROM publications WHERE publications.publication_id = publication_intents.publication_id)
  `).bind(at, new Date(Date.parse(at) + RETENTION_MS).toISOString(), row.publication_id).run();
}

/** The cron calls this with no publisher in production until Phase 2C is enabled. */
export async function reconcilePublications(env: Env, at = new Date(), injectedPublisher?: PublisherEntrypoint): Promise<void> {
  await reconcilePublicationEligibility(env, undefined, at);
  const publisher = injectedPublisher ?? (env.PUBLICATION_DISPATCH_ENABLED === "true" ? env.KIRISAME : undefined);
  if (!publisher) return;

  const now = at.toISOString();
  const due = await env.DB.prepare(`
    SELECT * FROM publications
    WHERE (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
      OR (state = 'retryable_failure' AND next_attempt_at <= ?)
      OR (state = 'publishing' AND lease_expires_at <= ?)
    ORDER BY COALESCE(next_attempt_at, created_at), publication_id LIMIT ?
  `).bind(now, now, now, PUBLICATION_DISPATCH_BATCH_SIZE).all<PublicationRow>();
  for (const row of due.results ?? []) {
    await dispatchPublication(env, row, publisher, at);
  }
}

export async function dispatchPublication(
  env: Env,
  current: PublicationRow,
  publisher: PublisherEntrypoint,
  at = new Date(),
  timeoutMs = 30_000,
): Promise<boolean> {
  const attemptId = await reservePublicationAttempt(env, current, at);
  if (!attemptId) return false;
  await appendPublicationStartedEvent(env, current, attemptId, at);

  const request = await verifiedPublicationRequest(env, current, attemptId, at);
  if (!request) return true;

  const response = await callPublisher(env, publisher, request, timeoutMs);
  if (!response.ok) {
    await scheduleRetry(env, current, attemptId, response.errorCode, undefined, at);
    return true;
  }
  await recordPublisherResponse(env, current, attemptId, response.raw, at);
  return true;
}

async function reservePublicationAttempt(env: Env, current: PublicationRow, at: Date): Promise<string | null> {
  const now = at.toISOString();
  const attemptId = createUuidV7(at.getTime());
  const leaseUntil = new Date(at.getTime() + PUBLICATION_LEASE_MS).toISOString();
  const eventId = createUuidV7(at.getTime());
  const oldAttemptExpired = current.state === "publishing";
  const reservation = await env.DB.batch([
    env.DB.prepare(`
      UPDATE publications SET state = 'publishing', attempt_count = attempt_count + 1, attempt_id = ?, lease_expires_at = ?,
        next_attempt_at = NULL, updated_at = ?
      WHERE publication_id = ? AND request_fingerprint = ? AND attempt_count < ? AND (
        state = 'pending'
        OR (state = 'retryable_failure' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (state = 'publishing' AND lease_expires_at <= ?)
      )
    `).bind(attemptId, leaseUntil, now, current.publication_id, current.request_fingerprint, PUBLICATION_MAX_ATTEMPTS, now, now),
    env.DB.prepare(`
      INSERT INTO publication_events (publication_id, event_id, run_id, event_type, state, attempt_id, occurred_at, metadata_json)
      SELECT publication_id, ?, run_id, 'publication.attempt_reserved', 'publishing', ?, ?, ?
      FROM publications WHERE publication_id = ? AND state = 'publishing' AND attempt_id = ?
    `).bind(eventId, attemptId, now, stableStringify({ attempt: current.attempt_count + 1, reconciledExpiredLease: oldAttemptExpired }), current.publication_id, attemptId),
    env.DB.prepare(`
      INSERT INTO publication_events (publication_id, event_id, run_id, event_type, state, attempt_id, occurred_at, metadata_json)
      SELECT publication_id, ?, run_id, 'publication.reconciled', 'publishing', ?, ?, '{"reason":"expired_lease_recovered"}'
      FROM publications WHERE ? = 1 AND publication_id = ? AND state = 'publishing' AND attempt_id = ?
    `).bind(createUuidV7(at.getTime()), attemptId, now, oldAttemptExpired ? 1 : 0, current.publication_id, attemptId),
  ]);
  return Number(reservation[0]?.meta?.changes ?? 0) === 1 ? attemptId : null;
}

async function appendPublicationStartedEvent(env: Env, current: PublicationRow, attemptId: string, at: Date): Promise<void> {
  const now = at.toISOString();
  const startedEvent = createUuidV7(at.getTime());
  await env.DB.prepare(`
    INSERT OR IGNORE INTO publication_events (publication_id, event_id, run_id, event_type, state, attempt_id, occurred_at, metadata_json)
    SELECT publication_id, ?, run_id, 'publication.started', 'publishing', ?, ?, '{}'
    FROM publications WHERE publication_id = ? AND state = 'publishing' AND attempt_id = ? AND request_fingerprint = ?
  `).bind(startedEvent, attemptId, now, current.publication_id, attemptId, current.request_fingerprint).run();
}

async function verifiedPublicationRequest(
  env: Env,
  current: PublicationRow,
  attemptId: string,
  at: Date,
): Promise<PublicationRequest | null> {
  const manifest = await loadAndVerifyManifest(env, current);
  if (!manifest) {
    await finishAttempt(env, current, attemptId, {
      state: "blocked", errorCode: "ARTIFACT_INVALID", eventType: "publication.blocked", at,
    });
    return null;
  }

  const request = buildPublicationRequest(current, manifest);
  const fingerprint = await digestHex(new TextEncoder().encode(canonicalJson(request)));
  if (fingerprint !== current.request_fingerprint) {
    await finishAttempt(env, current, attemptId, {
      state: "blocked", errorCode: "REQUEST_FINGERPRINT_MISMATCH", eventType: "publication.blocked", at,
    });
    return null;
  }
  return request;
}

type PublisherCallResult = { ok: true; raw: unknown } | { ok: false; errorCode: "GITHUB_TIMEOUT" | "GITHUB_UNAVAILABLE" };

async function callPublisher(
  env: Env,
  publisher: PublisherEntrypoint,
  request: PublicationRequest,
  timeoutMs: number,
): Promise<PublisherCallResult> {
  try {
    return {
      ok: true,
      raw: await withTimeout(publisher.publish(
        JSON.stringify(request),
        env.KIRISAME_CALLER_ID ?? "",
        env.KIRISAME_API_KEY ?? "",
      ), timeoutMs),
    };
  } catch (error) {
    const timeout = error instanceof PublicationTimeoutError;
    return { ok: false, errorCode: timeout ? "GITHUB_TIMEOUT" : "GITHUB_UNAVAILABLE" };
  }
}

async function recordPublisherResponse(
  env: Env,
  current: PublicationRow,
  attemptId: string,
  raw: unknown,
  at: Date,
): Promise<void> {
  if (await handleStandalonePublisherError(env, current, attemptId, raw, at)) return;
  const result = parseValidPublisherResult(raw, current);
  if (!result) {
    await finishAttempt(env, current, attemptId, {
      state: "blocked", errorCode: "INVALID_PUBLISHER_RESPONSE", eventType: "publication.blocked", at,
    });
    return;
  }
  await recordPublicationOutcome(env, current, attemptId, result, at);
}

function parseValidPublisherResult(raw: unknown, current: PublicationRow): PublicationResult | null {
  const parsed = PublicationResultSchema.safeParse(raw);
  if (!parsed.success || !resultMatchesRequest(current, parsed.data)) return null;
  if (parsed.data.error && !errorClassificationMatches(parsed.data.error)) return null;
  return parsed.data;
}

async function recordPublicationOutcome(
  env: Env,
  current: PublicationRow,
  attemptId: string,
  result: PublicationResult,
  at: Date,
): Promise<void> {
  if (result.outcome === "retryable_failure") {
    const retryAfter = result.error?.retryAfterSeconds;
    await scheduleRetry(env, current, attemptId, result.error?.code ?? "GITHUB_UNAVAILABLE", retryAfter, at);
    return;
  } else if (result.outcome === "blocked") {
    await finishAttempt(env, current, attemptId, {
      state: "blocked", errorCode: result.error?.code ?? "PUBLISHING_BLOCKED", eventType: "publication.blocked", at,
    });
    return;
  }

  await recordSuccessfulPublication(env, current, attemptId, result, at);
}

async function recordSuccessfulPublication(
  env: Env,
  current: PublicationRow,
  attemptId: string,
  success: PublicationResult,
  at: Date,
): Promise<void> {
  const eventTypes = success.mode === "pr"
    ? ["publication.branch_confirmed", "publication.pull_request_confirmed", "publication.published"] as const
    : ["publication.branch_confirmed", "publication.published"] as const;
  await finishAttempt(env, current, attemptId, {
    state: "published", eventTypes, at,
    branchSha: success.branch?.commitSha ?? null,
    prNumber: success.pullRequest?.number ?? null,
    prUrl: success.pullRequest?.url ?? null,
  });
}

async function handleStandalonePublisherError(
  env: Env,
  current: PublicationRow,
  attemptId: string,
  raw: unknown,
  at: Date,
): Promise<boolean> {
  const standaloneError = KirisameErrorSchema.safeParse(raw);
  if (!standaloneError.success) return false;
  if (!errorClassificationMatches(standaloneError.data)) {
    await finishAttempt(env, current, attemptId, {
      state: "blocked", errorCode: "MALFORMED_PUBLISHER_ERROR", eventType: "publication.blocked", at,
    });
  } else if (standaloneError.data.classification === "retryable") {
    await scheduleRetry(env, current, attemptId, standaloneError.data.code, standaloneError.data.retryAfterSeconds, at);
  } else {
    await finishAttempt(env, current, attemptId, {
      state: "blocked", errorCode: standaloneError.data.code, eventType: "publication.blocked", at,
    });
  }
  return true;
}

async function loadAndVerifyManifest(env: Env, row: PublicationRow): Promise<PublicationArtifact | null> {
  if (!env.ARTIFACTS) return null;
  try {
    const object = await env.ARTIFACTS.get(row.artifact_object_key);
    if (!object || object.size > 9 * 1024 * 1024) return null;
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await object.arrayBuffer()));
    const validated = await validatePublicationArtifact(parsed, {
      runId: row.run_id,
      artifactId: row.artifact_id,
      repositoryUrl: `https://github.com/${row.repository_owner}/${row.repository_name}`,
      baseRef: row.base_ref,
    }, row.artifact_digest);
    if (validated.artifact.baseSha !== row.base_sha) return null;
    return validated.artifact;
  } catch {
    return null;
  }
}

function resultMatchesRequest(row: PublicationRow, result: PublicationResult): boolean {
  if (result.publicationId !== row.publication_id || result.runId !== row.run_id || result.mode !== row.mode
    || result.repository.owner.toLowerCase() !== row.repository_owner.toLowerCase()
    || result.repository.name.toLowerCase() !== row.repository_name.toLowerCase()) return false;
  if (result.branch && result.branch.ref !== row.head_ref) return false;
  if (result.pullRequest) {
    try {
      const url = new URL(result.pullRequest.url);
      return url.protocol === "https:" && url.hostname === "github.com"
        && url.pathname.toLowerCase() === `/${row.repository_owner}/${row.repository_name}/pull/${result.pullRequest.number}`.toLowerCase()
        && !url.search && !url.hash && !url.username && !url.password;
    } catch {
      return false;
    }
  }
  return true;
}

function errorClassificationMatches(error: KirisameError): boolean {
  const expected: Record<string, KirisameError["classification"]> = {
    INVALID_REQUEST: "invalid", UNSUPPORTED_VERSION: "invalid", UNAUTHORIZED_CALLER: "policy",
    APP_NOT_INSTALLED: "policy", GITHUB_PERMISSION_DENIED: "policy",
    ARTIFACT_INVALID: "invalid", ARTIFACT_DIGEST_MISMATCH: "invalid", ARTIFACT_PROVENANCE_MISMATCH: "policy",
    BASE_MOVED: "conflict", BASE_TREE_CONFLICT: "conflict", BRANCH_CONFLICT: "conflict",
    PULL_REQUEST_CONFLICT: "conflict", NO_CHANGES: "conflict", UNSUPPORTED_GIT_OBJECT: "invalid",
    GITHUB_AUTH_UNAVAILABLE: "retryable", GITHUB_AUTH_INVALID: "policy", GITHUB_RATE_LIMITED: "retryable",
    GITHUB_UNAVAILABLE: "retryable", GITHUB_TIMEOUT: "retryable", RECONCILIATION_REQUIRED: "retryable",
    PUBLISHING_UNAVAILABLE: "internal", INTERNAL_ERROR: "internal",
  };
  return expected[error.code] === error.classification;
}

async function scheduleRetry(
  env: Env,
  row: PublicationRow,
  attemptId: string,
  errorCode: string,
  retryAfterSeconds: number | undefined,
  at: Date,
): Promise<void> {
  if (row.attempt_count + 1 >= PUBLICATION_MAX_ATTEMPTS) {
    await finishAttempt(env, row, attemptId, { state: "blocked", errorCode: "RETRY_LIMIT_REACHED", eventType: "publication.blocked", at });
    return;
  }
  const ordinaryDelay = Math.min(5 * 60_000, 2_000 * 2 ** Math.max(0, row.attempt_count));
  const jittered = Math.round(ordinaryDelay * (0.75 + Math.random() * 0.5));
  const delay = retryAfterSeconds === undefined
    ? jittered
    : Math.max(jittered, Math.min(60 * 60_000, retryAfterSeconds * 1_000));
  const nextAt = new Date(at.getTime() + delay).toISOString();
  const eventId = createUuidV7(at.getTime());
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE publications SET state = 'retryable_failure', last_error_code = ?, next_attempt_at = ?, lease_expires_at = NULL,
        updated_at = ? WHERE publication_id = ? AND request_fingerprint = ? AND state = 'publishing' AND attempt_id = ?
    `).bind(errorCode, nextAt, at.toISOString(), row.publication_id, row.request_fingerprint, attemptId),
    env.DB.prepare(`
      INSERT INTO publication_events (publication_id, event_id, run_id, event_type, state, attempt_id, occurred_at, metadata_json)
      SELECT publication_id, ?, run_id, 'publication.retry_scheduled', 'retryable_failure', ?, ?, ?
      FROM publications WHERE publication_id = ? AND state = 'retryable_failure' AND last_error_code = ?
        AND request_fingerprint = ? AND attempt_id = ?
    `).bind(eventId, attemptId, at.toISOString(), stableStringify({ errorCode, nextAttemptAt: nextAt }), row.publication_id, errorCode, row.request_fingerprint, attemptId),
  ]);
}

async function finishAttempt(env: Env, row: PublicationRow, attemptId: string, outcome: {
  state: "published" | "blocked";
  eventType?: "publication.blocked";
  eventTypes?: readonly ("publication.branch_confirmed" | "publication.pull_request_confirmed" | "publication.published")[];
  errorCode?: string;
  branchSha?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  at: Date;
}): Promise<void> {
  const now = outcome.at.toISOString();
  const retainedUntil = outcome.state === "published" ? new Date(outcome.at.getTime() + RETENTION_MS).toISOString() : null;
  const finalEventId = createUuidV7(outcome.at.getTime());
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      UPDATE publications SET state = ?, last_error_code = ?, branch_sha = ?, pr_number = ?, pr_url = ?,
        completed_at = ?, retained_until = ?, next_attempt_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE publication_id = ? AND request_fingerprint = ? AND state = 'publishing' AND attempt_id = ?
    `).bind(outcome.state, outcome.errorCode ?? null, outcome.branchSha ?? null, outcome.prNumber ?? null,
      outcome.prUrl ?? null, now, retainedUntil, now, row.publication_id, row.request_fingerprint, attemptId),
  ];
  if (outcome.state === "published") {
    statements.push(env.DB.prepare(`UPDATE publication_intents SET retained_until = ?, updated_at = ?
      WHERE publication_id = ? AND state = 'consumed'`).bind(retainedUntil, now, row.publication_id));
  }
  if (outcome.eventType) {
    statements.push(env.DB.prepare(`
      INSERT INTO publication_events (publication_id, event_id, run_id, event_type, state, attempt_id, occurred_at, metadata_json)
      SELECT publication_id, ?, run_id, ?, ?, ?, ?, ? FROM publications
      WHERE publication_id = ? AND state = ? AND request_fingerprint = ? AND attempt_id = ?
    `).bind(finalEventId, outcome.eventType, outcome.state, attemptId, now,
      stableStringify({ errorCode: outcome.errorCode }), row.publication_id, outcome.state, row.request_fingerprint, attemptId));
  }
  for (const [index, eventType] of (outcome.eventTypes ?? []).entries()) {
    statements.push(env.DB.prepare(`
      INSERT INTO publication_events (publication_id, event_id, run_id, event_type, state, attempt_id, occurred_at, metadata_json)
      SELECT publication_id, ?, run_id, ?, 'published', ?, ?, ? FROM publications
      WHERE publication_id = ? AND state = 'published' AND request_fingerprint = ? AND attempt_id = ?
    `).bind(index === (outcome.eventTypes?.length ?? 0) - 1 ? finalEventId : createUuidV7(outcome.at.getTime()), eventType,
      attemptId, now, stableStringify({ ...(outcome.branchSha ? { branchSha: outcome.branchSha } : {}), ...(outcome.prNumber ? { prNumber: outcome.prNumber } : {}) }),
      row.publication_id, row.request_fingerprint, attemptId));
  }
  await env.DB.batch(statements);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new PublicationTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

class PublicationTimeoutError extends Error {}

export function safePublicationProjection(row: PublicationRow): Record<string, unknown> {
  return {
    publicationId: row.publication_id,
    runId: row.run_id,
    contractVersion: row.contract_version,
    repository: { owner: row.repository_owner, name: row.repository_name },
    mode: row.mode,
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    branchSha: row.branch_sha,
    branchRef: row.state === "published" ? row.head_ref : null,
    pullRequestNumber: row.pr_number,
    pullRequestUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function safeJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function legacyPublishedUrl(row: RunRow | null): string | null {
  if (!row) return null;
  const result = parseResult(row);
  return typeof result?.publishedUrl === "string" ? result.publishedUrl : null;
}

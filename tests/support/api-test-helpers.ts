import { env as runtimeEnv } from "cloudflare:workers";
import { vi } from "vitest";
import { handleRequest } from "../../src/index";
import type { Env } from "../../src/env";
import { RunRequestSchema } from "../../src/contracts/run-request";
import { serializeRunOutcomeSummary } from "../../src/contracts/run-outcome";
import { insertRun, getRun, RunTransitionError, transitionRun } from "../../src/db/runs";
import { reconcileAdmissions, reconcileStalledRuns } from "../../src/queue/reconcile";
import { purgeExpiredArtifacts } from "../../src/api/artifacts";
import { reconcileArtifactStorage } from "../../src/api/artifact-reconciliation";
import { purgeExpiredPublicationManifests, purgeExpiredRunRequests, purgeOldRuns } from "../../src/api/retention";
import { canonicalJson, digestHex } from "../../src/publication/contract-v1";
import { dispatchPublication, PUBLICATION_DISPATCH_BATCH_SIZE, PUBLICATION_LEASE_MS, reconcilePublications, type PublicationRow } from "../../src/publication/lifecycle";
import { MockPublisherEntrypoint } from "../../src/publication/mock-publisher";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { oauthProviderOptions } from "../../src/auth/oauth";
import { handleDashboardApiRequest } from "../../src/auth/oauth-resource";
export { runtimeEnv, handleRequest, insertRun, getRun, RunTransitionError, transitionRun, reconcileAdmissions, reconcileStalledRuns, purgeExpiredArtifacts, reconcileArtifactStorage, purgeExpiredPublicationManifests, purgeExpiredRunRequests, purgeOldRuns, canonicalJson, digestHex, dispatchPublication, PUBLICATION_DISPATCH_BATCH_SIZE, PUBLICATION_LEASE_MS, reconcilePublications, MockPublisherEntrypoint, getOAuthApi, oauthProviderOptions, handleDashboardApiRequest };
export type { Env, PublicationRow };


export const CLIENT_TOKEN = "client-test-token-value-long-enough";
export const KASEKI_TOKEN = "kaseki-submit-token-value-long-enough";
export const WORKER_TOKEN = "worker-test-token-value-long-enough";
export const CLIENT_KEY = "00000000-0000-4000-8000-000000000010";
export const CALLBACK_ID = "00000000-0000-4000-8000-000000000011";
export const EVENT_ID = "00000000-0000-4000-8000-000000000012";
export const SENKU_TOKEN = "senku-soyuz-test-token-value-long-enough";
export const KIRISAME_API_TEST_KEY = "A".repeat(43);

type QueueMessage = { runId: string; contractVersion: string; [key: string]: unknown };

export function testEnv(options: {
  queueFailure?: boolean;
  artifacts?: Env["ARTIFACTS"];
  oauth?: boolean;
  senku?: Env["SENKU"];
} = {}) {
  const sent: QueueMessage[] = [];
  const oauthRegistrationLimiter = { limit: vi.fn(async () => ({ success: true })) };
  const jevDecisionLimiter = { limit: vi.fn(async () => ({ success: true })) };
  const send = vi.fn(async (message: unknown) => {
    if (options.queueFailure) throw new Error("simulated queue failure");
    sent.push(message as QueueMessage);
  });
  const bindings: Env = {
    DB: runtimeEnv.DB,
    RUN_QUEUE: { send } as unknown as Env["RUN_QUEUE"],
    OAUTH_REGISTRATION_LIMITER: oauthRegistrationLimiter as unknown as Env["OAUTH_REGISTRATION_LIMITER"],
    JEV_DECISION_LIMITER: jevDecisionLimiter as unknown as Env["JEV_DECISION_LIMITER"],
    SENKU: options.senku ?? (runtimeEnv as unknown as Env).SENKU,
    SENKU_SOYUZ_API_TOKEN: SENKU_TOKEN,
    KIRISAME_CALLER_ID: "soyuz",
    KIRISAME_API_KEY: KIRISAME_API_TEST_KEY,
    CLIENT_API_TOKEN: CLIENT_TOKEN,
    WORKER_API_TOKEN: WORKER_TOKEN,
    PUBLICATION_REPOSITORY_ALLOWLIST: JSON.stringify([{ owner: "example", name: "project", modes: ["branch", "pr"], baseRefs: ["main"] }]),
    ARTIFACTS: options.artifacts,
    OAUTH_KV: options.oauth ? (runtimeEnv as unknown as { OAUTH_KV: Env["OAUTH_KV"] }).OAUTH_KV : undefined,
    SOYUZ_PUBLIC_URL: options.oauth ? "https://soyuz.test" : undefined,
    GITHUB_OAUTH_CLIENT_ID: options.oauth ? "test-github-client-id" : undefined,
    GITHUB_OAUTH_CLIENT_SECRET: options.oauth ? "test-github-client-secret" : undefined,
    SOYUZ_OAUTH_ALLOWED_GITHUB_IDS: options.oauth ? "123" : undefined,
  };
  return { bindings, sent, send, oauthRegistrationLimiter, jevDecisionLimiter };
}

export function senkuAnswers(profileId: "run_operations_triage_v1" | "kaseki_output_review_v2"): Record<string, unknown> {
  if (profileId === "run_operations_triage_v1") {
    return {
      needs_followup: { type: "noul", noul: 0.8, probabilities: { false: 0.2, true: 0.8 }, confidence: null },
      likely_area: {
        type: "choice", choice: "execution",
        probabilities: { execution: 0.8, control_plane: 0.1, unknown: 0.1 }, confidence: 0.75,
      },
      severity: {
        type: "score", score: 1,
        legend: { "0": "Routine", "1": "Needs review", "2": "Urgent" },
        probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 }, confidence: 0.8,
      },
    };
  }
  return {
    summary_specificity: { type: "noul", noul: 0.9, probabilities: { false: 0.1, true: 0.9 }, confidence: null },
    outcome_alignment: {
      type: "choice", choice: "consistent",
      probabilities: { consistent: 0.9, unclear: 0.1, inconsistent: 0 }, confidence: 0.8,
    },
    evidence_strength: {
      type: "score", score: 1.5,
      legend: { "0": "Insufficient", "1": "Some concrete detail", "2": "Clear and specific" },
      probabilities: { "0": 0, "1": 0.5, "2": 0.5 }, confidence: 0.75,
    },
    recorded_outcome: {
      type: "score", score: 2,
      legend: {
        "0": "Outcome unclear or unsuccessful",
        "1": "Partial or limited outcome evidence",
        "2": "Successful and clearly reported outcome",
      },
      probabilities: { "0": 0.05, "1": 0.1, "2": 0.85 }, confidence: 0.8,
    },
  };
}

export function mockSenku(profileId: "run_operations_triage_v1" | "kaseki_output_review_v2") {
  const answers = senkuAnswers(profileId);
  const fetch = vi.fn(async (_request: Request) => new Response(JSON.stringify({
    schemaVersion: "1",
    requestId: "dec-00000000-0000-4000-8000-000000000001",
    status: "completed",
    profileId,
    profileVersion: profileId === "kaseki_output_review_v2" ? "2" : "1",
    provider: "jev",
    model: "typesafe/jev-test",
    answers,
    result: answers,
    usage: { input_tokens: 120, output_tokens: 80, cost: 0.002 },
    durationMs: 20,
    attemptCount: 1,
  }), { headers: { "content-type": "application/json" } }));
  return { binding: { fetch: fetch as unknown as Fetcher["fetch"] } as Env["SENKU"], fetch };
}

export async function createOAuthAccessToken(env: Env, scope: string[] = ["soyuz:read"]): Promise<string> {
  return (await createOAuthCredentials(env, scope)).accessToken;
}

export async function createOAuthCredentials(env: Env, scope: string[] = ["soyuz:read"]): Promise<{ accessToken: string; clientId: string }> {
  const helpers = getOAuthApi(oauthProviderOptions("https://soyuz.test"), env);
  const redirectUri = "https://client.example.test/callback";
  const client = await helpers.createClient({
    clientName: `Soyuz test ${crypto.randomUUID()}`,
    redirectUris: [redirectUri],
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
  });
  const verifier = "soyuZ-test-verifier-which-is-at-least-43-characters-long";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const authorization = new URL("https://soyuz.test/oauth/authorize");
  authorization.searchParams.set("client_id", client.clientId);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", scope.join(" "));
  authorization.searchParams.set("resource", "https://soyuz.test/");
  authorization.searchParams.set("state", crypto.randomUUID());
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  const parsed = await helpers.parseAuthRequest(new Request(authorization));
  const granted = await helpers.completeAuthorization({
    request: parsed,
    userId: "github-123",
    metadata: { githubLogin: "allowed-test-user" },
    props: { githubUserId: "123", githubLogin: "allowed-test-user" },
    scope,
  });
  const code = new URL(granted.redirectTo).searchParams.get("code");
  if (!code) throw new Error("OAuth authorization code was not returned");
  const response = await handleRequest(new Request("https://soyuz.test/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: "https://soyuz.test/",
    }),
  }), env);
  const token = await response.json() as { access_token?: string; error?: string };
  if (!response.ok || !token.access_token) throw new Error(`OAuth token exchange failed: ${token.error ?? response.status}`);
  return { accessToken: token.access_token, clientId: client.clientId };
}

export function apiRequest(
  path: string,
  options: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(options.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", "198.51.100.10");
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://soyuz.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  return values.flatMap((value) => value.split(/,(?=\s*[^;,=]+=)/))
    .map((value) => value.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

export async function beginOAuthConsent(env: Env) {
  const registration = await call(env, "/oauth/register", {
    method: "POST",
    body: {
      client_name: "Consent <script>alert(1)</script>",
      redirect_uris: ["https://client.example.test/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  const verifier = "soyuz-consent-page-test-verifier-long-enough-123456";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const authorize = new URL("https://soyuz.test/oauth/authorize");
  authorize.searchParams.set("client_id", registration.body.client_id);
  authorize.searchParams.set("redirect_uri", "https://client.example.test/callback");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "soyuz:read");
  authorize.searchParams.set("resource", "https://soyuz.test/");
  authorize.searchParams.set("state", "consent-test-state");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  const consent = await handleRequest(new Request(authorize), env);
  const html = await consent.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  if (!handle) throw new Error("OAuth consent page did not contain its transaction handle");
  return { registration, authorize, consent, html, handle };
}

export async function approveOAuthConsent(env: Env, handle: string): Promise<Response> {
  return handleRequest(new Request("https://soyuz.test/oauth/authorize", {
    method: "POST",
    headers: {
      origin: "null",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ handle, decision: "approve", scope: "soyuz:read" }),
  }), env);
}

export async function call(
  env: Env,
  path: string,
  options: Parameters<typeof apiRequest>[1] = {},
): Promise<{ response: Response; body: any }> {
  const response = await handleRequest(apiRequest(path, options), env);
  return { response, body: await response.json() };
}

export async function callBinary(
  env: Env,
  path: string,
  options: { method?: string; body?: string; token?: string; headers?: Record<string, string> } = {},
  context?: ExecutionContext,
): Promise<{ response: Response; body: unknown }> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const response = await handleRequest(new Request(`https://soyuz.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
  }), env, context);
  const contentType = response.headers.get("content-type") ?? "";
  return { response, body: contentType.includes("application/json") ? await response.json() : await response.text() };
}

export function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    repoUrl: "https://github.com/example/project",
    taskPrompt: "Update the project documentation and keep the API examples current.",
    ...overrides,
  };
}

export async function insertOutcomeRunFixture(env: Env, id: string, createdAt: string, outcomeSummary: unknown): Promise<void> {
  const request = RunRequestSchema.parse(validRequest());
  await insertRun(env.DB, {
    id,
    request,
    requestHash: "0".repeat(64),
    idempotencyKey: null,
    correlationId: id,
    requestId: id,
    createdAt,
  });
  const summaryJson = serializeRunOutcomeSummary(outcomeSummary);
  if (!summaryJson) throw new TypeError("Outcome fixture must be a valid run outcome summary");
  await env.DB.prepare("UPDATE runs SET result_json = ?, outcome_summary_json = ? WHERE id = ?")
    .bind(JSON.stringify({ outcomeSummary }), summaryJson, id).run();
}

export async function clearDatabase(): Promise<void> {
  await runtimeEnv.DB.batch([
    runtimeEnv.DB.prepare("DELETE FROM publication_events"),
    runtimeEnv.DB.prepare("DELETE FROM publications"),
    runtimeEnv.DB.prepare("DELETE FROM publication_intents"),
    runtimeEnv.DB.prepare("DELETE FROM publication_manifest_artifacts"),
    runtimeEnv.DB.prepare("DELETE FROM run_events"),
    runtimeEnv.DB.prepare("DELETE FROM artifact_deletion_queue"),
    runtimeEnv.DB.prepare("DELETE FROM artifact_upload_metrics"),
    runtimeEnv.DB.prepare("DELETE FROM artifact_reconciliation_metrics"),
    runtimeEnv.DB.prepare("DELETE FROM artifact_reconciliation_state"),
    runtimeEnv.DB.prepare("DELETE FROM run_idempotency_keys"),
    runtimeEnv.DB.prepare("DELETE FROM jev_feedback"),
    runtimeEnv.DB.prepare("DELETE FROM runs"),
  ]);
}

export async function countRunEvents(env: Env, runId: string, type: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = ?")
    .bind(runId, type).first<{ count: number }>();
  return row?.count ?? 0;
}

export function memoryArtifactBucket() {
  const objects = new Map<string, { body: Uint8Array; options: Record<string, any> }>();
  const put = vi.fn(async (key: string, body: ReadableStream<Uint8Array> | ArrayBuffer, options: Record<string, any>) => {
    const bytes = body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(await new Response(body).arrayBuffer());
    objects.set(key, { body: bytes, options });
    return { etag: "test-etag" };
  });
  const get = vi.fn(async (key: string) => {
    const stored = objects.get(key);
    if (!stored) return null;
    return {
      key,
      size: stored.body.byteLength,
      checksums: stored.options.sha256 ? { sha256: stored.options.sha256 } : undefined,
      customMetadata: stored.options.customMetadata,
      httpMetadata: stored.options.httpMetadata,
      body: new Response(stored.body.buffer as ArrayBuffer).body,
      arrayBuffer: async () => stored.body.buffer.slice(
        stored.body.byteOffset,
        stored.body.byteOffset + stored.body.byteLength,
      ) as ArrayBuffer,
      writeHttpMetadata(headers: Headers) {
        headers.set("content-type", stored.options.httpMetadata.contentType);
      },
    };
  });
  const head = vi.fn(async (key: string) => {
    const stored = objects.get(key);
    return stored ? { key, size: stored.body.byteLength, customMetadata: stored.options.customMetadata } : null;
  });
  const list = vi.fn(async ({ prefix, limit, cursor }: { prefix?: string; limit?: number; cursor?: string }) => ({
    objects: [...objects.entries()]
      .filter(([key]) => key.startsWith(prefix ?? ""))
      .sort(([left], [right]) => left.localeCompare(right))
      .filter(([key]) => !cursor || key > cursor)
      .slice(0, limit ?? 1_000)
      .map(([key, item]) => ({ key, size: item.body.byteLength, uploaded: new Date(item.options.customMetadata.createdAt), customMetadata: item.options.customMetadata })),
    truncated: false,
    cursor: undefined,
  }));
  const deleteObjects = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
  });
  return { bucket: { put, get, head, list, delete: deleteObjects } as unknown as Env["ARTIFACTS"], objects, put, get, head, list, delete: deleteObjects };
}

export async function submit(env: Env, overrides: Record<string, unknown> = {}, key = CLIENT_KEY) {
  return call(env, "/v1/runs", {
    method: "POST",
    token: CLIENT_TOKEN,
    headers: key ? { "Idempotency-Key": key } : undefined,
    body: validRequest(overrides),
  });
}

export async function claimRun(env: Env, runId: string, workerId = "docker-host-a", callbackId = "00000000-0000-4000-8000-000000000030") {
  return call(env, `/v1/worker/runs/${runId}/claim`, {
    method: "POST",
    token: WORKER_TOKEN,
    body: { contractVersion: "1", callbackId, workerId },
  });
}

export async function startRunningRun(
  env: Env,
  workerId: string,
  claimCallbackId: string,
  startedCallbackId: string,
): Promise<string> {
  const created = await submit(env);
  const runId = created.body.data.id as string;
  await claimRun(env, runId, workerId, claimCallbackId);
  await call(env, `/v1/worker/runs/${runId}/started`, {
    method: "POST",
    token: WORKER_TOKEN,
    body: { contractVersion: "1", callbackId: startedCallbackId, workerId },
  });
  return runId;
}

export async function uploadArtifact(
  env: Env,
  runId: string,
  input: {
    artifactId: string;
    artifactName: string;
    body: string;
    workerId: string;
    claimCallbackId: string;
  },
) {
  return callBinary(env, `/v1/worker/runs/${runId}/artifacts/${input.artifactId}`, {
    method: "PUT",
    token: WORKER_TOKEN,
    headers: {
      "content-type": "text/plain",
      "content-length": String(new TextEncoder().encode(input.body).byteLength),
      "x-artifact-name": input.artifactName,
      "x-artifact-kind": "report",
      "x-soyuz-worker-id": input.workerId,
      "x-soyuz-claim-callback-id": input.claimCallbackId,
    },
    body: input.body,
  });
}

export async function publicationManifest(runId: string, artifactId: string) {
  const content = "Soyuz durable publication fixture\n";
  const bytes = new TextEncoder().encode(content);
  const digest = await digestHex(bytes);
  return {
    contractVersion: "1",
    artifactId,
    runId,
    repository: { owner: "example", name: "project" },
    baseRef: "main",
    baseSha: "a".repeat(40),
    fileCount: 1,
    totalBytes: bytes.byteLength,
    files: [{
      operation: "add",
      path: "README.md",
      content: {
        mediaType: "text/plain; charset=utf-8",
        encoding: "base64",
        byteLength: bytes.byteLength,
        sha256: digest,
        data: btoa(content),
      },
    }],
  };
}

export async function registerPublicationInputs(
  env: Env,
  input: { workerId: string; claimCallbackId: string; artifactId: string; withEvidence?: boolean; mode?: "branch" | "pr" },
) {
  const created = await submit(env, input.mode === "branch" ? { publishMode: "branch" } : {}, crypto.randomUUID());
  const runId = created.body.data.id as string;
  await claimRun(env, runId, input.workerId, input.claimCallbackId);
  await call(env, `/v1/worker/runs/${runId}/started`, {
    method: "POST", token: WORKER_TOKEN,
    body: { contractVersion: "1", callbackId: crypto.randomUUID(), workerId: input.workerId, claimCallbackId: input.claimCallbackId },
  });
  const manifest = await publicationManifest(runId, input.artifactId);
  const manifestText = JSON.stringify(manifest);
  const digest = `sha256:${await digestHex(new TextEncoder().encode(canonicalJson(manifest)))}`;
  const uploaded = await callBinary(env, `/v1/worker/runs/${runId}/publication-manifests/${input.artifactId}`, {
    method: "PUT",
    token: WORKER_TOKEN,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(new TextEncoder().encode(manifestText).byteLength),
      "x-soyuz-worker-id": input.workerId,
      "x-soyuz-claim-callback-id": input.claimCallbackId,
    },
    body: manifestText,
  });
  if (input.withEvidence !== false) {
    await call(env, `/v1/worker/runs/${runId}/events`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        eventId: crypto.randomUUID(),
        workerId: input.workerId,
        claimCallbackId: input.claimCallbackId,
        type: "validation.completed",
        payload: {
          publicationEvidence: {
            evidenceVersion: "1",
            outcome: "passed",
            artifactId: input.artifactId,
            artifactDigest: digest,
            runId,
            repository: { owner: "example", name: "project" },
            baseRef: "main",
            baseSha: "a".repeat(40),
          },
        },
      },
    });
  }
  const intentBody = {
    contractVersion: "1",
    artifactId: input.artifactId,
    artifactDigest: digest,
    mode: input.mode ?? "pr",
    ...(input.mode === "branch" ? {} : { title: "Validated documentation update", body: "This publication is validated by the Soyuz host." }),
  };
  const intent = await call(env, `/v1/worker/runs/${runId}/publication-intents`, {
    method: "POST",
    token: WORKER_TOKEN,
    headers: { "x-soyuz-worker-id": input.workerId, "x-soyuz-claim-callback-id": input.claimCallbackId },
    body: intentBody,
  });
  return { runId, manifest, digest, uploaded, intent, intentBody };
}

export async function completeExecution(env: Env, input: { runId: string; workerId: string; claimCallbackId: string; publishedUrl?: string }) {
  return call(env, `/v1/worker/runs/${input.runId}/completed`, {
    method: "POST",
    token: WORKER_TOKEN,
    body: {
      contractVersion: "1",
      callbackId: crypto.randomUUID(),
      workerId: input.workerId,
      claimCallbackId: input.claimCallbackId,
      exitCode: 0,
      ...(input.publishedUrl ? { publishedUrl: input.publishedUrl } : {}),
    },
  });
}

export function withSupersededClaimOnNextBatch(
  database: Env["DB"],
  input: { runId: string; workerId: string; replacementClaimId: string },
): Env["DB"] {
  let replaceClaim = true;
  return {
    prepare: database.prepare.bind(database),
    batch: async (statements: Parameters<typeof database.batch>[0]) => {
      if (replaceClaim) {
        replaceClaim = false;
        const now = new Date().toISOString();
        await database.prepare(
          "UPDATE runs SET status = 'running', started_at = ?, claim_expires_at = NULL WHERE id = ?",
        ).bind(now, input.runId).run();
        await database.prepare(`
          INSERT INTO run_events (
            run_id, contract_version, event_id, type, worker_id,
            occurred_at, recorded_at, payload_json
          ) VALUES (?, '1', ?, 'run.claimed', ?, ?, ?, '{}')
        `).bind(input.runId, input.replacementClaimId, input.workerId, now, now).run();
      }
      return database.batch(statements);
    },
  } as unknown as Env["DB"];
}

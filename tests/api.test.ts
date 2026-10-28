import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";
import { insertRun, getRun, RunTransitionError, transitionRun } from "../src/db/runs";
import { reconcileAdmissions, reconcileStalledRuns } from "../src/queue/reconcile";
import { purgeExpiredArtifacts } from "../src/api/artifacts";
import { purgeExpiredRunRequests } from "../src/api/retention";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { oauthProviderOptions } from "../src/auth/oauth";

const CLIENT_TOKEN = "client-test-token-value-long-enough";
const KASEKI_TOKEN = "kaseki-submit-token-value-long-enough";
const WORKER_TOKEN = "worker-test-token-value-long-enough";
const CLIENT_KEY = "00000000-0000-4000-8000-000000000010";
const CALLBACK_ID = "00000000-0000-4000-8000-000000000011";
const EVENT_ID = "00000000-0000-4000-8000-000000000012";

type QueueMessage = { runId: string; contractVersion: string; [key: string]: unknown };

function testEnv(options: { queueFailure?: boolean; artifacts?: Env["ARTIFACTS"]; oauth?: boolean; openuiDemo?: boolean } = {}) {
  const sent: QueueMessage[] = [];
  const oauthRegistrationLimiter = { limit: vi.fn(async () => ({ success: true })) };
  const openuiGenerationLimiter = { limit: vi.fn(async () => ({ success: true })) };
  const send = vi.fn(async (message: unknown) => {
    if (options.queueFailure) throw new Error("simulated queue failure");
    sent.push(message as QueueMessage);
  });
  const bindings: Env = {
    DB: runtimeEnv.DB,
    RUN_QUEUE: { send } as unknown as Env["RUN_QUEUE"],
    OAUTH_REGISTRATION_LIMITER: oauthRegistrationLimiter as unknown as Env["OAUTH_REGISTRATION_LIMITER"],
    OPENUI_GENERATION_LIMITER: openuiGenerationLimiter as unknown as Env["OPENUI_GENERATION_LIMITER"],
    CLIENT_API_TOKEN: CLIENT_TOKEN,
    WORKER_API_TOKEN: WORKER_TOKEN,
    ARTIFACTS: options.artifacts,
    OAUTH_KV: options.oauth ? (runtimeEnv as unknown as { OAUTH_KV: Env["OAUTH_KV"] }).OAUTH_KV : undefined,
    SOYUZ_PUBLIC_URL: options.oauth ? "https://soyuz.test" : undefined,
    GITHUB_OAUTH_CLIENT_ID: options.oauth ? "test-github-client-id" : undefined,
    GITHUB_OAUTH_CLIENT_SECRET: options.oauth ? "test-github-client-secret" : undefined,
    SOYUZ_OAUTH_ALLOWED_GITHUB_IDS: options.oauth ? "123" : undefined,
    OPENUI_DEMO_MODE: options.openuiDemo ? "true" : undefined,
  };
  return { bindings, sent, send, oauthRegistrationLimiter, openuiGenerationLimiter };
}

async function createOAuthAccessToken(env: Env, scope: string[] = ["soyuz:read"]): Promise<string> {
  return (await createOAuthCredentials(env, scope)).accessToken;
}

async function createOAuthCredentials(env: Env, scope: string[] = ["soyuz:read"]): Promise<{ accessToken: string; clientId: string }> {
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

function apiRequest(
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

function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  return values.flatMap((value) => value.split(/,(?=\s*[^;,=]+=)/))
    .map((value) => value.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function beginOAuthConsent(env: Env) {
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

async function approveOAuthConsent(env: Env, handle: string): Promise<Response> {
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

async function call(
  env: Env,
  path: string,
  options: Parameters<typeof apiRequest>[1] = {},
): Promise<{ response: Response; body: any }> {
  const response = await handleRequest(apiRequest(path, options), env);
  return { response, body: await response.json() };
}

async function callBinary(
  env: Env,
  path: string,
  options: { method?: string; body?: string; token?: string; headers?: Record<string, string> } = {},
): Promise<{ response: Response; body: unknown }> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const response = await handleRequest(new Request(`https://soyuz.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
  }), env);
  const contentType = response.headers.get("content-type") ?? "";
  return { response, body: contentType.includes("application/json") ? await response.json() : await response.text() };
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    repoUrl: "https://github.com/example/project",
    taskPrompt: "Update the project documentation and keep the API examples current.",
    ...overrides,
  };
}

async function clearDatabase(): Promise<void> {
  await runtimeEnv.DB.batch([
    runtimeEnv.DB.prepare("DELETE FROM run_events"),
    runtimeEnv.DB.prepare("DELETE FROM artifact_deletion_queue"),
    runtimeEnv.DB.prepare("DELETE FROM run_idempotency_keys"),
    runtimeEnv.DB.prepare("DELETE FROM runs"),
  ]);
}

async function countRunEvents(env: Env, runId: string, type: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = ?")
    .bind(runId, type).first<{ count: number }>();
  return row?.count ?? 0;
}

function memoryArtifactBucket() {
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
  const list = vi.fn(async ({ prefix, limit }: { prefix?: string; limit?: number }) => ({
    objects: [...objects.entries()]
      .filter(([key]) => key.startsWith(prefix ?? ""))
      .slice(0, limit ?? 1_000)
      .map(([key, item]) => ({ key, size: item.body.byteLength, uploaded: new Date(item.options.customMetadata.createdAt), customMetadata: item.options.customMetadata })),
    truncated: false,
    cursor: undefined,
  }));
  const deleteObjects = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
  });
  return { bucket: { put, get, list, delete: deleteObjects } as unknown as Env["ARTIFACTS"], objects, put, get, list, delete: deleteObjects };
}

async function submit(env: Env, overrides: Record<string, unknown> = {}, key = CLIENT_KEY) {
  return call(env, "/v1/runs", {
    method: "POST",
    token: CLIENT_TOKEN,
    headers: key ? { "Idempotency-Key": key } : undefined,
    body: validRequest(overrides),
  });
}

async function claimRun(env: Env, runId: string, workerId = "docker-host-a", callbackId = "00000000-0000-4000-8000-000000000030") {
  return call(env, `/v1/worker/runs/${runId}/claim`, {
    method: "POST",
    token: WORKER_TOKEN,
    body: { contractVersion: "1", callbackId, workerId },
  });
}

async function startRunningRun(
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

async function uploadArtifact(
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

function withSupersededClaimOnNextBatch(
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

describe("Soyuz Worker API", () => {
  beforeEach(clearDatabase);

  it("[AUTH-REST-01] requires client authentication and rejects client credentials on worker routes", async () => {
    const { bindings } = testEnv();
    const noAuth = await call(bindings, "/v1/runs", { method: "POST", body: validRequest() });
    expect(noAuth.response.status).toBe(401);
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");
    expect(noAuth.body.error.message).toContain("current client key");

    const wrongTrust = await call(bindings, "/v1/worker/runs/00000000-0000-4000-8000-000000000013/started", {
      method: "POST",
      token: CLIENT_TOKEN,
      body: { contractVersion: "1", callbackId: CALLBACK_ID, workerId: "host-a" },
    });
    expect(wrongTrust.response.status).toBe(401);
  });

  it("[RUN-VALIDATE-01/ERRORS-01] rejects invalid run requests before admission with a stable error", async () => {
    const { bindings, send } = testEnv();
    const invalid = await call(bindings, "/v1/runs", {
      method: "POST",
      token: CLIENT_TOKEN,
      body: { repoUrl: "not a URL", taskPrompt: "short" },
    });
    expect(invalid.response.status).toBe(422);
    expect(invalid.body.error.code).toBe("INVALID_RUN_REQUEST");
    expect(send).not.toHaveBeenCalled();
    const count = await bindings.DB.prepare("SELECT COUNT(*) AS count FROM runs").first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("[AUTH-CONFIG-01] reports unavailable when client or worker server keys are missing", async () => {
    const { bindings } = testEnv();
    const missingClientKey = { ...bindings, CLIENT_API_TOKEN: undefined as unknown as string };
    const misconfigured = await call(missingClientKey, "/v1/runs", { token: CLIENT_TOKEN });
    expect(misconfigured.response.status).toBe(503);
    expect(misconfigured.body.error.code).toBe("AUTHENTICATION_UNAVAILABLE");
    expect(misconfigured.body.error.message).toContain("not configured");

    const missingWorkerKey = { ...bindings, WORKER_API_TOKEN: undefined as unknown as string };
    const workerMisconfigured = await call(missingWorkerKey, "/v1/worker/runs/00000000-0000-4000-8000-000000000013", {
      token: WORKER_TOKEN,
    });
    expect(workerMisconfigured.response.status).toBe(503);
    expect(workerMisconfigured.body.error.code).toBe("AUTHENTICATION_UNAVAILABLE");
    expect(workerMisconfigured.body.error.message).toContain("not configured");

    const duplicateClientAndKasekiKey = {
      ...bindings,
      KASEKI_SUBMISSION_API_TOKEN: CLIENT_TOKEN,
    };
    const duplicateKey = await call(duplicateClientAndKasekiKey, "/v1/runs", {
      method: "POST",
      token: CLIENT_TOKEN,
      body: validRequest(),
    });
    expect(duplicateKey.response.status).toBe(503);
    expect(duplicateKey.body.error.code).toBe("AUTHENTICATION_UNAVAILABLE");
  });

  it("[OAUTH-01] serves dashboard data only to an allowlisted OAuth user", async () => {
    const { bindings } = testEnv({ oauth: true });
    const accessToken = await createOAuthAccessToken(bindings);

    const result = await call(bindings, "/dashboard/api/runs", { token: accessToken });
    expect(result.response.status).toBe(200);
    expect(result.body.data.runs).toEqual([]);

    bindings.SOYUZ_OAUTH_ALLOWED_GITHUB_IDS = "456";
    const revoked = await call(bindings, "/dashboard/api/runs", { token: accessToken });
    expect(revoked.response.status).toBe(403);
    expect(revoked.body.error.code).toBe("ACCESS_DENIED");
  });

  it("[OAUTH-RATE-LIMIT-01] limits public OAuth client registration by connecting IP", async () => {
    const { bindings, oauthRegistrationLimiter } = testEnv({ oauth: true });
    oauthRegistrationLimiter.limit.mockResolvedValue({ success: false });

    const result = await call(bindings, "/oauth/register", {
      method: "POST",
      body: {
        client_name: "Rate limit test",
        redirect_uris: ["https://client.example.test/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });

    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("60");
    expect(result.body.error.code).toBe("RATE_LIMITED");
    expect(oauthRegistrationLimiter.limit).toHaveBeenCalledWith({ key: "198.51.100.10" });
  });

  it("[OAUTH-07] includes run liveness fields in dashboard list summaries", async () => {
    const { bindings } = testEnv({ oauth: true });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const heartbeat = "2026-10-18T12:00:00.000Z";
    await bindings.DB.prepare("UPDATE runs SET operational_health = 'suspect_stalled', last_heartbeat_at = ? WHERE id = ?")
      .bind(heartbeat, runId).run();
    const accessToken = await createOAuthAccessToken(bindings);

    const response = await call(bindings, "/dashboard/api/runs?limit=30", { token: accessToken });
    expect(response.response.status).toBe(200);
    expect(response.body.data.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId, displayId: created.body.data.displayId, stage: null, operationalHealth: "suspect_stalled", lastHeartbeatAt: heartbeat }),
    ]));
  });

  it("[DASHBOARD-SECURITY-01] adds browser security headers to dashboard assets", async () => {
    const { bindings } = testEnv();
    bindings.ASSETS = { fetch: async () => new Response("dashboard", { headers: { "content-type": "text/html; charset=utf-8" } }) } as unknown as Env["ASSETS"];

    const response = await handleRequest(new Request("https://soyuz.test/dashboard/"), bindings);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("[OAUTH-05] returns the authenticated GitHub login from the protected dashboard identity endpoint", async () => {
    const { bindings } = testEnv({ oauth: true });
    const credentials = await createOAuthCredentials(bindings);

    const identity = await call(bindings, "/dashboard/api/me", { token: credentials.accessToken });
    expect(identity.response.status).toBe(200);
    expect(identity.body.data).toEqual({ githubLogin: "allowed-test-user" });

    bindings.SOYUZ_OAUTH_ALLOWED_GITHUB_IDS = "456";
    const rejected = await call(bindings, "/dashboard/api/me", { token: credentials.accessToken });
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.error.code).toBe("ACCESS_DENIED");
  });

  it("[OAUTH-06] revokes the dashboard access token so it can no longer read the dashboard", async () => {
    const { bindings } = testEnv({ oauth: true });
    const credentials = await createOAuthCredentials(bindings);
    const before = await call(bindings, "/dashboard/api/me", { token: credentials.accessToken });
    expect(before.response.status).toBe(200);

    const revoked = await handleRequest(new Request("https://soyuz.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: credentials.accessToken,
        token_type_hint: "access_token",
        client_id: credentials.clientId,
      }),
    }), bindings);
    expect(revoked.status).toBe(200);

    const after = await call(bindings, "/dashboard/api/me", { token: credentials.accessToken });
    expect(after.response.status).toBe(401);
  });

  it("[OAUTH-04] serves sanitized dashboard run details and event pages", async () => {
    const { bindings } = testEnv({ oauth: true });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    await bindings.DB.prepare("UPDATE runs SET repo_url = ?, result_json = ?, started_at = ?, completed_at = ?, exit_code = ? WHERE id = ?")
      .bind(
        "https://user:embedded-secret@github.com/example/private-project?access_token=embedded-token",
        JSON.stringify({ summary: "Completed safely", publishedUrl: "https://user:embedded-secret@github.com/example/private-project?token=embedded-token", changedFileCount: 3 }),
        "2026-10-18T12:01:00.000Z",
        "2026-10-18T12:02:00.000Z",
        0,
        runId,
      ).run();
    const accessToken = await createOAuthAccessToken(bindings);

    const detail = await call(bindings, `/dashboard/api/runs/${runId}`, { token: accessToken });
    expect(detail.response.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      runId,
      displayId: created.body.data.displayId,
      repoUrl: "https://github.com/example/private-project",
      outcomeSummary: "Completed safely",
      publishedUrl: "https://github.com/example/private-project",
      changedFileCount: 3,
      startedAt: "2026-10-18T12:01:00.000Z",
      completedAt: "2026-10-18T12:02:00.000Z",
      exitCode: 0,
    });
    expect(JSON.stringify(detail.body.data)).not.toContain("embedded-secret");
    expect(JSON.stringify(detail.body.data)).not.toContain("embedded-token");

    const events = await call(bindings, `/dashboard/api/runs/${runId}/events`, { token: accessToken });
    expect(events.response.status).toBe(200);
    expect(events.body.data.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.admitting", payload: { status: "admitting" } }),
    ]));
  });

  it("[RUN-EVENT-PAGE-01] reports whether another page of run events remains", async () => {
    const { bindings } = testEnv({ oauth: true });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const accessToken = await createOAuthAccessToken(bindings);

    const first = await call(bindings, `/dashboard/api/runs/${runId}/events?limit=1`, { token: accessToken });
    expect(first.body.data.events).toHaveLength(1);
    expect(first.body.data.hasMore).toBe(true);

    const second = await call(bindings, `/dashboard/api/runs/${runId}/events?after=${first.body.data.nextAfter}&limit=1`, { token: accessToken });
    expect(second.body.data.events).toHaveLength(1);
    expect(second.body.data.hasMore).toBe(false);
    expect(second.body.data.nextAfter).toBeGreaterThan(first.body.data.nextAfter);
  });

  it("[OAUTH-02] keeps the dashboard read-only and requires write scope for MCP mutations", async () => {
    const { bindings } = testEnv({ oauth: true });
    const accessToken = await createOAuthAccessToken(bindings);

    const dashboardWrite = await call(bindings, "/dashboard/api/runs", {
      method: "POST",
      token: accessToken,
      body: validRequest(),
    });
    expect(dashboardWrite.response.status).toBe(405);

    const mcpWrite = await callBinary(bindings, "/mcp", {
      method: "POST",
      token: accessToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_run", arguments: validRequest() } }),
    });
    expect(mcpWrite.response.status).toBe(403);
    expect((mcpWrite.body as any).error).toBe("insufficient_scope");
  });

  it("[OAUTH-02] allows only the authenticated analysis-generation POST with read scope", async () => {
    const { bindings } = testEnv({ oauth: true, openuiDemo: true });
    const accessToken = await createOAuthAccessToken(bindings);
    const request = {
      method: "POST",
      token: accessToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Summarise the last 10 runs.", mode: "generate" }),
    };

    const analysis = await callBinary(bindings, "/dashboard/api/analysis/generate", request);
    expect(analysis.response.status).toBe(200);
    expect(analysis.response.headers.get("content-type")).toContain("text/event-stream");
    expect(analysis.body).toContain("list_runs");
    expect(analysis.body).toContain('"done":true');

    const unauthenticated = await callBinary(bindings, "/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body,
    });
    expect(unauthenticated.response.status).toBe(401);

    const writeOnlyToken = await createOAuthAccessToken(bindings, ["soyuz:write"]);
    const writeOnly = await callBinary(bindings, "/dashboard/api/analysis/generate", {
      method: "POST",
      token: writeOnlyToken,
      headers: { "content-type": "application/json" },
      body: request.body,
    });
    expect(writeOnly.response.status).toBe(403);

    const otherPost = await call(bindings, "/dashboard/api/runs", {
      method: "POST",
      token: accessToken,
      body: validRequest(),
    });
    expect(otherPost.response.status).toBe(405);
  });

  it("[MCP-BODY-01] rejects oversized OAuth MCP requests before scope inspection buffers them", async () => {
    const { bindings } = testEnv({ oauth: true });
    const accessToken = await createOAuthAccessToken(bindings);
    const response = await callBinary(bindings, "/mcp", {
      method: "POST",
      token: accessToken,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: { padding: "x".repeat(100 * 1024) },
      }),
    });

    expect(response.response.status).toBe(413);
    expect((response.body as any).error.code).toBe("REQUEST_TOO_LARGE");
  });

  it("[OPENUI-RATE-LIMIT-01] applies a per-GitHub-user limit before analysis generation", async () => {
    const { bindings, openuiGenerationLimiter } = testEnv({ oauth: true, openuiDemo: true });
    const accessToken = await createOAuthAccessToken(bindings);
    openuiGenerationLimiter.limit.mockResolvedValue({ success: false });

    const response = await callBinary(bindings, "/dashboard/api/analysis/generate", {
      method: "POST",
      token: accessToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Summarise the last 10 runs.", mode: "generate" }),
    });

    expect(response.response.status).toBe(429);
    expect(response.response.headers.get("retry-after")).toBe("60");
    expect(openuiGenerationLimiter.limit).toHaveBeenCalledWith({ key: "123" });
  });

  it("[RATE-LIMIT-FAIL-CLOSED-01] blocks quota-protected routes when Cloudflare rate limiting is unavailable", async () => {
    const registration = testEnv({ oauth: true });
    registration.oauthRegistrationLimiter.limit.mockRejectedValue(new Error("simulated limiter failure"));
    const registrationResponse = await call(registration.bindings, "/oauth/register", {
      method: "POST",
      body: { client_name: "Rate limit test" },
    });
    expect(registrationResponse.response.status).toBe(503);
    expect(registrationResponse.body.error.code).toBe("RATE_LIMITER_UNAVAILABLE");

    const analysis = testEnv({ oauth: true, openuiDemo: true });
    const accessToken = await createOAuthAccessToken(analysis.bindings);
    analysis.openuiGenerationLimiter.limit.mockRejectedValue(new Error("simulated limiter failure"));
    const analysisResponse = await callBinary(analysis.bindings, "/dashboard/api/analysis/generate", {
      method: "POST",
      token: accessToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Summarise the last 10 runs.", mode: "generate" }),
    });
    expect(analysisResponse.response.status).toBe(503);
    expect((analysisResponse.body as any).error.code).toBe("RATE_LIMITER_UNAVAILABLE");
  });

  it("[OAUTH-03] renders an escaped, non-framable consent page and binds approval to the browser request", async () => {
    const { bindings } = testEnv({ oauth: true });
    const flow = await beginOAuthConsent(bindings);
    expect(flow.registration.response.status).toBe(201);
    expect(flow.consent.status).toBe(200);
    expect(flow.consent.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(flow.consent.headers.get("content-security-policy")).toContain("form-action 'self' https://github.com");
    expect(flow.consent.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(flow.consent.headers.get("cache-control")).toBe("no-store");
    expect(flow.html).toContain("Consent &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(flow.html).not.toContain("<script>alert(1)</script>");
    expect(flow.html).toContain("read:user permission");
    expect(flow.consent.headers.get("set-cookie")).toContain("__Host-oauth-consent");

    const oauthInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const approval = await approveOAuthConsent(bindings, flow.handle);
      expect(approval.status).toBe(302);
      expect(approval.headers.get("x-request-id")).toBeTruthy();
      expect(oauthInfo).toHaveBeenCalledOnce();
      const oauthEvent = JSON.parse(String(oauthInfo.mock.calls[0][0]));
      expect(oauthEvent).toMatchObject({ event: "soyuz.oauth.upstream_redirect", destination: "https://github.com" });
      expect(JSON.stringify(oauthEvent)).not.toContain(flow.handle);
      expect(JSON.stringify(oauthEvent)).not.toContain("consent-test-state");
      const githubAuthorize = new URL(approval.headers.get("location")!);
      expect(githubAuthorize.origin).toBe("https://github.com");
      expect(githubAuthorize.pathname).toBe("/login/oauth/authorize");
      expect(githubAuthorize.searchParams.get("code_challenge_method")).toBe("S256");
    } finally {
      oauthInfo.mockRestore();
    }
  });

  it("[OAUTH-CALLBACK-01] exchanges GitHub authorization and redirects only a code to the approved client", async () => {
    const { bindings } = testEnv({ oauth: true });
    const oauthInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const flow = await beginOAuthConsent(bindings);
      const approval = await approveOAuthConsent(bindings, flow.handle);
      const githubAuthorize = new URL(approval.headers.get("location")!);
      const githubRequests: Array<{ url: string; init?: RequestInit }> = [];
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        githubRequests.push({ url, init });
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(JSON.stringify({ access_token: "short-lived-github-token" }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "https://api.github.com/user") {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer short-lived-github-token");
          return new Response(JSON.stringify({ id: 123, login: "allowed-test-user" }), {
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected external OAuth request: ${url}`);
      }));
      const githubState = githubAuthorize.searchParams.get("state");
      const callback = await handleRequest(new Request(
        `https://soyuz.test/oauth/callback?code=github-code&state=${encodeURIComponent(githubState ?? "")}`,
        { headers: { cookie: cookieHeader(approval) } },
      ), bindings);
      expect(callback.status).toBe(302);
      const redirect = new URL(callback.headers.get("location")!);
      expect(redirect.origin).toBe("https://client.example.test");
      expect(redirect.searchParams.get("state")).toBe("consent-test-state");
      expect(redirect.searchParams.get("code")).toBeTruthy();
      expect(callback.headers.get("location")).not.toContain("short-lived-github-token");
      const tokenRequestBody = new URLSearchParams(githubRequests[0].init?.body as URLSearchParams);
      expect(tokenRequestBody.get("code_verifier")).toBeTruthy();
      expect(tokenRequestBody.get("redirect_uri")).toBe("https://soyuz.test/oauth/callback");
      expect(githubRequests.map(({ url }) => url)).toEqual([
        "https://github.com/login/oauth/access_token",
        "https://api.github.com/user",
      ]);
    } finally {
      vi.unstubAllGlobals();
      oauthInfo.mockRestore();
    }
  });

  it("[AUTH-ROTATE-01] rejects old client and worker credentials after key rotation", async () => {
    const { bindings } = testEnv();
    const rotated = { ...bindings, CLIENT_API_TOKEN: "rotated-client-key-value-long-enough" };
    const rotatedClient = await call(rotated, "/v1/runs", { token: CLIENT_TOKEN });
    expect(rotatedClient.response.status).toBe(401);
    expect(rotatedClient.body.error.code).toBe("UNAUTHORIZED");
    expect(rotatedClient.body.error.message).not.toContain("expired");
    expect(rotatedClient.body.error.message).toContain("current client key");

    const rotatedWorker = { ...bindings, WORKER_API_TOKEN: "rotated-worker-key-value-long-enough" };
    const rotatedWorkerResponse = await call(rotatedWorker, "/v1/worker/runs/00000000-0000-4000-8000-000000000013", {
      token: WORKER_TOKEN,
    });
    expect(rotatedWorkerResponse.response.status).toBe(401);
    expect(rotatedWorkerResponse.body.error.message).not.toContain("expired");
    expect(rotatedWorkerResponse.body.error.message).toContain("current worker key");
  });

  it("[AUTH-ROTATE-GRACE-01] accepts configured previous client and worker keys until their expiry", async () => {
    const { bindings } = testEnv();
    const run = await submit(bindings);
    const runId = run.body.data.id as string;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    const rotatedClient = {
      ...bindings,
      CLIENT_API_TOKEN: "rotated-client-key-value-long-enough",
      CLIENT_API_TOKEN_PREVIOUS: CLIENT_TOKEN,
      CLIENT_API_TOKEN_PREVIOUS_EXPIRES_AT: expiresAt,
    };
    const previousClient = await call(rotatedClient, "/v1/runs", { token: CLIENT_TOKEN });
    expect(previousClient.response.status).toBe(200);

    const rotatedWorker = {
      ...bindings,
      WORKER_API_TOKEN: "rotated-worker-key-value-long-enough",
      WORKER_API_TOKEN_PREVIOUS: WORKER_TOKEN,
      WORKER_API_TOKEN_PREVIOUS_EXPIRES_AT: expiresAt,
    };
    const previousWorker = await call(rotatedWorker, `/v1/worker/runs/${runId}`, { token: WORKER_TOKEN });
    expect(previousWorker.response.status).toBe(200);

    const expiredClient = {
      ...rotatedClient,
      CLIENT_API_TOKEN_PREVIOUS_EXPIRES_AT: new Date(Date.now() - 1_000).toISOString(),
    };
    const rejectedClient = await call(expiredClient, "/v1/runs", { token: CLIENT_TOKEN });
    expect(rejectedClient.response.status).toBe(401);

    const rotatedKaseki = {
      ...bindings,
      KASEKI_SUBMISSION_API_TOKEN: "rotated-kaseki-key-value-long-enough",
      KASEKI_SUBMISSION_API_TOKEN_PREVIOUS: KASEKI_TOKEN,
      KASEKI_SUBMISSION_API_TOKEN_PREVIOUS_EXPIRES_AT: expiresAt,
    };
    const previousKaseki = await call(rotatedKaseki, "/v1/runs", {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000095" },
      body: validRequest(),
    });
    expect(previousKaseki.response.status).toBe(202);
  });

  it("[HEALTH-DB-01] explains when the run database endpoint is unavailable", async () => {
    const { bindings } = testEnv();
    const disconnected = {
      ...bindings,
      DB: { prepare: vi.fn(() => { throw new Error("simulated D1 disconnect"); }) } as unknown as Env["DB"],
    };

    const health = await call(disconnected, "/health");
    expect(health.response.status).toBe(503);
    expect(health.body.status).toBe("unavailable");
    expect(health.body.message).toContain("cannot reach its run database");

    const history = await call(disconnected, "/v1/runs", { token: CLIENT_TOKEN });
    expect(history.response.status).toBe(503);
    expect(history.body.error.code).toBe("RUN_LIST_UNAVAILABLE");
    expect(history.body.error.message).toContain("cannot reach its run database");
  });

  it("[HEALTH-SCHEMA-01] reports unavailable when required liveness columns are missing", async () => {
    const { bindings } = testEnv();
    const database = {
      prepare(sql: string) {
        if (sql.includes("last_heartbeat_at") || sql.includes("operational_health")) {
          return {
            first: async () => { throw new Error("no such column: last_heartbeat_at"); },
          };
        }
        return bindings.DB.prepare(sql);
      },
    } as unknown as Env["DB"];
    const response = await handleRequest(new Request("https://soyuz.test/health"), { ...bindings, DB: database });
    const body = await response.json() as { status: string; message: string };

    expect(response.status).toBe(503);
    expect(body.status).toBe("unavailable");
    expect(body.message).toContain("verify its required schema");
  });

  it("[RETENTION-REQUEST-01] redacts old terminal request payloads while keeping run and idempotency history", async () => {
    const { bindings } = testEnv();
    const old = await submit(bindings, { taskPrompt: "Private prompt older than the retention window" }, "00000000-0000-4000-8000-000000000091");
    const recent = await submit(bindings, { taskPrompt: "Recent prompt remains available" }, "00000000-0000-4000-8000-000000000092");
    const active = await submit(bindings, { taskPrompt: "Active prompt remains available" }, "00000000-0000-4000-8000-000000000093");
    const oldRunId = old.body.data.id as string;
    const recentRunId = recent.body.data.id as string;
    const activeRunId = active.body.data.id as string;
    await bindings.DB.batch([
      bindings.DB.prepare("UPDATE runs SET status = 'completed', completed_at = '2025-10-17T00:00:00.000Z' WHERE id = ?").bind(oldRunId),
      bindings.DB.prepare("UPDATE runs SET status = 'completed', completed_at = '2025-10-19T00:00:00.000Z' WHERE id = ?").bind(recentRunId),
    ]);

    await purgeExpiredRunRequests(bindings, new Date("2026-10-18T00:00:00.000Z"));

    const oldRow = await bindings.DB.prepare("SELECT request_json, request_redacted_at, idempotency_key FROM runs WHERE id = ?")
      .bind(oldRunId).first<{ request_json: string; request_redacted_at: string | null; idempotency_key: string | null }>();
    const recentRow = await bindings.DB.prepare("SELECT request_json, request_redacted_at FROM runs WHERE id = ?")
      .bind(recentRunId).first<{ request_json: string; request_redacted_at: string | null }>();
    const activeRow = await bindings.DB.prepare("SELECT request_json, request_redacted_at FROM runs WHERE id = ?")
      .bind(activeRunId).first<{ request_json: string; request_redacted_at: string | null }>();

    expect(JSON.parse(oldRow!.request_json)).toMatchObject({ repoUrl: "https://github.com/example/project", taskPrompt: "[redacted after 365 days]" });
    expect(oldRow!.request_redacted_at).toBe("2026-10-18T00:00:00.000Z");
    expect(oldRow!.idempotency_key).toBe("00000000-0000-4000-8000-000000000091");
    expect(JSON.parse(recentRow!.request_json).taskPrompt).toBe("Recent prompt remains available");
    expect(recentRow!.request_redacted_at).toBeNull();
    expect(JSON.parse(activeRow!.request_json).taskPrompt).toBe("Active prompt remains available");
    expect(activeRow!.request_redacted_at).toBeNull();

    const retry = await call(bindings, `/v1/runs/${oldRunId}/retry`, {
      method: "POST",
      token: CLIENT_TOKEN,
      body: { idempotencyKey: "00000000-0000-4000-8000-000000000094" },
    });
    expect(retry.response.status).toBe(409);
    expect(retry.body.error.code).toBe("RUN_REQUEST_REDACTED");
  });

  it("[RUN-ADMISSION-01/QUEUE-MESSAGE-01/CONTRACT-VERSION-01/WORKER-READ-01] persists accepted runs and publishes a versioned Queue message", async () => {
    const { bindings, sent } = testEnv();
    const { response, body } = await submit(bindings);
    expect(response.status).toBe(202);
    expect(body.data.status).toBe("queued");
    expect(body.data.contractVersion).toBe("1");
    expect(body.data.displayId).toMatch(/^soyuz-\d+$/);
    expect(body.data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.data.ref).toBe("main");
    expect(body.data.publishMode).toBe("pr");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      contractVersion: "1",
      runId: body.data.id,
      request: { repoUrl: "https://github.com/example/project", taskMode: "patch", publishMode: "pr" },
    });

    const stored = await getRun(bindings.DB, body.data.id);
    expect(stored?.status).toBe("queued");
    expect(stored?.display_id).toBe(body.data.displayId);
    expect(stored?.idempotency_key).toBe(CLIENT_KEY);
    expect(stored?.queued_at).toBeTruthy();

    const workerState = await call(bindings, `/v1/worker/runs/${body.data.id}`, { token: WORKER_TOKEN });
    expect(workerState.response.status).toBe(200);
    expect(workerState.body.data.status).toBe("queued");
    expect(workerState.body.data.displayId).toBe(body.data.displayId);
    const clientCannotPollAsWorker = await call(bindings, `/v1/worker/runs/${body.data.id}`, { token: CLIENT_TOKEN });
    expect(clientCannotPollAsWorker.response.status).toBe(401);

    const detail = await call(bindings, `/v1/runs/${body.data.id}`, { token: CLIENT_TOKEN });
    const list = await call(bindings, "/v1/runs?limit=30", { token: CLIENT_TOKEN });
    expect(detail.body.data).toMatchObject({ id: body.data.id, displayId: body.data.displayId });
    expect(list.body.data.runs[0]).toMatchObject({ id: body.data.id, displayId: body.data.displayId });
  });

  it("[RUN-IDEMPOTENCY-01] replays equivalent submissions and rejects key reuse for different work", async () => {
    const { bindings, sent } = testEnv();
    const first = await call(bindings, "/v1/runs", {
      method: "POST",
      token: CLIENT_TOKEN,
      body: {
        idempotencyKey: CLIENT_KEY.toUpperCase(),
        taskPrompt: "Update the project documentation and keep the API examples current.",
        repoUrl: "https://github.com/example/project",
      },
    });
    const replay = await submit(bindings);
    expect(first.response.status).toBe(202);
    expect(replay.response.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.data.displayId).toBe(first.body.data.displayId);
    expect(sent).toHaveLength(1);

    const conflict = await submit(bindings, { taskPrompt: "Use the same idempotency key with different work." });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(sent).toHaveLength(1);
  });

  it("[RUN-DISPLAY-ID-01] assigns stable increasing display IDs while keeping the UUID canonical", async () => {
    const { bindings } = testEnv();
    const first = await submit(bindings, {}, "00000000-0000-4000-8000-000000000071");
    const second = await submit(bindings, {}, "00000000-0000-4000-8000-000000000072");

    expect(first.body.data.displayId).toMatch(/^soyuz-\d+$/);
    expect(second.body.data.displayId).toMatch(/^soyuz-\d+$/);
    expect(first.body.data.displayId).not.toBe(second.body.data.displayId);
    expect(Number(second.body.data.displayId.slice("soyuz-".length)))
      .toBeGreaterThan(Number(first.body.data.displayId.slice("soyuz-".length)));
    expect(first.body.data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.body.data.id).toMatch(/^[0-9a-f-]{36}$/);
    const persisted = await call(bindings, `/v1/runs/${first.body.data.id}`, { token: CLIENT_TOKEN });
    expect(persisted.response.status).toBe(200);
    expect(persisted.body.data).toMatchObject({
      id: first.body.data.id,
      displayId: first.body.data.displayId,
    });
  });

  it("[RUN-DISPLAY-ID-SCHEMA-01] rejects null display IDs at the database boundary", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings, {}, "00000000-0000-4000-8000-000000000073");

    await expect(bindings.DB.prepare("UPDATE runs SET display_id = NULL WHERE id = ?")
      .bind(created.body.data.id).run()).rejects.toThrow(/NOT NULL constraint failed: runs\.display_id/);

    const stored = await bindings.DB.prepare("SELECT display_id FROM runs WHERE id = ?")
      .bind(created.body.data.id).first<{ display_id: string }>();
    expect(stored?.display_id).toBe(created.body.data.displayId);
  });

  it("[RUN-ORIGIN-01] derives Kaseki provenance from its scoped credential and scopes idempotency", async () => {
    const { bindings, sent } = testEnv();
    const kaseki = {
      ...bindings,
      KASEKI_SUBMISSION_API_TOKEN: KASEKI_TOKEN,
      KASEKI_SUBMISSION_IDENTITY: "kaseki-prod",
    };
    const key = "00000000-0000-4000-8000-000000000060";
    const clientRun = await submit(bindings, {}, key);
    const kasekiRun = await call(kaseki, "/v1/runs", {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": key },
      body: validRequest(),
    });

    expect(clientRun.body.data.origin).toEqual({ type: "api_client", id: "client-api" });
    expect(kasekiRun.response.status).toBe(202);
    expect(kasekiRun.body.data.origin).toEqual({ type: "kaseki", id: "kaseki-prod" });
    expect(kasekiRun.body.data.id).not.toBe(clientRun.body.data.id);
    expect((await getRun(kaseki.DB, kasekiRun.body.data.id))?.origin_type).toBe("kaseki");
    expect(sent).toHaveLength(2);

    const crossOriginCancel = await call(kaseki, `/v1/runs/${clientRun.body.data.id}/cancel`, {
      method: "POST",
      token: KASEKI_TOKEN,
    });
    expect(crossOriginCancel.response.status).toBe(403);
    expect(crossOriginCancel.body.error.code).toBe("RUN_ORIGIN_MISMATCH");
    const ownOriginCancel = await call(kaseki, `/v1/runs/${kasekiRun.body.data.id}/cancel`, {
      method: "POST",
      token: KASEKI_TOKEN,
    });
    expect(ownOriginCancel.response.status).toBe(202);
    expect(ownOriginCancel.body.data.status).toBe("cancelled");

    const deniedRead = await call(kaseki, "/v1/runs", { token: KASEKI_TOKEN });
    expect(deniedRead.response.status).toBe(403);
    expect(deniedRead.body.error.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("[RUN-RETRY-01] retries a terminal Kaseki run once and replays the same retry", async () => {
    const { bindings, sent } = testEnv();
    const kaseki = {
      ...bindings,
      KASEKI_SUBMISSION_API_TOKEN: KASEKI_TOKEN,
      KASEKI_SUBMISSION_IDENTITY: "kaseki-prod",
    };
    const source = await call(kaseki, "/v1/runs", {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000066" },
      body: validRequest(),
    });
    expect(source.response.status).toBe(202);
    const sourceId = source.body.data.id as string;
    const workerId = "docker-host-retry";
    await claimRun(bindings, sourceId, workerId, "00000000-0000-4000-8000-000000000061");
    await call(bindings, `/v1/worker/runs/${sourceId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000062",
        workerId,
      },
    });
    await call(bindings, `/v1/worker/runs/${sourceId}/completed`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000063",
        workerId,
        exitCode: 0,
      },
    });

    const retryKey = "00000000-0000-4000-8000-000000000064";
    const retryRequest = {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": retryKey },
      body: { idempotencyKey: retryKey },
    };
    const retry = await call(kaseki, `/v1/runs/${sourceId}/retry`, retryRequest);
    const replay = await call(kaseki, `/v1/runs/${sourceId}/retry`, retryRequest);

    expect(retry.response.status).toBe(202);
    expect(retry.body.data.origin).toEqual({ type: "kaseki", id: "kaseki-prod" });
    expect(retry.body.data.retryOf).toBe(sourceId);
    expect(retry.body.data.id).not.toBe(sourceId);
    expect(replay.response.status).toBe(200);
    expect(replay.body.data.id).toBe(retry.body.data.id);
    expect((await getRun(bindings.DB, retry.body.data.id))?.retry_of).toBe(sourceId);
    expect(sent).toHaveLength(2);
  });

  it("[RUN-RETRY-ELIGIBILITY-01] rejects retrying a nonterminal run", async () => {
    const { bindings } = testEnv();
    const kaseki = {
      ...bindings,
      KASEKI_SUBMISSION_API_TOKEN: KASEKI_TOKEN,
      KASEKI_SUBMISSION_IDENTITY: "kaseki-prod",
    };
    const nonTerminal = await call(kaseki, "/v1/runs", {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000065" },
      body: validRequest(),
    });
    const rejected = await call(kaseki, `/v1/runs/${nonTerminal.body.data.id}/retry`, {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000069" },
      body: { idempotencyKey: "00000000-0000-4000-8000-000000000069" },
    });
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error.code).toBe("RUN_NOT_RETRYABLE");
  });

  it("[RUN-RETRY-HTTPS-01] rejects retries of legacy runs whose repository URL is not HTTPS", async () => {
    const { bindings, sent } = testEnv();
    const source = await submit(bindings, {}, "00000000-0000-4000-8000-000000000077");
    const sourceRunId = source.body.data.id as string;
    const legacyRequest = validRequest({ repoUrl: "http://github.com/example/legacy-project.git" });
    await bindings.DB.prepare("UPDATE runs SET repo_url = ?, request_json = ?, status = 'completed', completed_at = ? WHERE id = ?")
      .bind(legacyRequest.repoUrl, JSON.stringify(legacyRequest), "2026-10-20T00:00:00.000Z", sourceRunId).run();

    const retry = await call(bindings, `/v1/runs/${sourceRunId}/retry`, {
      method: "POST",
      token: CLIENT_TOKEN,
      body: { idempotencyKey: "00000000-0000-4000-8000-000000000078" },
    });

    expect(retry.response.status).toBe(409);
    expect(retry.body.error.code).toBe("RUN_REPOSITORY_URL_UNSUPPORTED");
    expect(retry.body.error.message).toContain("HTTPS");
    expect(sent).toHaveLength(1);
  });

  it("[RUN-RETRY-ORIGIN-01] rejects retrying a run owned by another origin", async () => {
    const { bindings } = testEnv();
    const kaseki = {
      ...bindings,
      KASEKI_SUBMISSION_API_TOKEN: KASEKI_TOKEN,
      KASEKI_SUBMISSION_IDENTITY: "kaseki-prod",
    };
    const foreignSource = await submit(bindings, {}, "00000000-0000-4000-8000-000000000067");
    const foreignRetryKey = "00000000-0000-4000-8000-000000000068";
    const foreignRetry = await call(kaseki, `/v1/runs/${foreignSource.body.data.id}/retry`, {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": foreignRetryKey },
      body: { idempotencyKey: foreignRetryKey },
    });
    expect(foreignRetry.response.status).toBe(403);
    expect(foreignRetry.body.error.code).toBe("RUN_ORIGIN_MISMATCH");
  });

  it("[RUN-RETRY-TERMINAL-01] retries cancelled and admission_failed Kaseki runs", async () => {
    const cancelledEnv = testEnv();
    const kaseki = {
      ...cancelledEnv.bindings,
      KASEKI_SUBMISSION_API_TOKEN: KASEKI_TOKEN,
      KASEKI_SUBMISSION_IDENTITY: "kaseki-prod",
    };
    const cancelledSource = await call(kaseki, "/v1/runs", {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000069" },
      body: validRequest(),
    });
    const cancelledId = cancelledSource.body.data.id as string;
    await call(kaseki, `/v1/runs/${cancelledId}/cancel`, { method: "POST", token: KASEKI_TOKEN });

    const retryCancelledKey = "00000000-0000-4000-8000-000000000070";
    const retryCancelled = await call(kaseki, `/v1/runs/${cancelledId}/retry`, {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": retryCancelledKey },
      body: { idempotencyKey: retryCancelledKey },
    });
    expect(retryCancelled.response.status).toBe(202);
    expect(retryCancelled.body.data.retryOf).toBe(cancelledId);

    const failingEnv = testEnv({ queueFailure: true });
    const failingKaseki = {
      ...failingEnv.bindings,
      KASEKI_SUBMISSION_API_TOKEN: KASEKI_TOKEN,
      KASEKI_SUBMISSION_IDENTITY: "kaseki-prod",
    };
    const failedAdmission = await call(failingKaseki, "/v1/runs", {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000071" },
      body: validRequest(),
    });
    const admissionFailedId = failedAdmission.body.error.details.runId as string;
    const now = new Date().toISOString();
    await transitionRun(failingEnv.bindings.DB, admissionFailedId, "admission_failed", {
      completed_at: now,
      failure_class: "queue_publish_failed",
      failure_message: "test queue publication failure",
    }, {
      eventId: "test:admission-failed",
      type: "run.admission_failed",
      occurredAt: now,
      recordedAt: now,
      payload: { failureClass: "queue_publish_failed", attempts: 5 },
    }, { expectedStatus: "admitting" });

    const retryAdmissionFailedKey = "00000000-0000-4000-8000-000000000072";
    const retryAdmissionFailed = await call(kaseki, `/v1/runs/${admissionFailedId}/retry`, {
      method: "POST",
      token: KASEKI_TOKEN,
      headers: { "Idempotency-Key": retryAdmissionFailedKey },
      body: { idempotencyKey: retryAdmissionFailedKey },
    });
    expect(retryAdmissionFailed.response.status).toBe(202);
    expect(retryAdmissionFailed.body.data.retryOf).toBe(admissionFailedId);
  });

  it("[QUEUE-RETRY-01] retries ambiguous Queue publication failures before marking admission_failed", async () => {
    const { bindings, send } = testEnv({ queueFailure: true });
    const result = await submit(bindings);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(503);
    expect(result.body.error.code).toBe("QUEUE_PUBLISH_UNCERTAIN");
    expect(result.body.error.message).toContain("The run remains pending");
    expect(result.body.error.message).toContain("same Idempotency-Key");
    const runId = result.body.error.details.runId as string;
    expect((await getRun(bindings.DB, runId))?.status).toBe("admitting");

    const base = Date.now();
    for (let minute = 2; minute <= 5; minute += 1) {
      await reconcileAdmissions(bindings, new Date(base + minute * 60_000));
    }
    const row = await getRun(bindings.DB, runId);
    expect(send).toHaveBeenCalledTimes(5);
    expect(row?.status).toBe("admission_failed");
    expect(row?.failure_class).toBe("queue_publish_failed");
    expect(row?.failure_message).toContain("new Idempotency-Key");
  });

  it("[RUN-ADMISSION-SIZE-01] rejects an oversized Queue message and records admission failure", async () => {
    const { bindings, send } = testEnv();
    const result = await submit(bindings, {
      validationCommands: [
        ...Array.from({ length: 47 }, () => "x".repeat(2_048)),
        "x".repeat(1_500),
      ],
    });

    expect(result.response.status).toBe(422);
    expect(result.body.error.code).toBe("RUN_REQUEST_TOO_LARGE");
    expect(send).not.toHaveBeenCalled();
    const row = await getRun(bindings.DB, result.body.error.details.runId as string);
    expect(row?.status).toBe("admission_failed");
    expect(row?.failure_class).toBe("queue_message_too_large");
  });

  it("[WORKER-CLAIM-01] grants an idempotent claim to one worker", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-a";
    const firstClaim = await claimRun(bindings, runId, workerId);
    const claimReplay = await claimRun(bindings, runId, workerId);
    const competingClaim = await claimRun(bindings, runId, "docker-host-b", "00000000-0000-4000-8000-000000000031");
    const stored = await getRun(bindings.DB, runId);
    expect(firstClaim.response.status).toBe(200);
    expect(firstClaim.body.data.status).toBe("claimed");
    expect(claimReplay.response.status).toBe(200);
    expect(competingClaim.response.status).toBe(409);
    expect(stored?.worker_id).toBe(workerId);
    expect(stored?.claim_expires_at).toBe(firstClaim.body.data.claimExpiresAt);
    expect(claimReplay.body.data.claimExpiresAt).toBe(firstClaim.body.data.claimExpiresAt);
    expect(await countRunEvents(bindings, runId, "run.claimed")).toBe(1);
  });

  it("[WORKER-CLAIM-FENCE-01] rejects a stale same-worker start after an expired claim is replaced", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-reused-id";
    const oldClaimId = "00000000-0000-4000-8000-000000000070";
    const newClaimId = "00000000-0000-4000-8000-000000000071";
    const first = await claimRun(bindings, runId, workerId, oldClaimId);
    expect(first.response.status).toBe(200);

    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    await bindings.DB.prepare("UPDATE runs SET claim_expires_at = ? WHERE id = ?").bind(expiredAt, runId).run();
    await reconcileAdmissions(bindings, new Date());
    const second = await claimRun(bindings, runId, workerId, newClaimId);
    expect(second.response.status).toBe(200);
    const currentRead = await call(bindings, `/v1/worker/runs/${runId}`, { token: WORKER_TOKEN });
    expect(currentRead.body.data.claimCallbackId).toBe(newClaimId);

    const staleStart = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000072",
        workerId,
        claimCallbackId: oldClaimId,
      },
    });
    expect(staleStart.response.status).toBe(409);
    expect(staleStart.body.error.code).toBe("STALE_CLAIM");

    const currentStart = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000073",
        workerId,
        claimCallbackId: newClaimId,
      },
    });
    expect(currentStart.response.status).toBe(200);
    expect(currentStart.body.data.status).toBe("running");
  });

  it("[WORKER-CLAIM-FENCE-02] rejects stale heartbeat and terminal callbacks", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-fenced";
    const currentClaimId = "00000000-0000-4000-8000-000000000074";
    const staleClaimId = "00000000-0000-4000-8000-000000000075";
    await claimRun(bindings, runId, workerId, currentClaimId);
    const started = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000076",
        workerId,
        claimCallbackId: currentClaimId,
      },
    });
    expect(started.response.status).toBe(200);

    const heartbeat = await call(bindings, `/v1/worker/runs/${runId}/events`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        eventId: "00000000-0000-4000-8000-000000000077",
        workerId,
        claimCallbackId: staleClaimId,
        type: "worker.heartbeat",
      },
    });
    const completed = await call(bindings, `/v1/worker/runs/${runId}/completed`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000078",
        workerId,
        claimCallbackId: staleClaimId,
      },
    });
    expect(heartbeat.response.status).toBe(409);
    expect(heartbeat.body.error.code).toBe("STALE_CLAIM");
    expect(completed.response.status).toBe(409);
    expect(completed.body.error.code).toBe("STALE_CLAIM");
    expect((await getRun(bindings.DB, runId))?.status).toBe("running");
  });

  it("[WORKER-CLAIM-FENCE-03] rejects a claim superseded between callback validation and write", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-racing-claim";
    const oldClaimId = "00000000-0000-4000-8000-000000000081";
    const newClaimId = "00000000-0000-4000-8000-000000000082";
    const startedCallbackId = "00000000-0000-4000-8000-000000000083";
    const claim = await claimRun(bindings, runId, workerId, oldClaimId);
    expect(claim.response.status).toBe(200);

    // Replace the lease immediately before transitionRun commits its batch. This
    // models another controller winning after callback validation but before write.
    const racingDatabase = withSupersededClaimOnNextBatch(bindings.DB, {
      runId,
      workerId,
      replacementClaimId: newClaimId,
    });

    await expect(transitionRun(racingDatabase, runId, "running", {
      worker_id: workerId,
      started_at: new Date().toISOString(),
      claim_expires_at: null,
    }, {
      eventId: startedCallbackId,
      type: "run.started",
      workerId,
      claimCallbackId: oldClaimId,
      occurredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      payload: {},
    }, { claimOwner: workerId, claimCallbackId: oldClaimId })).rejects.toMatchObject({
      code: "STALE_CLAIM",
    });
    expect(await getRun(bindings.DB, runId)).toMatchObject({
      status: "running",
      claim_callback_id: newClaimId,
    });
    expect(await countRunEvents(bindings, runId, "run.started")).toBe(0);
  });

  it("[WORKER-CLAIM-ID-01] rejects a reused claim callback ID with a different lease", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-claim-replay";
    const first = await claimRun(bindings, runId, workerId);
    const reused = await call(bindings, `/v1/worker/runs/${runId}/claim`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000030",
        workerId,
        leaseSeconds: 180,
      },
    });

    expect(first.response.status).toBe(200);
    expect(reused.response.status).toBe(409);
    expect(reused.body.error.code).toBe("CALLBACK_ID_REUSED");
    expect(await countRunEvents(bindings, runId, "run.claimed")).toBe(1);
  });

  it("[WORKER-CLAIM-FENCE-00] rejects a second active claim from a reused worker ID", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-reused-id";
    const first = await claimRun(bindings, runId, workerId, "00000000-0000-4000-8000-000000000079");
    const second = await claimRun(bindings, runId, workerId, "00000000-0000-4000-8000-000000000080");

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(409);
    expect(second.body.error.code).toBe("STALE_CLAIM");
    expect(await countRunEvents(bindings, runId, "run.claimed")).toBe(1);
  });

  it("[WORKER-CLAIM-RACE-01] grants a queued run to only one concurrent worker", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const claims = await Promise.all([
      claimRun(bindings, runId, "docker-host-race-a", "00000000-0000-4000-8000-000000000032"),
      claimRun(bindings, runId, "docker-host-race-b", "00000000-0000-4000-8000-000000000033"),
    ]);

    const granted = claims.filter((claim) => claim.response.status === 200);
    const rejected = claims.filter((claim) => claim.response.status !== 200);
    const stored = await getRun(bindings.DB, runId);
    expect(granted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].response.status).toBe(409);
    expect(rejected[0].body.error.code).toBe("RUN_CLAIMED");
    expect(["docker-host-race-a", "docker-host-race-b"]).toContain(stored?.worker_id);
    expect(await countRunEvents(bindings, runId, "run.claimed")).toBe(1);
  });

  it("[WORKER-START-01] replays the same started callback without changing running state", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-start";
    await claimRun(bindings, runId, workerId);
    const now = new Date().toISOString();
    const startedBody = {
      contractVersion: "1",
      callbackId: CALLBACK_ID,
      workerId,
      startedAt: now,
      stage: "prepare",
    };
    const started = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN, body: startedBody,
    });
    const afterFirstStart = await getRun(bindings.DB, runId);
    const startedReplay = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN, body: startedBody,
    });
    const afterReplay = await getRun(bindings.DB, runId);
    expect(started.response.status).toBe(200);
    expect(started.body.data.status).toBe("running");
    expect(startedReplay.body.data.status).toBe("running");
    expect(afterReplay?.started_at).toBe(afterFirstStart?.started_at);
    expect(afterReplay?.stage).toBe("prepare");
    expect(await countRunEvents(bindings, runId, "run.started")).toBe(1);

    const reusedCallbackId = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { ...startedBody, stage: "execute" },
    });
    expect(reusedCallbackId.response.status).toBe(409);
    expect(reusedCallbackId.body.error.code).toBe("CALLBACK_ID_REUSED");
    expect((await getRun(bindings.DB, runId))?.stage).toBe("prepare");
  });

  it("[WORKER-START-02] rejects a started callback after its claim lease expires", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-expired-claim";
    await claimRun(bindings, runId, workerId, "00000000-0000-4000-8000-000000000085");
    await bindings.DB.prepare("UPDATE runs SET claim_expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1_000).toISOString(), runId).run();

    const started = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000086",
        workerId,
      },
    });

    expect(started.response.status).toBe(409);
    expect(started.body.error.code).toBe("CLAIM_EXPIRED");
    expect(await getRun(bindings.DB, runId)).toMatchObject({ status: "claimed", worker_id: workerId });
  });

  it("[WORKER-EVENT-01/CALLBACK-IDEMPOTENCY-01] stores one event when the worker retries its callback", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-events";
    await claimRun(bindings, runId, workerId);
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: CALLBACK_ID, workerId },
    });
    const now = new Date().toISOString();
    const eventBody = {
      contractVersion: "1",
      eventId: EVENT_ID,
      workerId,
      type: "stage.changed",
      stage: "execute",
      timestamp: now,
      payload: { source: "pi-agent" },
    };
    await call(bindings, `/v1/worker/runs/${runId}/events`, { method: "POST", token: WORKER_TOKEN, body: eventBody });
    const eventReplay = await call(bindings, `/v1/worker/runs/${runId}/events`, { method: "POST", token: WORKER_TOKEN, body: eventBody });
    expect(eventReplay.response.status).toBe(202);
    const reusedId = await call(bindings, `/v1/worker/runs/${runId}/events`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { ...eventBody, payload: { source: "different-agent" } },
    });
    expect(reusedId.response.status).toBe(409);
    expect(reusedId.body.error.code).toBe("CALLBACK_ID_REUSED");

    const eventList = await call(bindings, `/v1/runs/${runId}/events?limit=20`, { token: CLIENT_TOKEN });
    expect(eventList.response.status).toBe(200);
    expect(eventList.body.data.events.filter((entry: { eventId: string }) => entry.eventId === EVENT_ID)).toHaveLength(1);
  });

  it("[WORKER-ARTIFACT-REPORT-01] stores bounded artifact delivery counts in the run timeline", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-artifacts";
    await claimRun(bindings, runId, workerId);
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: CALLBACK_ID, workerId },
    });

    const report = await call(bindings, `/v1/worker/runs/${runId}/events`, {
      method: "POST", token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        eventId: EVENT_ID,
        workerId,
        type: "artifacts.uploaded",
        timestamp: new Date().toISOString(),
        payload: { status: "partial", uploadedCount: 2, failedCount: 1, skippedCount: 0 },
      },
    });
    expect(report.response.status).toBe(202);

    const events = await call(bindings, `/v1/runs/${runId}/events?limit=20`, { token: CLIENT_TOKEN });
    expect(events.body.data.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "artifacts.uploaded",
        payload: { status: "partial", uploadedCount: 2, failedCount: 1, skippedCount: 0 },
      }),
    ]));
  });

  it("[WORKER-COMPLETE-01] records completion and rejects a late started callback", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-complete";
    await claimRun(bindings, runId, workerId);
    const now = new Date().toISOString();
    const startedBody = {
      contractVersion: "1",
      callbackId: CALLBACK_ID,
      workerId,
      startedAt: now,
      stage: "prepare",
    };
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN, body: startedBody,
    });
    const completedBody = {
      contractVersion: "1",
      callbackId: "00000000-0000-4000-8000-000000000014",
      workerId,
      completedAt: now,
      exitCode: 0,
      summary: "Updated documentation.",
    };
    const completed = await call(bindings, `/v1/worker/runs/${runId}/completed`, {
      method: "POST", token: WORKER_TOKEN, body: completedBody,
    });
    const completedReplay = await call(bindings, `/v1/worker/runs/${runId}/completed`, {
      method: "POST", token: WORKER_TOKEN, body: completedBody,
    });
    expect(completed.response.status).toBe(200);
    expect(completed.body.data.status).toBe("completed");
    expect(completed.body.data.result.summary).toBe("Updated documentation.");
    expect(completedReplay.body.data.status).toBe("completed");

    const lateStart = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN, body: { ...startedBody, callbackId: "00000000-0000-4000-8000-000000000015" },
    });
    expect(lateStart.response.status).toBe(409);
  });

  it("[CANCEL-QUEUED-01] records queued cancellation and rejects a late start", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const cancelled = await call(bindings, `/v1/runs/${runId}/cancel`, { method: "POST", token: CLIENT_TOKEN });
    const replay = await call(bindings, `/v1/runs/${runId}/cancel`, { method: "POST", token: CLIENT_TOKEN });
    expect(cancelled.response.status).toBe(202);
    expect(cancelled.body.data.status).toBe("cancelled");
    expect(replay.response.status).toBe(200);

    const lateStart = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: CALLBACK_ID, workerId: "docker-host-a" },
    });
    expect(lateStart.response.status).toBe(409);
    expect(lateStart.body.error.code).toBe("RUN_CANCELLED");
  });

  it("[CANCEL-RUNNING-01/WORKER-CANCEL-01] keeps cancellation pending until the worker confirms it", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-b";
    await claimRun(bindings, runId, workerId, "00000000-0000-4000-8000-000000000032");
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: CALLBACK_ID, workerId },
    });

    const request = await call(bindings, `/v1/runs/${runId}/cancel`, { method: "POST", token: CLIENT_TOKEN });
    expect(request.body.data.status).toBe("cancel_requested");

    const confirmed = await call(bindings, `/v1/worker/runs/${runId}/cancelled`, {
      method: "POST", token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000016",
        workerId,
        reason: "Cancellation observed by the execution host",
      },
    });
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body.data.status).toBe("cancelled");
  });

  it("[ARTIFACTS-01] lets an owned running worker upload an artifact for authenticated client download", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "docker-host-artifacts";
    const claimCallbackId = "00000000-0000-4000-8000-000000000041";
    const runId = await startRunningRun(
      bindings,
      workerId,
      claimCallbackId,
      "00000000-0000-4000-8000-000000000042",
    );
    const artifactId = "00000000-0000-4000-8000-000000000043";
    const artifactName = 'summary"; filename="résumé.txt';
    const upload = await uploadArtifact(bindings, runId, {
      artifactId,
      artifactName,
      body: "run summary\n",
      workerId,
      claimCallbackId,
    });

    expect(upload.response.status).toBe(201);
    expect((upload.body as any).data).toMatchObject({ id: artifactId, name: artifactName, kind: "report", size: 12 });
    expect(r2.put).toHaveBeenCalledWith(
      `runs/${runId}/${artifactId}`,
      expect.any(ReadableStream),
      expect.objectContaining({ customMetadata: expect.objectContaining({ runId, artifactId }) }),
    );

    const unauthorized = await callBinary(bindings, `/v1/runs/${runId}/artifacts/${artifactId}`);
    expect(unauthorized.response.status).toBe(401);
    const list = await call(bindings, `/v1/runs/${runId}/artifacts`, { token: CLIENT_TOKEN });
    expect(list.response.status).toBe(200);
    expect(list.body.data.artifacts).toEqual([expect.objectContaining({ id: artifactId, name: artifactName })]);
    const download = await callBinary(bindings, `/v1/runs/${runId}/artifacts/${artifactId}`, { token: CLIENT_TOKEN });
    expect(download.response.status).toBe(200);
    expect(download.response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"summary___filename__r_sum_.txt\"; filename*=UTF-8''summary%22%3B%20filename%3D%22r%C3%A9sum%C3%A9.txt",
    );
    expect(download.body).toBe("run summary\n");
  });

  it("[ARTIFACTS-IDEMPOTENCY-01] accepts an exact artifact retry and rejects different bytes under the same ID", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "docker-host-artifact-replay";
    const claimCallbackId = "00000000-0000-4000-8000-000000000044";
    const runId = await startRunningRun(
      bindings,
      workerId,
      claimCallbackId,
      "00000000-0000-4000-8000-000000000045",
    );
    const upload = {
      artifactId: "00000000-0000-4000-8000-000000000046",
      artifactName: "summary.txt",
      body: "run summary\n",
      workerId,
      claimCallbackId,
    };

    expect((await uploadArtifact(bindings, runId, upload)).response.status).toBe(201);
    const retry = await uploadArtifact(bindings, runId, upload);
    const conflict = await uploadArtifact(bindings, runId, { ...upload, body: "run summary!" });

    expect(retry.response.status).toBe(200);
    expect(conflict.response.status).toBe(409);
    expect((conflict.body as any).error.code).toBe("ARTIFACT_ID_CONFLICT");
    expect(r2.objects.size).toBe(1);
  });

  it("[ARTIFACTS-09] rejects an unsupported artifact kind before reading run state", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const result = await callBinary(bindings, "/v1/worker/runs/00000000-0000-4000-8000-000000000051/artifacts/00000000-0000-4000-8000-000000000052", {
      method: "PUT",
      token: WORKER_TOKEN,
      headers: { "content-length": "1", "x-artifact-kind": "image/png" },
      body: "x",
    });

    expect(result.response.status).toBe(400);
    expect((result.body as any).error.code).toBe("ARTIFACT_KIND_INVALID");
  });

  it("[ARTIFACTS-02] rejects artifact uploads after a run has completed", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-artifacts-terminal";
    await claimRun(bindings, runId, workerId, "00000000-0000-4000-8000-000000000044");
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000045", workerId },
    });
    await call(bindings, `/v1/worker/runs/${runId}/completed`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000046", workerId, exitCode: 0 },
    });

    const upload = await callBinary(bindings, `/v1/worker/runs/${runId}/artifacts/00000000-0000-4000-8000-000000000047`, {
      method: "PUT", token: WORKER_TOKEN,
      headers: { "content-type": "text/plain", "content-length": "4", "x-artifact-name": "late.txt" },
      body: "late",
    });
    expect(upload.response.status).toBe(409);
    expect(r2.put).not.toHaveBeenCalled();
  });

  it("[ARTIFACTS-10] rechecks ownership when a run completes during artifact reservation", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-artifact-race";
    const claimId = "00000000-0000-4000-8000-000000000061";
    await claimRun(bindings, runId, workerId, claimId);
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000062", workerId },
    });

    const racingDatabase = {
      prepare(query: string) {
        const statement = bindings.DB.prepare(query);
        if (!query.includes("INSERT INTO run_artifacts")) return statement;
        return {
          bind: (...values: any[]) => {
            const bound = statement.bind(...values);
            return {
              run: async () => {
                const completed = await call(bindings, `/v1/worker/runs/${runId}/completed`, {
                  method: "POST", token: WORKER_TOKEN,
                  body: {
                    contractVersion: "1",
                    callbackId: "00000000-0000-4000-8000-000000000063",
                    workerId,
                    completedAt: new Date().toISOString(),
                    exitCode: 0,
                  },
                });
                expect(completed.response.status).toBe(200);
                return bound.run();
              },
            };
          },
        } as unknown as ReturnType<Env["DB"]["prepare"]>;
      },
    } as unknown as Env["DB"];
    const racingBindings = { ...bindings, DB: racingDatabase };
    const upload = await callBinary(racingBindings, `/v1/worker/runs/${runId}/artifacts/00000000-0000-4000-8000-000000000064`, {
      method: "PUT",
      token: WORKER_TOKEN,
      headers: {
        "content-length": "1",
        "x-artifact-kind": "report",
        "x-soyuz-worker-id": workerId,
        "x-soyuz-claim-callback-id": claimId,
      },
      body: "x",
    });

    expect(upload.response.status).toBe(409);
    expect((upload.body as any).error.code).toBe("RUN_NOT_ACTIVE");
    expect(r2.put).not.toHaveBeenCalled();
  });

  it("[ARTIFACTS-03] rejects a body whose actual byte size differs from Content-Length", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-artifact-size";
    await claimRun(bindings, runId, workerId, "00000000-0000-4000-8000-000000000048");
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000049", workerId },
    });

    const upload = await callBinary(bindings, `/v1/worker/runs/${runId}/artifacts/00000000-0000-4000-8000-000000000050`, {
      method: "PUT", token: WORKER_TOKEN,
      headers: {
        "content-type": "text/plain", "content-length": "4", "x-artifact-name": "size.txt",
        "x-soyuz-worker-id": workerId, "x-soyuz-claim-callback-id": "00000000-0000-4000-8000-000000000048",
      },
      body: "five!",
    });
    expect(upload.response.status).toBe(400);
    expect((upload.body as any).error.code).toBe("ARTIFACT_SIZE_MISMATCH");
    expect(r2.objects.size).toBe(0);
  });

  it("[ARTIFACTS-07] rejects artifacts from another worker or stale claim", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-owned-artifacts";
    const claimCallbackId = "00000000-0000-4000-8000-000000000061";
    await claimRun(bindings, runId, workerId, claimCallbackId);
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000062", workerId },
    });
    const path = `/v1/worker/runs/${runId}/artifacts/00000000-0000-4000-8000-000000000063`;
    const headers = {
      "content-type": "text/plain",
      "content-length": "4",
      "x-artifact-name": "owned.txt",
      "x-soyuz-worker-id": workerId,
      "x-soyuz-claim-callback-id": claimCallbackId,
    };

    const wrongWorker = await callBinary(bindings, path, {
      method: "PUT", token: WORKER_TOKEN,
      headers: { ...headers, "x-soyuz-worker-id": "different-worker" },
      body: "data",
    });
    const staleClaim = await callBinary(bindings, path, {
      method: "PUT", token: WORKER_TOKEN,
      headers: { ...headers, "x-soyuz-claim-callback-id": "00000000-0000-4000-8000-000000000064" },
      body: "data",
    });

    expect(wrongWorker.response.status).toBe(409);
    expect((wrongWorker.body as any).error.code).toBe("WORKER_MISMATCH");
    expect(staleClaim.response.status).toBe(409);
    expect((staleClaim.body as any).error.code).toBe("STALE_CLAIM");
    expect(r2.objects.size).toBe(0);
  });

  it("[ARTIFACTS-08] keeps failed R2 cleanup indexed for the retention sweep", async () => {
    const r2 = memoryArtifactBucket();
    r2.put.mockImplementationOnce(async (key, body, options) => {
      const bytes = body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : new Uint8Array(await new Response(body).arrayBuffer());
      r2.objects.set(key, { body: bytes, options });
      throw new Error("simulated R2 write acknowledgement failure");
    });
    r2.delete.mockImplementationOnce(async () => { throw new Error("simulated R2 cleanup failure"); });
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-artifact-cleanup";
    const claimCallbackId = "00000000-0000-4000-8000-000000000071";
    await claimRun(bindings, runId, workerId, claimCallbackId);
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000072", workerId },
    });
    const artifactId = "00000000-0000-4000-8000-000000000073";
    const objectKey = `runs/${runId}/${artifactId}`;
    const upload = await callBinary(bindings, `/v1/worker/runs/${runId}/artifacts/${artifactId}`, {
      method: "PUT", token: WORKER_TOKEN,
      headers: {
        "content-type": "text/plain", "content-length": "4", "x-artifact-name": "failure.txt",
        "x-soyuz-worker-id": workerId, "x-soyuz-claim-callback-id": claimCallbackId,
      },
      body: "data",
    });
    const pending = await bindings.DB.prepare("SELECT state FROM run_artifacts WHERE id = ?").bind(artifactId).first<{ state: string }>();

    expect(upload.response.status).toBe(503);
    expect(pending?.state).toBe("pending");
    expect(r2.objects.has(objectKey)).toBe(true);

    await purgeExpiredArtifacts(bindings, new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000));

    expect(r2.objects.has(objectKey)).toBe(false);
    const removed = await bindings.DB.prepare("SELECT id FROM run_artifacts WHERE id = ?").bind(artifactId).first();
    expect(removed).toBeNull();
  });

  it("[ARTIFACTS-06] applies the per-run cap atomically across pending uploads", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-artifact-cap";
    await claimRun(bindings, runId, workerId, "00000000-0000-4000-8000-000000000053");
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000054", workerId },
    });
    const now = new Date().toISOString();
    const pendingRows = Array.from({ length: 100 }, (_, index) => {
      const artifactId = `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
      return bindings.DB.prepare(`
        INSERT INTO run_artifacts (id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state)
        VALUES (?, ?, 'other', 'pending.txt', 'text/plain', 1, ?, ?, '2099-01-01T00:00:00.000Z', 'pending')
      `).bind(artifactId, runId, `runs/${runId}/${artifactId}`, now);
    });
    await bindings.DB.batch(pendingRows);

    const upload = await callBinary(bindings, `/v1/worker/runs/${runId}/artifacts/00000000-0000-4000-8000-000000000200`, {
      method: "PUT", token: WORKER_TOKEN,
      headers: {
        "content-type": "text/plain", "content-length": "4", "x-artifact-name": "capped.txt",
        "x-soyuz-worker-id": workerId, "x-soyuz-claim-callback-id": "00000000-0000-4000-8000-000000000053",
      },
      body: "data",
    });
    expect(upload.response.status).toBe(413);
    expect((upload.body as any).error.code).toBe("ARTIFACT_LIMIT_REACHED");
    expect(r2.put).not.toHaveBeenCalled();
  });

  it("[ARTIFACTS-04] removes expired artifact metadata and R2 content", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const artifactId = "00000000-0000-4000-8000-000000000051";
    const objectKey = `runs/${runId}/${artifactId}`;
    r2.objects.set(objectKey, {
      body: new TextEncoder().encode("expired"),
      options: { httpMetadata: { contentType: "text/plain" }, customMetadata: {} },
    });
    await bindings.DB.prepare(`
      INSERT INTO run_artifacts (id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state)
      VALUES (?, ?, 'report', 'old.txt', 'text/plain', 7, ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'ready')
    `).bind(artifactId, runId, objectKey).run();

    await purgeExpiredArtifacts(bindings, new Date("2026-01-03T00:00:00.000Z"));

    expect(r2.objects.has(objectKey)).toBe(false);
    const row = await bindings.DB.prepare("SELECT id FROM run_artifacts WHERE id = ?").bind(artifactId).first();
    expect(row).toBeNull();
  });

  it("[ARTIFACTS-05] keeps expired metadata for retry when R2 deletion fails", async () => {
    const r2 = memoryArtifactBucket();
    r2.delete.mockImplementationOnce(async () => { throw new Error("temporary R2 failure"); });
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const artifactId = "00000000-0000-4000-8000-000000000052";
    const objectKey = `runs/${runId}/${artifactId}`;
    await bindings.DB.prepare(`
      INSERT INTO run_artifacts (id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state)
      VALUES (?, ?, 'report', 'old.txt', 'text/plain', 7, ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'ready')
    `).bind(artifactId, runId, objectKey).run();

    await expect(purgeExpiredArtifacts(bindings, new Date("2026-01-03T00:00:00.000Z"))).resolves.toBeUndefined();

    const row = await bindings.DB.prepare("SELECT id FROM run_artifacts WHERE id = ?").bind(artifactId).first();
    expect(row).not.toBeNull();
  });

  it("[WORKER-FAIL-01] records worker failure and accepts an exact callback retry", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-failure";
    await claimRun(bindings, runId, workerId, "00000000-0000-4000-8000-000000000035");
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000036", workerId },
    });

    const failureBody = {
      contractVersion: "1",
      callbackId: "00000000-0000-4000-8000-000000000037",
      workerId,
      exitCode: 1,
      failureClass: "validation_failed",
      failureMessage: "The validation command returned a non-zero exit code.",
    };
    const failure = await call(bindings, `/v1/worker/runs/${runId}/failed`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: failureBody,
    });
    const retry = await call(bindings, `/v1/worker/runs/${runId}/failed`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: failureBody,
    });
    const stored = await getRun(bindings.DB, runId);
    expect(failure.response.status).toBe(200);
    expect(failure.body.data.status).toBe("failed");
    expect(failure.body.data.failureClass).toBe("validation_failed");
    expect(retry.body.data.status).toBe("failed");
    expect(stored).toMatchObject({
      status: "failed",
      exit_code: 1,
      failure_class: "validation_failed",
      failure_message: failureBody.failureMessage,
    });
    expect(await countRunEvents(bindings, runId, "run.failed")).toBe(1);
  });

  it("[CANCEL-CAS-01] rejects a claimed-state cancellation after the run advances to running", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-c";
    await claimRun(bindings, runId, workerId, "00000000-0000-4000-8000-000000000033");
    await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000034", workerId },
    });

    // Simulate a cancellation update prepared from a stale `claimed` read after start won the race.
    const now = new Date().toISOString();
    await expect(transitionRun(bindings.DB, runId, "cancelled", {
      cancel_requested_at: now,
      completed_at: now,
      claim_expires_at: null,
    }, {
      eventId: "system:cancel:cancelled",
      type: "run.cancelled",
      occurredAt: now,
      recordedAt: now,
      payload: { requestedBy: "client" },
    }, { expectedStatus: "claimed" })).rejects.toBeInstanceOf(RunTransitionError);
  });

  it("[RUN-READ-REST-01] lists runs, returns canonical state, and reports unknown IDs", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const listed = await call(bindings, "/v1/runs?limit=10&status=queued", { token: CLIENT_TOKEN });
    expect(listed.response.status).toBe(200);
    expect(listed.body.data.runs).toHaveLength(1);
    expect(listed.body.data.runs[0].id).toBe(runId);

    const read = await call(bindings, `/v1/runs/${runId}`, { token: CLIENT_TOKEN });
    expect(read.body.data.status).toBe("queued");
    const missing = await call(bindings, "/v1/runs/00000000-0000-4000-8000-000000000099", { token: CLIENT_TOKEN });
    expect(missing.response.status).toBe(404);
    expect(missing.body.error.code).toBe("RUN_NOT_FOUND");
  });

  it("[QUEUE-RECONCILE-01] reconciles a stale admitting run with the same run ID", async () => {
    const { bindings, sent } = testEnv();
    const now = new Date();
    const old = new Date(now.getTime() - 3 * 60_000).toISOString();
    const id = "00000000-0000-4000-8000-000000000020";
    const request = {
      repoUrl: "https://github.com/example/project",
      ref: "main",
      taskPrompt: "Reconcile an admission that did not reach its final D1 state.",
      taskMode: "patch" as const,
      publishMode: "pr" as const,
    };
    await insertRun(bindings.DB, {
      id,
      request,
      requestHash: "test-fingerprint",
      idempotencyKey: null,
      correlationId: "00000000-0000-4000-8000-000000000021",
      requestId: "00000000-0000-4000-8000-000000000022",
      createdAt: old,
    });

    await reconcileAdmissions(bindings, now);
    const stored = await getRun(bindings.DB, id);
    expect(sent).toHaveLength(1);
    expect(sent[0].runId).toBe(id);
    expect(stored?.status).toBe("queued");
    expect(stored?.admission_attempts).toBe(2);
  });

  it("[QUEUE-RETENTION-01] republishes a stale queued run without changing its admission time and backs off", async () => {
    const { bindings, sent } = testEnv();
    const now = new Date();
    const old = new Date(now.getTime() - 13 * 60 * 60_000).toISOString();
    const id = "00000000-0000-4000-8000-000000000060";
    const request = {
      repoUrl: "https://github.com/example/project",
      ref: "main",
      taskPrompt: "Inspect the project setup and summarize its first steps.",
      taskMode: "inspect" as const,
      publishMode: "none" as const,
    };
    await insertRun(bindings.DB, {
      id,
      request,
      requestHash: "test-fingerprint-queue-retention",
      idempotencyKey: null,
      correlationId: "00000000-0000-4000-8000-000000000061",
      requestId: "00000000-0000-4000-8000-000000000062",
      createdAt: old,
    });
    await transitionRun(bindings.DB, id, "queued", { queued_at: old }, {
      eventId: "system:admission:queued",
      type: "run.queued",
      occurredAt: old,
      recordedAt: old,
      payload: { queue: "soyuz-runs" },
    });

    await Promise.all([
      reconcileAdmissions(bindings, now),
      reconcileAdmissions(bindings, now),
    ]);
    let stored = await getRun(bindings.DB, id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ runId: id, request });
    expect(stored?.status).toBe("queued");
    expect(stored?.queued_at).toBe(old);
    expect(stored?.updated_at).toBe(now.toISOString());
    expect(await countRunEvents(bindings, id, "run.queue_recovery_attempted")).toBe(1);

    await reconcileAdmissions(bindings, new Date(now.getTime() + 60_000));
    expect(sent).toHaveLength(1);

    await reconcileAdmissions(bindings, new Date(now.getTime() + 13 * 60 * 60_000));
    stored = await getRun(bindings.DB, id);
    expect(sent).toHaveLength(2);
    expect(sent[1].runId).toBe(id);
    expect(stored?.queued_at).toBe(old);
    expect(await countRunEvents(bindings, id, "run.queue_recovery_attempted")).toBe(2);
  });

  it("[WORKER-CLAIM-RECOVERY-01] expires an abandoned claim and republishes the same run ID", async () => {
    const { bindings, sent } = testEnv();
    const now = new Date();
    const old = new Date(now.getTime() - 5 * 60_000).toISOString();
    const id = "00000000-0000-4000-8000-000000000040";
    const request = {
      repoUrl: "https://github.com/example/project",
      ref: "main",
      taskPrompt: "Return an abandoned worker claim to queue admission.",
      taskMode: "patch" as const,
      publishMode: "pr" as const,
    };
    await insertRun(bindings.DB, {
      id,
      request,
      requestHash: "test-fingerprint-claim",
      idempotencyKey: null,
      correlationId: "00000000-0000-4000-8000-000000000041",
      requestId: "00000000-0000-4000-8000-000000000042",
      createdAt: old,
    });
    await transitionRun(bindings.DB, id, "queued", { queued_at: old }, {
      eventId: "system:admission:queued",
      type: "run.queued",
      occurredAt: old,
      recordedAt: old,
      payload: { queue: "soyuz-runs" },
    });
    await transitionRun(bindings.DB, id, "claimed", {
      worker_id: "docker-host-lost",
      claim_expires_at: old,
    }, {
      eventId: "00000000-0000-4000-8000-000000000043",
      type: "run.claimed",
      workerId: "docker-host-lost",
      occurredAt: old,
      recordedAt: old,
      payload: { leaseSeconds: 120 },
    });

    await reconcileAdmissions(bindings, now);
    const stored = await getRun(bindings.DB, id);
    expect(sent).toHaveLength(1);
    expect(sent[0].runId).toBe(id);
    expect(stored?.status).toBe("queued");
    expect(stored?.worker_id).toBeNull();
    expect(stored?.claim_expires_at).toBeNull();
  });

  it("[LIFECYCLE-RACE-01] commits only one terminal event when worker outcomes race", async () => {
    const { bindings } = testEnv();
    const now = new Date().toISOString();
    const id = "00000000-0000-4000-8000-000000000050";
    const request = {
      repoUrl: "https://github.com/example/project",
      ref: "main",
      taskPrompt: "Exercise concurrent terminal callbacks against canonical run state.",
      taskMode: "patch" as const,
      publishMode: "pr" as const,
    };
    await insertRun(bindings.DB, {
      id,
      request,
      requestHash: "race-fingerprint",
      idempotencyKey: null,
      correlationId: "00000000-0000-4000-8000-000000000051",
      requestId: "00000000-0000-4000-8000-000000000052",
      createdAt: now,
    });
    await transitionRun(bindings.DB, id, "queued", { queued_at: now }, {
      eventId: "system:admission:queued",
      type: "run.queued",
      occurredAt: now,
      recordedAt: now,
      payload: {},
    });
    await transitionRun(bindings.DB, id, "claimed", {
      worker_id: "docker-host-race",
      claim_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }, {
      eventId: "00000000-0000-4000-8000-000000000053",
      type: "run.claimed",
      workerId: "docker-host-race",
      occurredAt: now,
      recordedAt: now,
      payload: { leaseSeconds: 60 },
    });
    await transitionRun(bindings.DB, id, "running", { started_at: now, claim_expires_at: null }, {
      eventId: "00000000-0000-4000-8000-000000000054",
      type: "run.started",
      workerId: "docker-host-race",
      occurredAt: now,
      recordedAt: now,
      payload: {},
    });

    const outcomes = await Promise.allSettled([
      transitionRun(bindings.DB, id, "completed", { completed_at: now, exit_code: 0 }, {
        eventId: "00000000-0000-4000-8000-000000000055",
        type: "run.completed",
        workerId: "docker-host-race",
        occurredAt: now,
        recordedAt: now,
        payload: {},
      }),
      transitionRun(bindings.DB, id, "failed", {
        completed_at: now,
        failure_class: "validation_failed",
        failure_message: "The competing terminal outcome lost the transition.",
      }, {
        eventId: "00000000-0000-4000-8000-000000000056",
        type: "run.failed",
        workerId: "docker-host-race",
        occurredAt: now,
        recordedAt: now,
        payload: { failureClass: "validation_failed" },
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const current = await getRun(bindings.DB, id);
    expect(["completed", "failed"]).toContain(current?.status);
    const terminalEvents = await bindings.DB.prepare(
      "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type IN ('run.completed', 'run.failed')",
    ).bind(id).first<{ count: number }>();
    expect(terminalEvents?.count).toBe(1);
  });

  it("[RUN-LIVENESS-01] marks stale running liveness as suspect without changing run state or requeueing", async () => {
    const { bindings, sent } = testEnv();
    const submitted = await submit(bindings, {}, "00000000-0000-4000-8000-000000000060");
    const runId = submitted.body.data.id as string;
    await claimRun(bindings, runId, "docker-host-liveness");
    const startedAt = new Date().toISOString();
    const started = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000061",
        workerId: "docker-host-liveness",
        startedAt,
      },
    });
    expect(started.response.status).toBe(200);

    await reconcileStalledRuns(bindings, new Date(Date.now() + 6 * 60_000));
    await reconcileStalledRuns(bindings, new Date(Date.now() + 7 * 60_000));
    const suspect = await getRun(bindings.DB, runId);
    expect(suspect?.status).toBe("running");
    expect(suspect?.operational_health).toBe("suspect_stalled");
    expect(sent).toHaveLength(1);
    const stalledEvent = await bindings.DB.prepare(
      "SELECT type FROM run_events WHERE run_id = ? AND type = 'run.suspected_stalled'",
    ).bind(runId).first<{ type: string }>();
    expect(stalledEvent?.type).toBe("run.suspected_stalled");
    expect(await countRunEvents(bindings, runId, "run.suspected_stalled")).toBe(1);

    const heartbeat = await call(bindings, `/v1/worker/runs/${runId}/events`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        eventId: "00000000-0000-4000-8000-000000000062",
        workerId: "docker-host-liveness",
        type: "worker.heartbeat",
        timestamp: new Date().toISOString(),
        payload: { hostHealthy: true, executionActive: true },
      },
    });
    expect(heartbeat.response.status).toBe(202);
    const recovered = await getRun(bindings.DB, runId);
    expect(recovered?.status).toBe("running");
    expect(recovered?.operational_health).toBe("healthy");
    expect(recovered?.last_heartbeat_at).toBeTruthy();
  });

  it("[WORKER-PRESTART-FAIL-01] records a live claimed worker failure without starting execution", async () => {
    const { bindings } = testEnv();
    const submitted = await submit(bindings, {}, "00000000-0000-4000-8000-000000000063");
    const runId = submitted.body.data.id as string;
    await claimRun(bindings, runId, "docker-host-admission");

    const failed = await call(bindings, `/v1/worker/runs/${runId}/failed`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000064",
        workerId: "docker-host-admission",
        failureClass: "kaseki_admission_rejected",
        failureMessage: "Local admission rejected the run.",
      },
    });
    const stored = await getRun(bindings.DB, runId);
    expect(failed.response.status).toBe(200);
    expect(stored).toMatchObject({
      status: "failed",
      started_at: null,
      failure_class: "kaseki_admission_rejected",
      failure_message: "Local admission rejected the run.",
    });
    expect(await countRunEvents(bindings, runId, "run.failed")).toBe(1);
  });
});

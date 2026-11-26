import { beforeEach, expect, it, vi } from "vitest";
import * as support from "../support/api-test-helpers";
import type { Env, PublicationRow } from "../support/api-test-helpers";
const {
  runtimeEnv,
  handleRequest,
  getRun,
  RunTransitionError,
  transitionRun,
  reconcileAdmissions,
  reconcileStalledRuns,
  purgeOldRuns,
  canonicalJson,
  digestHex,
  dispatchPublication,
  PUBLICATION_DISPATCH_BATCH_SIZE,
  PUBLICATION_LEASE_MS,
  reconcilePublications,
  MockPublisherEntrypoint,
  getOAuthApi,
  oauthProviderOptions,
  handleDashboardApiRequest,
  CLIENT_TOKEN,
  KASEKI_TOKEN,
  WORKER_TOKEN,
  CLIENT_KEY,
  CALLBACK_ID,
  EVENT_ID,
  SENKU_TOKEN,
  testEnv,
  senkuAnswers,
  mockSenku,
  createOAuthAccessToken,
  createOAuthCredentials,
  apiRequest,
  cookieHeader,
  beginOAuthConsent,
  approveOAuthConsent,
  call,
  callBinary,
  validRequest,
  clearDatabase,
  countRunEvents,
  memoryArtifactBucket,
  submit,
  insertOutcomeRunFixture,
  claimRun,
  startRunningRun,
  uploadArtifact,
  publicationManifest,
  registerPublicationInputs,
  completeExecution,
  withSupersededClaimOnNextBatch,
} = support;

beforeEach(clearDatabase);
  it("[RATE-LIMIT-FAIL-CLOSED-01] blocks quota-protected routes when Cloudflare rate limiting is unavailable", async () => {
    const registration = testEnv({ oauth: true });
    registration.oauthRegistrationLimiter.limit.mockRejectedValue(new Error("simulated limiter failure"));
    const registrationResponse = await call(registration.bindings, "/oauth/register", {
      method: "POST",
      body: { client_name: "Rate limit test" },
    });
    expect(registrationResponse.response.status).toBe(503);
    expect(registrationResponse.body.error.code).toBe("RATE_LIMITER_UNAVAILABLE");

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

  it("[RETENTION-REQUEST-01] does not redact a live request before its run retention deadline", async () => {
    const { bindings } = testEnv();
    const recent = await submit(bindings, { taskPrompt: "Prompt remains available through the bounded run lifetime" });
    const runId = recent.body.data.id as string;
    await purgeOldRuns(bindings, new Date(Date.now() + 89 * 24 * 60 * 60 * 1_000));

    const row = await bindings.DB.prepare("SELECT request_json, request_redacted_at FROM runs WHERE id = ?")
      .bind(runId).first<{ request_json: string; request_redacted_at: string | null }>();
    expect(JSON.parse(row!.request_json).taskPrompt).toBe("Prompt remains available through the bounded run lifetime");
    expect(row!.request_redacted_at).toBeNull();
  });

  it("[RETENTION-90D-01] deletes expired run history by its canonical creation deadline", async () => {
    const { bindings } = testEnv();
    const oldestId = "019b3000-0000-7000-8000-000000000001";
    const createdAt = new Date(Date.now() - 89 * 24 * 60 * 60 * 1_000).toISOString();
    const expiredRequest = { ...validRequest(), ref: "main", taskMode: "patch", publishMode: "none" };
    await bindings.DB.prepare(`INSERT INTO runs (
      id, contract_version, repo_url, git_ref, status, task_mode, publish_mode, request_json, request_hash,
      created_at, updated_at, expires_at, correlation_id, request_id
    ) VALUES (?, '1', ?, 'main', 'completed', 'patch', 'none', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(oldestId, expiredRequest.repoUrl, JSON.stringify(expiredRequest), "a".repeat(64), createdAt, createdAt,
        new Date(Date.parse(createdAt) + 90 * 24 * 60 * 60 * 1_000).toISOString(),
        "019b3000-0000-7000-8000-000000000002", "019b3000-0000-7000-8000-000000000003").run();
    const deadline = new Date(Date.parse(createdAt) + 90 * 24 * 60 * 60 * 1_000);

    await purgeOldRuns(bindings, deadline);

    const expired = await bindings.DB.prepare("SELECT id FROM runs WHERE id = ?").bind(oldestId).first();
    expect(expired).toBeNull();
  });

  it("[RETENTION-90D-02] permits bounded pagination beyond the default 30-run page", async () => {
    const { bindings } = testEnv();
    for (let index = 0; index < 31; index += 1) {
      const key = `00000000-0000-4000-8000-${String(index + 2000).padStart(12, "0")}`;
      await submit(bindings, {}, key);
    }

    const page = await call(bindings, "/v1/runs?limit=100", { token: CLIENT_TOKEN });
    expect(page.response.status).toBe(200);
    expect(page.body.data.runs).toHaveLength(31);
    expect(page.body.data.nextCursor).toBeNull();
  });

  it("[RUN-OUTCOMES-ALL-RETAINED-01] aggregates outcomes across every unexpired run beyond the newest 30", async () => {
    const { bindings } = testEnv();
    for (let index = 0; index < 120; index += 1) {
      const key = `00000000-0000-4000-8000-${String(index + 3000).padStart(12, "0")}`;
      await submit(bindings, {}, key);
    }
    const olderOutcomeRunId = "00000000-0000-4000-8000-000000000121";
    await insertOutcomeRunFixture(bindings, olderOutcomeRunId, new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString(), {
        schemaVersion: 1,
        evaluation: { assessment: "good", reviewerConfidence: "high", improvementCategories: [] },
    });

    const outcomes = await call(bindings, "/v1/run-outcomes", { token: CLIENT_TOKEN });

    expect(outcomes.response.status).toBe(200);
    expect(outcomes.body.data.scope).toMatchObject({
      retainedRuns: 121,
      includedRuns: 121,
      runsWithOutcomeSummary: 1,
      returnedRuns: 100,
      runsTruncated: true,
    });
    expect(outcomes.body.data.byAssessment).toEqual({ good: 1 });
    expect(outcomes.body.data.runs).toHaveLength(100);
    expect(outcomes.body.data.runs.some((run: { id: string }) => run.id === olderOutcomeRunId)).toBe(false);
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

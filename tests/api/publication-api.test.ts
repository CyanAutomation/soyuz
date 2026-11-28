import { beforeEach, expect, it, vi } from "vitest";
import * as support from "../support/api-test-helpers";
import type { Env, PublicationRow } from "../support/api-test-helpers";
const {
  runtimeEnv,
  handleRequest,
  insertRun,
  getRun,
  RunTransitionError,
  transitionRun,
  reconcileAdmissions,
  reconcileStalledRuns,
  purgeExpiredArtifacts,
  purgeExpiredPublicationManifests,
  purgeExpiredRunRequests,
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
  KIRISAME_API_TEST_KEY,
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
  claimRun,
  startRunningRun,
  uploadArtifact,
  publicationManifest,
  registerPublicationInputs,
  completeExecution,
  withSupersededClaimOnNextBatch,
} = support;

beforeEach(clearDatabase);
  it("rejects unframed and malformed publication manifest uploads before indexing them", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "manifest-framing-host";
    const claimCallbackId = "018f0000-0000-7000-8000-00000000003a";
    const runId = await startRunningRun(bindings, workerId, claimCallbackId, crypto.randomUUID());
    const path = `/v1/worker/runs/${runId}/publication-manifests/018f0000-0000-7000-8000-00000000003b`;
    const workerHeaders = {
      "x-soyuz-worker-id": workerId,
      "x-soyuz-claim-callback-id": claimCallbackId,
      "content-type": "application/json",
    };

    const unframed = await callBinary(bindings, path, {
      method: "PUT",
      token: WORKER_TOKEN,
      headers: workerHeaders,
      body: "{}",
    });
    expect(unframed.response.status).toBe(411);
    expect((unframed.body as any).error.code).toBe("CONTENT_LENGTH_REQUIRED");

    const malformed = "{not-json";
    const invalidJson = await callBinary(bindings, path, {
      method: "PUT",
      token: WORKER_TOKEN,
      headers: { ...workerHeaders, "content-length": String(new TextEncoder().encode(malformed).byteLength) },
      body: malformed,
    });
    expect(invalidJson.response.status).toBe(400);
    expect((invalidJson.body as any).error.code).toBe("MANIFEST_INVALID");
  });

  it("[PUBLICATION-INTENT-01] requires authenticated host validation evidence and replays one immutable intent", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "trusted-publication-host";
    const claimCallbackId = "018f0000-0000-7000-8000-000000000041";
    const withoutEvidence = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000042", withEvidence: false,
    });
    expect(withoutEvidence.uploaded.response.status).toBe(201);
    const evidencePayload = {
      contractVersion: "1",
      eventId: crypto.randomUUID(),
      workerId,
      type: "validation.completed",
      payload: {
        publicationEvidence: {
          evidenceVersion: "1", outcome: "passed", artifactId: "018f0000-0000-7000-8000-000000000042",
          artifactDigest: withoutEvidence.digest, runId: withoutEvidence.runId,
          repository: { owner: "example", name: "project" }, baseRef: "main", baseSha: "a".repeat(40),
        },
      },
    };
    const clientCredentialEvidence = await call(bindings, `/v1/worker/runs/${withoutEvidence.runId}/events`, {
      method: "POST", token: CLIENT_TOKEN, body: { ...evidencePayload, claimCallbackId },
    });
    const unfencedHostEvidence = await call(bindings, `/v1/worker/runs/${withoutEvidence.runId}/events`, {
      method: "POST", token: WORKER_TOKEN, body: evidencePayload,
    });
    expect(clientCredentialEvidence.response.status).toBe(401);
    expect(unfencedHostEvidence.response.status).toBe(422);
    expect(withoutEvidence.intent.response.status).toBe(409);
    expect(withoutEvidence.intent.body.error.code).toBe("VALIDATION_EVIDENCE_REQUIRED");

    const ready = await registerPublicationInputs(bindings, {
      workerId: "trusted-publication-host-b",
      claimCallbackId: "018f0000-0000-7000-8000-000000000043",
      artifactId: "018f0000-0000-7000-8000-000000000044",
    });
    expect(ready.uploaded.response.status).toBe(201);
    expect(ready.intent.response.status).toBe(201);
    const replay = await call(bindings, `/v1/worker/runs/${ready.runId}/publication-intents`, {
      method: "POST", token: WORKER_TOKEN,
      headers: { "x-soyuz-worker-id": "trusted-publication-host-b", "x-soyuz-claim-callback-id": "018f0000-0000-7000-8000-000000000043" },
      body: ready.intentBody,
    });
    const changed = await call(bindings, `/v1/worker/runs/${ready.runId}/publication-intents`, {
      method: "POST", token: WORKER_TOKEN,
      headers: { "x-soyuz-worker-id": "trusted-publication-host-b", "x-soyuz-claim-callback-id": "018f0000-0000-7000-8000-000000000043" },
      body: { ...ready.intentBody, title: "Changed after authorization" },
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body.data.publicationId).toBe(ready.intent.body.data.publicationId);
    expect(changed.response.status).toBe(409);
    expect(changed.body.error.code).toBe("PUBLICATION_INTENT_CONFLICT");
    const count = await bindings.DB.prepare("SELECT COUNT(*) AS count FROM publication_intents WHERE run_id = ?")
      .bind(ready.runId).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("[PUBLICATION-INTENT-02] binds manifest registration to the live worker claim and canonical run destination", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "fenced-publication-host";
    const claimCallbackId = "018f0000-0000-7000-8000-000000000045";
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000046", withEvidence: false,
    });
    const newClaimId = "018f0000-0000-7000-8000-000000000047";
    const claimAt = new Date().toISOString();
    await bindings.DB.prepare(`INSERT INTO run_events (
      run_id, contract_version, event_id, type, worker_id, occurred_at, recorded_at, payload_json
    ) VALUES (?, '1', ?, 'run.claimed', ?, ?, ?, '{}')`)
      .bind(data.runId, newClaimId, workerId, claimAt, claimAt).run();
    const stale = await call(bindings, `/v1/worker/runs/${data.runId}/publication-intents`, {
      method: "POST", token: WORKER_TOKEN,
      headers: { "x-soyuz-worker-id": workerId, "x-soyuz-claim-callback-id": claimCallbackId },
      body: data.intentBody,
    });
    const missingFence = await call(bindings, `/v1/worker/runs/${data.runId}/publication-intents`, {
      method: "POST", token: WORKER_TOKEN,
      headers: { "x-soyuz-worker-id": workerId },
      body: data.intentBody,
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body.error.code).toBe("STALE_CLAIM");
    expect(missingFence.response.status).toBe(400);

    const otherRun = await startRunningRun(bindings, "wrong-destination-host", "018f0000-0000-7000-8000-000000000048", crypto.randomUUID());
    const wrongArtifact = await publicationManifest(otherRun, "018f0000-0000-7000-8000-000000000049");
    wrongArtifact.repository.name = "unapproved-project";
    const bytes = JSON.stringify(wrongArtifact);
    const wrongDestination = await callBinary(bindings, `/v1/worker/runs/${otherRun}/publication-manifests/${wrongArtifact.artifactId}`, {
      method: "PUT", token: WORKER_TOKEN,
      headers: {
        "content-type": "application/json", "content-length": String(new TextEncoder().encode(bytes).byteLength),
        "x-soyuz-worker-id": "wrong-destination-host", "x-soyuz-claim-callback-id": "018f0000-0000-7000-8000-000000000048",
      },
      body: bytes,
    });
    expect(wrongDestination.response.status).toBe(422);
    expect((wrongDestination.body as any).error.code).toBe("MANIFEST_INVALID");

    const unapproved = testEnv({ artifacts: r2.bucket });
    unapproved.bindings.PUBLICATION_REPOSITORY_ALLOWLIST = "[]";
    const rejected = await registerPublicationInputs(unapproved.bindings, {
      workerId: "unapproved-publication-host",
      claimCallbackId: "018f0000-0000-7000-8000-00000000004a",
      artifactId: "018f0000-0000-7000-8000-00000000004b",
    });
    expect(rejected.intent.response.status).toBe(403);
    expect(rejected.intent.body.error.code).toBe("PUBLICATION_POLICY_DENIED");
  });

  it("[PUBLICATION-MANIFEST-CLAIM-01] lets a new claim recover an upload that became stale during the R2 write", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "manifest-recovery-host";
    const oldClaimId = "018f0000-0000-7000-8000-00000000004c";
    const newClaimId = "018f0000-0000-7000-8000-00000000004d";
    const runId = await startRunningRun(bindings, workerId, oldClaimId, crypto.randomUUID());
    const artifactId = "018f0000-0000-7000-8000-00000000004e";
    const manifest = await publicationManifest(runId, artifactId);
    const body = JSON.stringify(manifest);
    const originalPut = r2.put.getMockImplementation()!;
    r2.put.mockImplementationOnce(async (...args) => {
      const result = await originalPut(...args);
      const claimAt = new Date().toISOString();
      await bindings.DB.prepare(`INSERT INTO run_events (
        run_id, contract_version, event_id, type, worker_id, occurred_at, recorded_at, payload_json
      ) VALUES (?, '1', ?, 'run.claimed', ?, ?, ?, '{}')`)
        .bind(runId, newClaimId, workerId, claimAt, claimAt).run();
      return result;
    });
    const upload = (claimCallbackId: string) => callBinary(bindings,
      `/v1/worker/runs/${runId}/publication-manifests/${artifactId}`, {
        method: "PUT", token: WORKER_TOKEN,
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(body).byteLength),
          "x-soyuz-worker-id": workerId,
          "x-soyuz-claim-callback-id": claimCallbackId,
        },
        body,
      });

    const staleUpload = await upload(oldClaimId);
    expect(staleUpload.response.status).toBe(409);
    expect((staleUpload.body as { error: { code: string } }).error.code).toBe("STALE_CLAIM");
    const recoveredUpload = await upload(newClaimId);
    expect(recoveredUpload.response.status).toBe(201);
    const artifact = await bindings.DB.prepare("SELECT state, worker_id, claim_callback_id FROM publication_manifest_artifacts WHERE artifact_id = ?")
      .bind(artifactId).first<{ state: string; worker_id: string; claim_callback_id: string }>();
    expect(artifact).toEqual({ state: "ready", worker_id: workerId, claim_callback_id: newClaimId });
  });

  it.each([
    { stage: "reservation", sql: "INSERT OR IGNORE INTO publication_manifest_artifacts", code: "MANIFEST_INDEX_RESERVATION_UNAVAILABLE" },
    { stage: "finalization", sql: "SET state = 'ready'", code: "MANIFEST_INDEX_FINALIZATION_UNAVAILABLE" },
  ])("reports a recoverable D1 manifest $stage failure separately", async ({ stage, sql, code }) => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = `manifest-${code.toLowerCase()}-host`;
    const claimCallbackId = crypto.randomUUID();
    const runId = await startRunningRun(bindings, workerId, claimCallbackId, crypto.randomUUID());
    const artifactId = "018f0000-0000-7000-8000-000000000221";
    const manifest = await publicationManifest(runId, artifactId);
    const body = JSON.stringify(manifest);
    const originalDb = bindings.DB;
    let failed = false;
    bindings.DB = new Proxy(originalDb, {
      get(target, property) {
        if (property === "prepare") return (query: string) => {
          const statement = target.prepare(query);
          const wrap = (prepared: D1PreparedStatement): D1PreparedStatement => new Proxy(prepared, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "bind") return (...values: unknown[]) => wrap(statementTarget.bind(...values));
              if (statementProperty === "run") return () => {
                if (!failed && query.includes(sql)) {
                  failed = true;
                  throw new Error("simulated D1 failure");
                }
                return statementTarget.run();
              };
              const value = Reflect.get(statementTarget, statementProperty, statementTarget);
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
          return wrap(statement);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const upload = (env: Env) => callBinary(env,
      `/v1/worker/runs/${runId}/publication-manifests/${artifactId}`, {
        method: "PUT", token: WORKER_TOKEN,
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(body).byteLength),
          "x-soyuz-worker-id": workerId,
          "x-soyuz-claim-callback-id": claimCallbackId,
        },
        body,
      });

    const failedUpload = await upload(bindings);

    expect(failedUpload.response.status).toBe(503);
    expect((failedUpload.body as { error: { code: string } }).error.code).toBe(code);
    expect(failed).toBe(true);
    bindings.DB = originalDb;
    const retriedUpload = await upload(bindings);
    expect(retriedUpload.response.status).toBe(201);
    const artifact = await originalDb.prepare("SELECT state FROM publication_manifest_artifacts WHERE artifact_id = ?")
      .bind(artifactId).first<{ state: string }>();
    expect(artifact?.state).toBe("ready");
    if (stage === "finalization") expect(r2.objects.size).toBe(1);
  });

  it("reports an R2 manifest write failure separately and recovers the same artifact ID", async () => {
    const r2 = memoryArtifactBucket();
    const put = r2.put.getMockImplementation()!;
    r2.put.mockImplementationOnce(async () => { throw new Error("simulated R2 failure"); });
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "manifest-r2-failure-host";
    const claimCallbackId = crypto.randomUUID();
    const runId = await startRunningRun(bindings, workerId, claimCallbackId, crypto.randomUUID());
    const artifactId = "018f0000-0000-7000-8000-000000000222";
    const manifest = await publicationManifest(runId, artifactId);
    const body = JSON.stringify(manifest);
    const upload = () => callBinary(bindings,
      `/v1/worker/runs/${runId}/publication-manifests/${artifactId}`, {
        method: "PUT", token: WORKER_TOKEN,
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(body).byteLength),
          "x-soyuz-worker-id": workerId,
          "x-soyuz-claim-callback-id": claimCallbackId,
        },
        body,
      });

    const failedUpload = await upload();
    expect(failedUpload.response.status).toBe(503);
    expect((failedUpload.body as { error: { code: string } }).error.code).toBe("MANIFEST_OBJECT_WRITE_UNAVAILABLE");
    const pending = await bindings.DB.prepare("SELECT state FROM publication_manifest_artifacts WHERE artifact_id = ?")
      .bind(artifactId).first<{ state: string }>();
    expect(pending?.state).toBe("pending");
    r2.put.mockImplementationOnce(put);

    const retriedUpload = await upload();
    expect(retriedUpload.response.status).toBe(201);
    const ready = await bindings.DB.prepare("SELECT state FROM publication_manifest_artifacts WHERE artifact_id = ?")
      .bind(artifactId).first<{ state: string }>();
    expect(ready?.state).toBe("ready");
  });

  it("[PUBLICATION-INTENT-03] keeps legacy, failed, and cancelled executions out of the Kirisame ledger", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const legacy = await registerPublicationInputs(bindings, {
      workerId: "legacy-kaseki-host", claimCallbackId: "018f0000-0000-7000-8000-000000000051",
      artifactId: "018f0000-0000-7000-8000-000000000052",
    });
    await completeExecution(bindings, {
      runId: legacy.runId, workerId: "legacy-kaseki-host", claimCallbackId: "018f0000-0000-7000-8000-000000000051",
      publishedUrl: "https://github.com/example/project/pull/8",
    });
    const legacyLedger = await bindings.DB.prepare("SELECT publication_id FROM publications WHERE run_id = ?")
      .bind(legacy.runId).first();
    const legacyIntent = await bindings.DB.prepare("SELECT state FROM publication_intents WHERE run_id = ?")
      .bind(legacy.runId).first<{ state: string }>();
    const legacyStatus = await call(bindings, `/v1/runs/${legacy.runId}/publication`, { token: CLIENT_TOKEN });
    expect(legacyLedger).toBeNull();
    expect(legacyIntent?.state).toBe("abandoned");
    expect(legacyStatus.body.data.legacyPublishedUrl).toBe("https://github.com/example/project/pull/8");

    const failed = await registerPublicationInputs(bindings, {
      workerId: "failed-execution-host", claimCallbackId: "018f0000-0000-7000-8000-000000000053",
      artifactId: "018f0000-0000-7000-8000-000000000054",
    });
    await call(bindings, `/v1/worker/runs/${failed.runId}/failed`, {
      method: "POST", token: WORKER_TOKEN,
      body: {
        contractVersion: "1", callbackId: crypto.randomUUID(), workerId: "failed-execution-host",
        claimCallbackId: "018f0000-0000-7000-8000-000000000053", failureClass: "validation_failed", failureMessage: "failed",
      },
    });
    const failedPublication = await bindings.DB.prepare("SELECT publication_id FROM publications WHERE run_id = ?")
      .bind(failed.runId).first();
    expect(failedPublication).toBeNull();

    const cancelled = await registerPublicationInputs(bindings, {
      workerId: "cancelled-execution-host", claimCallbackId: "018f0000-0000-7000-8000-000000000055",
      artifactId: "018f0000-0000-7000-8000-000000000056",
    });
    await call(bindings, `/v1/runs/${cancelled.runId}/cancel`, { method: "POST", token: CLIENT_TOKEN });
    await call(bindings, `/v1/worker/runs/${cancelled.runId}/cancelled`, {
      method: "POST", token: WORKER_TOKEN,
      body: {
        contractVersion: "1", callbackId: crypto.randomUUID(), workerId: "cancelled-execution-host",
        claimCallbackId: "018f0000-0000-7000-8000-000000000055", summary: "Cancelled before publication",
      },
    });
    const cancelledPublication = await bindings.DB.prepare("SELECT publication_id FROM publications WHERE run_id = ?")
      .bind(cancelled.runId).first();
    const cancelledIntent = await bindings.DB.prepare("SELECT state FROM publication_intents WHERE run_id = ?")
      .bind(cancelled.runId).first<{ state: string }>();
    expect(cancelledPublication).toBeNull();
    expect(cancelledIntent?.state).toBe("abandoned");
  });

  it("[PUBLICATION-INTENT-04] rejects missing manifests and mismatched artifact digests", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const data = await registerPublicationInputs(bindings, {
      workerId: "integrity-publication-host",
      claimCallbackId: "018f0000-0000-7000-8000-000000000057",
      artifactId: "018f0000-0000-7000-8000-000000000058",
    });
    const headers = {
      "x-soyuz-worker-id": "integrity-publication-host",
      "x-soyuz-claim-callback-id": "018f0000-0000-7000-8000-000000000057",
    };
    const missingManifest = await call(bindings, `/v1/worker/runs/${data.runId}/publication-intents`, {
      method: "POST", token: WORKER_TOKEN, headers,
      body: { ...data.intentBody, artifactId: "018f0000-0000-7000-8000-000000000059" },
    });
    expect(missingManifest.response.status).toBe(409);
    expect(missingManifest.body.error.code).toBe("MANIFEST_NOT_AUTHORIZED");

    const wrongDigest = await call(bindings, `/v1/worker/runs/${data.runId}/publication-intents`, {
      method: "POST", token: WORKER_TOKEN, headers,
      body: { ...data.intentBody, artifactDigest: `sha256:${"0".repeat(64)}` },
    });
    expect(wrongDigest.response.status).toBe(422);
    expect(wrongDigest.body.error.code).toBe("ARTIFACT_DIGEST_OR_PROVENANCE_INVALID");

    expect(data.intent.response.status).toBe(201);
  });

  it("[PUBLICATION-LEDGER-01] materializes only completed intent and publishes a confirmed open PR separately", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "publication-host-pr";
    const claimCallbackId = "018f0000-0000-7000-8000-000000000061";
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000062",
    });
    const beforeCompletion = await bindings.DB.prepare("SELECT publication_id FROM publications WHERE run_id = ?")
      .bind(data.runId).first();
    expect(beforeCompletion).toBeNull();

    const completed = await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    expect(completed.body.data.status).toBe("completed");
    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication?.state).toBe("pending");
    expect(publication?.attempt_count).toBe(0);
    const mock = new MockPublisherEntrypoint(["success"]);
    await reconcilePublications(bindings, new Date(), mock);
    const published = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(published).toMatchObject({ state: "published", attempt_count: 1, pr_number: 17 });
    expect(published?.pr_url).toBe("https://github.com/example/project/pull/17");
    expect(JSON.parse(mock.calls[0]!).artifact).toMatchObject({ artifactId: "018f0000-0000-7000-8000-000000000062" });
    expect(mock.rpcCredentials).toEqual([{ callerId: "soyuz", apiKey: KIRISAME_API_TEST_KEY }]);
    expect(mock.calls[0]).not.toContain(KIRISAME_API_TEST_KEY);
    const run = await getRun(bindings.DB, data.runId);
    expect(run?.status).toBe("completed");
    const status = await call(bindings, `/v1/runs/${data.runId}/publication`, { token: CLIENT_TOKEN });
    expect(status.body.data.publication).toMatchObject({ state: "published", pullRequestNumber: 17 });
    expect(status.body.data).not.toHaveProperty("artifactObjectKey");
    const unauthenticated = await call(bindings, `/v1/runs/${data.runId}/publication`);
    expect(unauthenticated.response.status).toBe(401);
    const notPublicArtifact = await call(bindings, `/v1/runs/${data.runId}/artifacts/018f0000-0000-7000-8000-000000000062`, { token: CLIENT_TOKEN });
    expect(notPublicArtifact.response.status).toBe(404);
  });

  it("[PUBLICATION-BRANCH-01] accepts branch-only success without inventing a pull request", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "publication-host-branch";
    const claimCallbackId = "018f0000-0000-7000-8000-000000000065";
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000066", mode: "branch",
    });
    expect(data.intent.response.status).toBe(201);
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    await reconcilePublications(bindings, new Date(), new MockPublisherEntrypoint(["success"]));
    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication).toMatchObject({ state: "published", mode: "branch", branch_sha: "b".repeat(40), pr_number: null, pr_url: null });
  });

  it("[PUBLICATION-DISPATCH-BATCH-01] processes more than three due publications in one sweep", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const runIds: string[] = [];
    expect(PUBLICATION_DISPATCH_BATCH_SIZE).toBeGreaterThan(3);
    const publicationCount = PUBLICATION_DISPATCH_BATCH_SIZE + 1;
    for (let index = 0; index < publicationCount; index += 1) {
      const workerId = `publication-batch-host-${index}`;
      const claimCallbackId = crypto.randomUUID();
      const artifactId = `018f0000-0000-7000-8000-${String(100 + index).padStart(12, "0")}`;
      const data = await registerPublicationInputs(bindings, { workerId, claimCallbackId, artifactId });
      await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
      runIds.push(data.runId);
    }

    const publisher = new MockPublisherEntrypoint();
    await reconcilePublications(bindings, new Date(), publisher);

    expect(publisher.calls).toHaveLength(PUBLICATION_DISPATCH_BATCH_SIZE);
    const states = await Promise.all(runIds.map((runId) => bindings.DB.prepare("SELECT state FROM publications WHERE run_id = ?")
      .bind(runId).first<{ state: string }>()));
    expect(states.filter((row) => row?.state === "published")).toHaveLength(PUBLICATION_DISPATCH_BATCH_SIZE);
    expect(states.filter((row) => row?.state === "pending")).toHaveLength(1);
  });

  it("uses a fresh timestamp for each sequential dispatch in one scheduler sweep", async () => {
    vi.useFakeTimers();
    const sweepAt = new Date("2026-11-28T12:00:00.000Z");
    vi.setSystemTime(sweepAt);
    try {
      const r2 = memoryArtifactBucket();
      const { bindings } = testEnv({ artifacts: r2.bucket });
      const inputs = [
        { workerId: "fresh-clock-host-a", claimCallbackId: crypto.randomUUID(), artifactId: "018f0000-0000-7000-8000-000000000301" },
        { workerId: "fresh-clock-host-b", claimCallbackId: crypto.randomUUID(), artifactId: "018f0000-0000-7000-8000-000000000302" },
      ];
      for (const input of inputs) {
        const data = await registerPublicationInputs(bindings, input);
        await completeExecution(bindings, { runId: data.runId, workerId: input.workerId, claimCallbackId: input.claimCallbackId });
      }

      const inner = new MockPublisherEntrypoint();
      let calls = 0;
      const publisher = {
        async publish(requestJson: string, callerId: string, apiKey: string) {
          const result = await inner.publish(requestJson, callerId, apiKey);
          calls += 1;
          if (calls === 1) vi.setSystemTime(new Date(sweepAt.getTime() + 90_000));
          return result;
        },
      };

      await reconcilePublications(bindings, sweepAt, publisher);

      const reservations = await bindings.DB.prepare(`SELECT occurred_at FROM publication_events
        WHERE event_type = 'publication.attempt_reserved' ORDER BY occurred_at, event_id`).all<{ occurred_at: string }>();
      expect(calls).toBe(2);
      expect(reservations.results?.map((event) => event.occurred_at)).toEqual([
        sweepAt.toISOString(), new Date(sweepAt.getTime() + 90_000).toISOString(),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a reservation when manifest preparation leaves too little lease for the RPC", async () => {
    vi.useFakeTimers();
    const at = new Date("2026-11-28T12:00:00.000Z");
    vi.setSystemTime(at);
    try {
      const r2 = memoryArtifactBucket();
      const { bindings } = testEnv({ artifacts: r2.bucket });
      const workerId = "preparation-near-lease-expiry-host";
      const claimCallbackId = crypto.randomUUID();
      const data = await registerPublicationInputs(bindings, {
        workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000303",
      });
      await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
      const originalGet = r2.get.getMockImplementation()!;
      r2.get.mockImplementationOnce(async (...args) => {
        const object = await originalGet(...args);
        vi.setSystemTime(new Date(at.getTime() + PUBLICATION_LEASE_MS - 20_000));
        return object;
      });
      const publisher = new MockPublisherEntrypoint();

      await reconcilePublications(bindings, at, publisher);

      const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
        .bind(data.runId).first<PublicationRow>();
      expect(publisher.calls).toHaveLength(0);
      expect(publication).toMatchObject({ state: "pending", attempt_count: 0, attempt_id: null, lease_expires_at: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bases retry scheduling on the time Kirisame returns its retryable result", async () => {
    vi.useFakeTimers();
    const at = new Date("2026-11-28T12:00:00.000Z");
    vi.setSystemTime(at);
    try {
      const r2 = memoryArtifactBucket();
      const { bindings } = testEnv({ artifacts: r2.bucket });
      const workerId = "delayed-retry-result-host";
      const claimCallbackId = crypto.randomUUID();
      const data = await registerPublicationInputs(bindings, {
        workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000304",
      });
      await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
      const inner = new MockPublisherEntrypoint(["retryable_error"]);
      const publisher = {
        async publish(requestJson: string, callerId: string, apiKey: string) {
          const result = await inner.publish(requestJson, callerId, apiKey);
          vi.setSystemTime(new Date(at.getTime() + PUBLICATION_LEASE_MS + 1));
          return result;
        },
      };

      await reconcilePublications(bindings, at, publisher);

      const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
        .bind(data.runId).first<PublicationRow>();
      expect(publication?.state).toBe("retryable_failure");
      expect(Date.parse(publication!.next_attempt_at!)).toBeGreaterThan(at.getTime() + PUBLICATION_LEASE_MS + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks a successful result received after lease expiry for operator review", async () => {
    vi.useFakeTimers();
    const at = new Date("2026-11-28T12:00:00.000Z");
    vi.setSystemTime(at);
    try {
      const r2 = memoryArtifactBucket();
      const { bindings } = testEnv({ artifacts: r2.bucket });
      const workerId = "late-current-publication-response-host";
      const claimCallbackId = crypto.randomUUID();
      const data = await registerPublicationInputs(bindings, {
        workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000306",
      });
      await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
      const inner = new MockPublisherEntrypoint();
      const publisher = {
        async publish(requestJson: string, callerId: string, apiKey: string) {
          const result = await inner.publish(requestJson, callerId, apiKey);
          vi.setSystemTime(new Date(at.getTime() + PUBLICATION_LEASE_MS + 1));
          return result;
        },
      };

      await reconcilePublications(bindings, at, publisher);

      const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
        .bind(data.runId).first<PublicationRow>();
      const events = await bindings.DB.prepare(`SELECT event_type FROM publication_events
        WHERE publication_id = ? AND event_type IN ('publication.published', 'publication.blocked')`)
        .bind(publication!.publication_id)
        .all<{ event_type: string }>();
      expect(publication).toMatchObject({
        state: "blocked", attempt_count: 1, last_error_code: "PUBLICATION_OUTCOME_UNKNOWN",
        branch_sha: null,
      });
      expect(events.results.map(({ event_type }) => event_type)).toEqual(["publication.blocked"]);
      await reconcilePublications(bindings, new Date(at.getTime() + PUBLICATION_LEASE_MS * 2), inner);
      expect(inner.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start dispatch inside the RPC timeout window at the canonical run deadline", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "publication-at-deadline-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000305",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    const run = await bindings.DB.prepare("SELECT expires_at FROM runs WHERE id = ?")
      .bind(data.runId).first<{ expires_at: string }>();
    const canonicalDeadline = new Date(run!.expires_at);
    const nearDeadline = new Date(canonicalDeadline.getTime() - 10_000);
    const publisher = new MockPublisherEntrypoint();

    await dispatchPublication(bindings, publication!, publisher, nearDeadline);

    const unchanged = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication?.expires_at).toBe(run?.expires_at);
    expect(unchanged).toMatchObject({ state: "pending", attempt_count: 0, attempt_id: null });
    expect(publisher.calls).toHaveLength(0);
  });

  it("[PUBLICATION-RETRY-LIMIT-01] blocks after the eighth reserved attempt without stranding a retry", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "publication-retry-limit-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000105",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const publisher = new MockPublisherEntrypoint(Array.from({ length: 8 }, () => "retryable_error" as const));
    let publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    let at = new Date();
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await dispatchPublication(bindings, publication!, publisher, at);
      publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
        .bind(data.runId).first<PublicationRow>();
      expect(publication?.attempt_count).toBe(attempt);
      const intent = await bindings.DB.prepare("SELECT state, retained_until FROM publication_intents WHERE publication_id = ?")
        .bind(publication!.publication_id).first<{ state: string; retained_until: string | null }>();
      expect(intent?.state).toBe("consumed");
      expect(intent?.retained_until).toBeNull();
      if (attempt < 8) {
        expect(publication?.state).toBe("retryable_failure");
        at = new Date(Date.parse(publication!.next_attempt_at!) + 1);
      }
    }

    expect(publication).toMatchObject({ state: "blocked", attempt_count: 8, last_error_code: "PUBLICATION_OUTCOME_UNKNOWN" });
    expect(publisher.calls).toHaveLength(8);
  });

  it.each([1, 7])("recovers an expired attempt %i with one in-budget dispatch", async (attemptCount) => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = `expired-attempt-${attemptCount}-host`;
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: `018f0000-0000-7000-8000-${String(200 + attemptCount).padStart(12, "0")}`,
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const oldAttemptId = crypto.randomUUID();
    const expiredAt = new Date(Date.now() - PUBLICATION_LEASE_MS).toISOString();
    await bindings.DB.prepare(`UPDATE publications SET state = 'publishing', attempt_count = ?, attempt_id = ?,
      lease_expires_at = ?, next_attempt_at = NULL WHERE run_id = ?`)
      .bind(attemptCount, oldAttemptId, expiredAt, data.runId).run();
    const publisher = new MockPublisherEntrypoint(["success"]);

    await reconcilePublications(bindings, new Date(), publisher);

    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication).toMatchObject({ state: "published", attempt_count: attemptCount + 1 });
    expect(publication?.attempt_id).not.toBe(oldAttemptId);
    expect(publisher.calls).toHaveLength(1);
  });

  it("blocks an expired eighth attempt as uncertain and removes it from future scheduler batches", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "expired-eighth-attempt-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000208",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    const oldAttemptId = crypto.randomUUID();
    const expiry = publication!.expires_at;
    const partialPrUrl = `https://github.com/${publication!.repository_owner}/${publication!.repository_name}/pull/23`;
    await bindings.DB.prepare(`UPDATE publications SET state = 'publishing', attempt_count = 8, attempt_id = ?,
      lease_expires_at = ?, branch_sha = ?, pr_number = 23, pr_url = ? WHERE publication_id = ?`)
      .bind(oldAttemptId, new Date(Date.now() - PUBLICATION_LEASE_MS).toISOString(), "c".repeat(40), partialPrUrl, publication!.publication_id).run();
    const publisher = new MockPublisherEntrypoint(["success"]);

    await Promise.all([
      reconcilePublications(bindings, new Date(), publisher),
      reconcilePublications(bindings, new Date(), publisher),
    ]);
    await reconcilePublications(bindings, new Date(Date.now() + PUBLICATION_LEASE_MS * 2), publisher);

    const recovered = await bindings.DB.prepare("SELECT * FROM publications WHERE publication_id = ?")
      .bind(publication!.publication_id).first<PublicationRow>();
    const blockedEvent = await bindings.DB.prepare(`SELECT metadata_json FROM publication_events
      WHERE publication_id = ? AND event_type = 'publication.blocked' ORDER BY occurred_at DESC LIMIT 1`)
      .bind(publication!.publication_id).first<{ metadata_json: string }>();
    const blockedEvents = await bindings.DB.prepare(`SELECT COUNT(*) AS count FROM publication_events
      WHERE publication_id = ? AND event_type = 'publication.blocked'`)
      .bind(publication!.publication_id).first<{ count: number }>();
    expect(recovered).toMatchObject({
      state: "blocked", attempt_count: 8, attempt_id: oldAttemptId, last_error_code: "PUBLICATION_OUTCOME_UNKNOWN",
      branch_sha: "c".repeat(40), pr_number: 23, pr_url: partialPrUrl, expires_at: expiry,
    });
    expect(JSON.parse(blockedEvent!.metadata_json)).toMatchObject({ operatorReviewRequired: true });
    expect(blockedEvents?.count).toBe(1);
    expect(publisher.calls).toHaveLength(0);
  });

  it("accepts a confirmed publication on the eighth attempt", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "confirmed-eighth-attempt-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000209",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    await bindings.DB.prepare(`UPDATE publications SET state = 'retryable_failure', attempt_count = 7,
      next_attempt_at = ? WHERE run_id = ?`).bind(new Date(Date.now() - 1000).toISOString(), data.runId).run();
    const publisher = new MockPublisherEntrypoint(["success"]);

    await reconcilePublications(bindings, new Date(), publisher);

    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication).toMatchObject({ state: "published", attempt_count: 8, pr_number: 17 });
    expect(publisher.calls).toHaveLength(1);
  });

  it("keeps confirmed absence distinct from an uncertain retry-limit outcome", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "confirmed-absence-retry-limit-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000213",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const calls: string[] = [];
    const publisher = {
      async publish(requestJson: string) {
        calls.push(requestJson);
        const request = JSON.parse(requestJson) as {
          publicationId: string; runId: string; repository: { owner: string; name: string }; mode: "branch" | "pr";
        };
        return {
          contractVersion: "1", publicationId: request.publicationId, runId: request.runId,
          repository: request.repository, mode: request.mode, outcome: "retryable_failure", retryable: true,
          reconciliation: "confirmed_absent",
          error: { code: "GITHUB_RATE_LIMITED", classification: "retryable", message: "Retry after rate limit." },
        };
      },
    };
    let at = new Date();
    let publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await dispatchPublication(bindings, publication!, publisher, at);
      publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
        .bind(data.runId).first<PublicationRow>();
      expect(publication?.attempt_count).toBe(attempt);
      if (attempt < 8) at = new Date(Date.parse(publication!.next_attempt_at!) + 1);
    }

    expect(publication).toMatchObject({ state: "blocked", last_error_code: "RETRY_LIMIT_REACHED", attempt_count: 8 });
    expect(calls).toHaveLength(8);
  });

  it("ignores a late result from an attempt superseded by an expired lease recovery", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "late-publication-response-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000214",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    let releaseFirst!: (value: unknown) => void;
    let firstStarted!: () => void;
    const firstCallStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const calls: string[] = [];
    const success = (requestJson: string, prNumber: number, sha: string) => {
      const request = JSON.parse(requestJson) as {
        publicationId: string; runId: string; repository: { owner: string; name: string };
        mode: "branch" | "pr"; headRef: string;
      };
      return {
        contractVersion: "1", publicationId: request.publicationId, runId: request.runId,
        repository: request.repository, mode: request.mode, outcome: "pr_published", retryable: false,
        reconciliation: "not_needed", branch: { ref: request.headRef, commitSha: sha },
        pullRequest: { number: prNumber, url: `https://github.com/${request.repository.owner}/${request.repository.name}/pull/${prNumber}`, state: "open" },
      };
    };
    const publisher = {
      publish(requestJson: string) {
        calls.push(requestJson);
        if (calls.length === 1) {
          firstStarted();
          return new Promise<unknown>((resolve) => { releaseFirst = resolve; });
        }
        return Promise.resolve(success(requestJson, 17, "b".repeat(40)));
      },
    };
    const at = new Date();
    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    const staleAttempt = dispatchPublication(bindings, publication!, publisher, at);
    await firstCallStarted;
    const leased = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();

    await dispatchPublication(bindings, leased!, publisher, new Date(at.getTime() + PUBLICATION_LEASE_MS + 1));
    releaseFirst(success(calls[0]!, 41, "a".repeat(40)));
    await staleAttempt;

    const recovered = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(recovered).toMatchObject({ state: "published", attempt_count: 2, branch_sha: "b".repeat(40), pr_number: 17 });
    expect(calls).toHaveLength(2);
  });

  it("[PUBLICATION-RPC-01] blocks malformed or identity-mismatched publisher responses and stays inert without a binding", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const scenarios = ["wrong_publication_id", "wrong_repository", "wrong_branch", "malformed_response"] as const;
    for (const [index, scenario] of scenarios.entries()) {
      const artifactId = `018f0000-0000-7000-8000-${String(index + 101).padStart(12, "0")}`;
      const workerId = `rpc-validation-host-${index}`;
      const claimCallbackId = crypto.randomUUID();
      const data = await registerPublicationInputs(bindings, { workerId, claimCallbackId, artifactId });
      await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
      await reconcilePublications(bindings, new Date(), new MockPublisherEntrypoint([scenario]));
      const blocked = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
        .bind(data.runId).first<PublicationRow>();
      expect(blocked).toMatchObject({ state: "blocked", last_error_code: "INVALID_PUBLISHER_RESPONSE" });
    }

    const idleArtifactId = "018f0000-0000-7000-8000-000000000199";
    const workerId = "no-binding-host";
    const claimCallbackId = crypto.randomUUID();
    const idle = await registerPublicationInputs(bindings, { workerId, claimCallbackId, artifactId: idleArtifactId });
    await completeExecution(bindings, { runId: idle.runId, workerId, claimCallbackId });
    await reconcilePublications(bindings);
    const stillPending = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(idle.runId).first<PublicationRow>();
    expect(stillPending).toMatchObject({ state: "pending", attempt_count: 0 });
  });

  it("[PUBLICATION-DISPATCH-01] fences concurrent attempts, retries uncertain outcomes, and blocks permanent conflicts", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "publication-host-retry";
    const claimCallbackId = "018f0000-0000-7000-8000-000000000071";
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000072",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const row = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?").bind(data.runId).first<PublicationRow>();
    const concurrentPublisher = new MockPublisherEntrypoint(["success"]);
    const results = await Promise.all([
      dispatchPublication(bindings, row!, concurrentPublisher),
      dispatchPublication(bindings, row!, concurrentPublisher),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(concurrentPublisher.calls).toHaveLength(1);

    const retryData = await registerPublicationInputs(bindings, {
      workerId: "publication-host-lost-response", claimCallbackId: "018f0000-0000-7000-8000-000000000073",
      artifactId: "018f0000-0000-7000-8000-000000000074",
    });
    await completeExecution(bindings, { runId: retryData.runId, workerId: "publication-host-lost-response", claimCallbackId: "018f0000-0000-7000-8000-000000000073" });
    const lostResponseMock = new MockPublisherEntrypoint(["lost_response"]);
    await reconcilePublications(bindings, new Date(), lostResponseMock);
    let retryable = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(retryData.runId).first<PublicationRow>();
    expect(retryable?.state).toBe("retryable_failure");
    const retryAt = new Date(Date.parse(retryable!.next_attempt_at!) + 1_000);
    await reconcilePublications(bindings, retryAt, lostResponseMock);
    retryable = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(retryData.runId).first<PublicationRow>();
    expect(retryable?.state).toBe("published");
    expect(lostResponseMock.calls[0]).toBe(lostResponseMock.calls[1]);
    expect(retryable?.attempt_count).toBe(2);

    const timeoutData = await registerPublicationInputs(bindings, {
      workerId: "publication-host-timeout", claimCallbackId: "018f0000-0000-7000-8000-000000000077",
      artifactId: "018f0000-0000-7000-8000-000000000078",
    });
    await completeExecution(bindings, { runId: timeoutData.runId, workerId: "publication-host-timeout", claimCallbackId: "018f0000-0000-7000-8000-000000000077" });
    const timeoutMock = new MockPublisherEntrypoint(["timeout", "success"]);
    await reconcilePublications(bindings, new Date(), timeoutMock);
    const timedOut = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(timeoutData.runId).first<PublicationRow>();
    expect(timedOut?.state).toBe("retryable_failure");
    await reconcilePublications(bindings, new Date(Date.parse(timedOut!.next_attempt_at!) + 1_000), timeoutMock);
    const recoveredTimeout = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(timeoutData.runId).first<PublicationRow>();
    expect(recoveredTimeout?.state).toBe("published");

    const conflictData = await registerPublicationInputs(bindings, {
      workerId: "publication-host-conflict", claimCallbackId: "018f0000-0000-7000-8000-000000000075",
      artifactId: "018f0000-0000-7000-8000-000000000076",
    });
    await completeExecution(bindings, { runId: conflictData.runId, workerId: "publication-host-conflict", claimCallbackId: "018f0000-0000-7000-8000-000000000075" });
    const permanentMock = new MockPublisherEntrypoint(["permanent_conflict", "success"]);
    await reconcilePublications(bindings, new Date(), permanentMock);
    const blocked = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(conflictData.runId).first<PublicationRow>();
    await reconcilePublications(bindings, new Date(Date.now() + PUBLICATION_LEASE_MS * 2), permanentMock);
    expect(blocked?.state).toBe("blocked");
    expect(blocked?.last_error_code).toBe("BASE_MOVED");
    expect(permanentMock.calls).toHaveLength(1);
  });

  it.each([
    { scenario: "app_not_installed" as const, code: "APP_NOT_INSTALLED" },
    { scenario: "github_permission_denied" as const, code: "GITHUB_PERMISSION_DENIED" },
  ])("records $code as blocked and does not retry without operator action", async ({ scenario, code }) => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = `publication-${scenario}`;
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000106",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const publisher = new MockPublisherEntrypoint([scenario, "success"]);

    await reconcilePublications(bindings, new Date(), publisher);
    const blocked = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    const blockedEvent = await bindings.DB.prepare(
      "SELECT event_type, state FROM publication_events WHERE publication_id = ? AND event_type = 'publication.blocked'",
    ).bind(blocked!.publication_id).first<{ event_type: string; state: string }>();

    expect(blocked).toMatchObject({ state: "blocked", last_error_code: code, attempt_count: 1 });
    expect(blockedEvent).toEqual({ event_type: "publication.blocked", state: "blocked" });
    await reconcilePublications(bindings, new Date(Date.now() + PUBLICATION_LEASE_MS * 2), publisher);
    expect(publisher.calls).toHaveLength(1);
  });

  it.each(["KIRISAME_CALLER_ID", "KIRISAME_API_KEY"] as const)(
    "blocks permanently when %s is missing without retrying",
    async (credential) => {
      const r2 = memoryArtifactBucket();
      const { bindings } = testEnv({ artifacts: r2.bucket });
      const workerId = `missing-${credential.toLowerCase()}-host`;
      const claimCallbackId = crypto.randomUUID();
      const data = await registerPublicationInputs(bindings, {
        workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000107",
      });
      await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
      bindings[credential] = undefined;
      const publisher = new MockPublisherEntrypoint(["success"]);

      await reconcilePublications(bindings, new Date(), publisher);
      let publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
        .bind(data.runId).first<PublicationRow>();
      expect(publication).toMatchObject({
        state: "blocked", last_error_code: "KIRISAME_CALLER_CONFIGURATION_INVALID", attempt_count: 1,
      });
      const status = await call(bindings, `/v1/runs/${data.runId}/publication`, { token: CLIENT_TOKEN });
      expect(status.body.data.publication).toMatchObject({
        lastErrorCode: "KIRISAME_CALLER_CONFIGURATION_INVALID", operatorReviewRequired: true,
      });
      expect(publisher.calls).toHaveLength(0);

      if (credential === "KIRISAME_CALLER_ID") bindings.KIRISAME_CALLER_ID = "soyuz";
      else bindings.KIRISAME_API_KEY = KIRISAME_API_TEST_KEY;
      await reconcilePublications(bindings, new Date(Date.now() + PUBLICATION_LEASE_MS * 2), publisher);

      publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
        .bind(data.runId).first<PublicationRow>();
      expect(publication).toMatchObject({ state: "blocked", attempt_count: 1 });
      expect(publisher.calls).toHaveLength(0);
    },
  );

  it("blocks a non-Soyuz caller identity with sanitized operator guidance", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "incorrect-caller-identity-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000218",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    bindings.KIRISAME_CALLER_ID = "another-service";
    const publisher = new MockPublisherEntrypoint(["success"]);

    await reconcilePublications(bindings, new Date(), publisher);

    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    const event = await bindings.DB.prepare(`SELECT metadata_json FROM publication_events
      WHERE publication_id = ? AND event_type = 'publication.blocked'`)
      .bind(publication!.publication_id).first<{ metadata_json: string }>();
    expect(publication).toMatchObject({ state: "blocked", last_error_code: "KIRISAME_CALLER_CONFIGURATION_INVALID" });
    expect(publisher.calls).toHaveLength(0);
    expect(JSON.parse(event!.metadata_json)).toMatchObject({ operatorAction: expect.stringContaining("KIRISAME_CALLER_ID=soyuz") });
    expect(event!.metadata_json).not.toContain(KIRISAME_API_TEST_KEY);
  });

  it.each([
    { name: "repository removed", policy: [{ owner: "other", name: "project", modes: ["pr"], baseRefs: ["main"] }] },
    { name: "base branch removed", policy: [{ owner: "example", name: "project", modes: ["pr"], baseRefs: ["develop"] }] },
    { name: "publication mode removed", policy: [{ owner: "example", name: "project", modes: ["branch"], baseRefs: ["main"] }] },
  ])("blocks when current policy revokes the $name after intent registration", async ({ policy }) => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "revoked-policy-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000210",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    bindings.PUBLICATION_REPOSITORY_ALLOWLIST = JSON.stringify(policy);
    const publisher = new MockPublisherEntrypoint(["success"]);

    await reconcilePublications(bindings, new Date(), publisher);

    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication).toMatchObject({ state: "blocked", last_error_code: "PUBLICATION_POLICY_REVOKED" });
    expect(publisher.calls).toHaveLength(0);
  });

  it.each([undefined, "", "not-json", "[]"])("fails closed for unavailable publication policy %j", async (policy) => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "invalid-policy-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000211",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    bindings.PUBLICATION_REPOSITORY_ALLOWLIST = policy;
    const publisher = new MockPublisherEntrypoint(["success"]);

    await reconcilePublications(bindings, new Date(), publisher);

    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication).toMatchObject({ state: "blocked", last_error_code: "PUBLICATION_POLICY_REVOKED" });
    expect(publisher.calls).toHaveLength(0);
  });

  it("keeps the dispatch switch authoritative over an injected publisher", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "dispatch-disabled-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000212",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    bindings.PUBLICATION_DISPATCH_ENABLED = "false";
    const publisher = new MockPublisherEntrypoint(["success"]);

    await reconcilePublications(bindings, new Date(), publisher);

    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication).toMatchObject({ state: "pending", attempt_count: 0 });
    expect(publisher.calls).toHaveLength(0);
  });

  it("validates the dispatch lease using the injected reconciliation time", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "synthetic-time-dispatch-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000219",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const at = new Date(Date.now() - 5 * 60_000);
    const publisher = new MockPublisherEntrypoint(["success"]);

    await reconcilePublications(bindings, at, publisher);

    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication).toMatchObject({ state: "published", attempt_count: 1 });
    expect(publisher.calls).toHaveLength(1);
  });

  it("rechecks the current policy after manifest verification and before calling Kirisame", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "policy-changed-during-dispatch-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000215",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const originalGet = r2.get.getMockImplementation()!;
    r2.get.mockImplementationOnce(async (...args) => {
      bindings.PUBLICATION_REPOSITORY_ALLOWLIST = "[]";
      return originalGet(...args);
    });
    const publisher = new MockPublisherEntrypoint(["success"]);

    await reconcilePublications(bindings, new Date(), publisher);

    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication).toMatchObject({ state: "blocked", last_error_code: "PUBLICATION_POLICY_REVOKED" });
    expect(publisher.calls).toHaveLength(0);
  });

  it("blocks a pending retry when policy is revoked after its first uncertain response", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "policy-revoked-before-retry-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000216",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const publisher = new MockPublisherEntrypoint(["lost_response", "success"]);
    await reconcilePublications(bindings, new Date(), publisher);
    const retry = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(retry?.state).toBe("retryable_failure");
    bindings.PUBLICATION_REPOSITORY_ALLOWLIST = "[]";

    await reconcilePublications(bindings, new Date(Date.parse(retry!.next_attempt_at!) + 1), publisher);

    const blocked = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    const event = await bindings.DB.prepare(`SELECT metadata_json FROM publication_events
      WHERE publication_id = ? AND event_type = 'publication.blocked' ORDER BY occurred_at DESC LIMIT 1`)
      .bind(blocked!.publication_id).first<{ metadata_json: string }>();
    expect(blocked).toMatchObject({ state: "blocked", last_error_code: "PUBLICATION_POLICY_REVOKED", attempt_count: 2 });
    expect(JSON.parse(event!.metadata_json)).toMatchObject({ operatorReviewRequired: true, priorAttemptOutcomeUnknown: true });
    expect(publisher.calls).toHaveLength(1);
  });

  it("preserves a confirmed partial branch and requests review when policy is revoked", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "partial-branch-policy-revoked-host";
    const claimCallbackId = crypto.randomUUID();
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000217",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const calls: string[] = [];
    const publisher = {
      async publish(requestJson: string) {
        calls.push(requestJson);
        const request = JSON.parse(requestJson) as {
          publicationId: string; runId: string; repository: { owner: string; name: string }; mode: "branch" | "pr"; headRef: string;
        };
        return {
          contractVersion: "1", publicationId: request.publicationId, runId: request.runId,
          repository: request.repository, mode: request.mode, outcome: "retryable_failure", retryable: true,
          reconciliation: "unknown", branch: { ref: request.headRef, commitSha: "d".repeat(40) },
          error: { code: "GITHUB_TIMEOUT", classification: "retryable", message: "Timed out after branch creation." },
        };
      },
    };
    await reconcilePublications(bindings, new Date(), publisher);
    const retry = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(retry).toMatchObject({ state: "retryable_failure", branch_sha: "d".repeat(40) });
    bindings.PUBLICATION_REPOSITORY_ALLOWLIST = "[]";

    await reconcilePublications(bindings, new Date(Date.parse(retry!.next_attempt_at!) + 1), publisher);

    const blocked = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    const event = await bindings.DB.prepare(`SELECT metadata_json FROM publication_events
      WHERE publication_id = ? AND event_type = 'publication.blocked' ORDER BY occurred_at DESC LIMIT 1`)
      .bind(blocked!.publication_id).first<{ metadata_json: string }>();
    expect(blocked).toMatchObject({ state: "blocked", last_error_code: "PUBLICATION_POLICY_REVOKED", branch_sha: "d".repeat(40) });
    expect(JSON.parse(event!.metadata_json)).toMatchObject({ operatorReviewRequired: true, priorAttemptOutcomeUnknown: true });
    expect(calls).toHaveLength(1);
  });

  it("[PUBLICATION-RETENTION-01] keeps publication data within the run deadline and refuses pins beyond it", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const workerId = "publication-retention-host";
    const claimCallbackId = "018f0000-0000-7000-8000-000000000081";
    const data = await registerPublicationInputs(bindings, {
      workerId, claimCallbackId, artifactId: "018f0000-0000-7000-8000-000000000082",
    });
    await completeExecution(bindings, { runId: data.runId, workerId, claimCallbackId });
    const objectKey = `publication-manifests/${data.runId}/018f0000-0000-7000-8000-000000000082`;
    const run = await bindings.DB.prepare("SELECT expires_at FROM runs WHERE id = ?").bind(data.runId).first<{ expires_at: string }>();
    const publication = await bindings.DB.prepare("SELECT * FROM publications WHERE run_id = ?")
      .bind(data.runId).first<PublicationRow>();
    expect(publication!.expires_at).toBe(run!.expires_at);
    await expect(bindings.DB.prepare("UPDATE publications SET retained_until = '2099-01-01T00:00:00.000Z' WHERE run_id = ?")
      .bind(data.runId).run()).rejects.toThrow("PUBLICATION_EXPIRY_CANNOT_BE_EXTENDED");

    await purgeOldRuns(bindings, new Date());
    expect(await getRun(bindings.DB, data.runId)).not.toBeNull();
    expect(r2.objects.has(objectKey)).toBe(true);
    expect(await bindings.DB.prepare("SELECT publication_id FROM publications WHERE run_id = ?").bind(data.runId).first()).not.toBeNull();
    await purgeOldRuns(bindings, new Date(Date.parse(run!.expires_at) + 1));
    expect(r2.objects.has(objectKey)).toBe(false);
    expect(await bindings.DB.prepare("SELECT publication_id FROM publications WHERE run_id = ?").bind(data.runId).first()).toBeNull();
    expect(await bindings.DB.prepare("SELECT artifact_id FROM publication_manifest_artifacts WHERE artifact_id = ?")
      .bind("018f0000-0000-7000-8000-000000000082").first()).toBeNull();
  });

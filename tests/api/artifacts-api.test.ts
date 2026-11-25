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
  reconcileArtifactStorage,
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
  claimRun,
  startRunningRun,
  uploadArtifact,
  publicationManifest,
  registerPublicationInputs,
  completeExecution,
  withSupersededClaimOnNextBatch,
} = support;

beforeEach(clearDatabase);
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
    const persisted = await bindings.DB.prepare("SELECT artifact_type, artifact_schema_version, sha256, expires_at, producer_id FROM run_artifacts WHERE id = ?")
      .bind(artifactId).first<{ artifact_type: string; artifact_schema_version: number; sha256: string; expires_at: string; producer_id: string }>();
    const expectedDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("run summary\n"))),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    const runExpiry = await bindings.DB.prepare("SELECT expires_at FROM runs WHERE id = ?").bind(runId).first<{ expires_at: string }>();
    expect(persisted).toMatchObject({ artifact_type: "execution.report", artifact_schema_version: 1, sha256: expectedDigest, expires_at: runExpiry!.expires_at, producer_id: workerId });
    expect(r2.put).toHaveBeenCalledWith(
      `runs/${runId}/${artifactId}`,
      expect.any(Uint8Array),
      expect.objectContaining({ sha256: expect.any(Uint8Array), customMetadata: expect.objectContaining({ runId, artifactId, sha256: expectedDigest }) }),
    );

    const unauthorized = await callBinary(bindings, `/v1/runs/${runId}/artifacts/${artifactId}`);
    expect(unauthorized.response.status).toBe(401);
    const list = await call(bindings, `/v1/runs/${runId}/artifacts`, { token: CLIENT_TOKEN });
    expect(list.response.status).toBe(200);
    expect(list.body.data.artifacts).toEqual([expect.objectContaining({ id: artifactId, name: artifactName })]);
    const cacheWrites: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>) { cacheWrites.push(promise); },
      passThroughOnException() {},
    } as ExecutionContext;
    const download = await callBinary(bindings, `/v1/runs/${runId}/artifacts/${artifactId}`, { token: CLIENT_TOKEN }, context);
    await Promise.all(cacheWrites);
    expect(download.response.status).toBe(200);
    expect(download.response.headers.get("cache-control")).toBe("private, no-store");
    expect(download.response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"summary___filename__r_sum_.txt\"; filename*=UTF-8''summary%22%3B%20filename%3D%22r%C3%A9sum%C3%A9.txt",
    );
    expect(download.body).toBe("run summary\n");

    const unauthorizedAfterCacheFill = await callBinary(bindings, `/v1/runs/${runId}/artifacts/${artifactId}`);
    expect(unauthorizedAfterCacheFill.response.status).toBe(401);
    const repeatDownload = await callBinary(bindings, `/v1/runs/${runId}/artifacts/${artifactId}`, { token: CLIENT_TOKEN }, context);
    expect(repeatDownload.response.status).toBe(200);
    expect(repeatDownload.response.headers.get("cache-control")).toBe("private, no-store");
    expect(repeatDownload.body).toBe("run summary\n");
    expect(r2.get).toHaveBeenCalledTimes(1);

    await bindings.DB.prepare("UPDATE run_artifacts SET expires_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", artifactId).run();
    const expired = await callBinary(bindings, `/v1/runs/${runId}/artifacts/${artifactId}`, { token: CLIENT_TOKEN }, context);
    expect(expired.response.status).toBe(410);
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
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      event: "soyuz.artifact.upload", outcome: "rejected", status: 409, code: "WORKER_MISMATCH",
    }));
    diagnostic.mockRestore();
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

    await purgeExpiredArtifacts(bindings, new Date(Date.now() + 91 * 24 * 60 * 60 * 1_000));
    await purgeOldRuns(bindings, new Date(Date.now() + 91 * 24 * 60 * 60 * 1_000));

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
    const run = await bindings.DB.prepare("SELECT expires_at FROM runs WHERE id = ?").bind(runId).first<{ expires_at: string }>();
    const pendingRows = Array.from({ length: 100 }, (_, index) => {
      const artifactId = `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`;
      return bindings.DB.prepare(`
        INSERT INTO run_artifacts (id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state)
        VALUES (?, ?, 'other', 'pending.txt', 'text/plain', 1, ?, ?, ?, 'pending')
      `).bind(artifactId, runId, `runs/${runId}/${artifactId}`, now, run!.expires_at);
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
    await purgeOldRuns(bindings, new Date("2026-01-03T00:00:00.000Z"));

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
    await expect(purgeOldRuns(bindings, new Date("2026-01-03T00:00:00.000Z"))).resolves.toBe(0);
    const pending = await bindings.DB.prepare("SELECT object_key FROM artifact_deletion_queue WHERE object_key = ?").bind(objectKey).first();
    expect(pending).not.toBeNull();
    await purgeOldRuns(bindings, new Date("2026-01-04T00:00:00.000Z"));
    const row = await bindings.DB.prepare("SELECT object_key FROM artifact_deletion_queue WHERE object_key = ?").bind(objectKey).first();
    expect(row).toBeNull();
  });

  it("[ARTIFACTS-AGGREGATE-01] atomically rejects aggregate run storage above 100 MB", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const run = await bindings.DB.prepare("SELECT expires_at FROM runs WHERE id = ?").bind(runId).first<{ expires_at: string }>();
    const now = new Date().toISOString();
    const rows = Array.from({ length: 4 }, (_, index) => {
      const artifactId = `00000000-0000-4000-8000-${String(index + 600).padStart(12, "0")}`;
      return bindings.DB.prepare(`
        INSERT INTO run_artifacts (id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state)
        VALUES (?, ?, 'other', 'capacity.bin', 'application/octet-stream', 25000000, ?, ?, ?, 'pending')
      `).bind(artifactId, runId, `runs/${runId}/${artifactId}`, now, run!.expires_at);
    });
    await bindings.DB.batch(rows);
    const fifth = "00000000-0000-4000-8000-000000000699";
    await expect(bindings.DB.prepare(`
      INSERT INTO run_artifacts (id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state)
      VALUES (?, ?, 'other', 'capacity.bin', 'application/octet-stream', 1, ?, ?, ?, 'pending')
    `).bind(fifth, runId, `runs/${runId}/${fifth}`, now, run!.expires_at).run()).rejects.toThrow("ARTIFACT_AGGREGATE_LIMIT_REACHED");
  });

  it("[ARTIFACT-STORAGE-OBSERVABILITY-01] reports current usage and bounded upload rejections", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const run = await bindings.DB.prepare("SELECT expires_at FROM runs WHERE id = ?").bind(runId).first<{ expires_at: string }>();
    const artifactId = "00000000-0000-4000-8000-000000000710";
    await bindings.DB.prepare(`
      INSERT INTO run_artifacts (id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state, artifact_type, engine_id)
      VALUES (?, ?, 'report', 'summary.md', 'text/markdown', 7, ?, ?, ?, 'ready', 'execution.summary', 'kaseki-agent')
    `).bind(artifactId, runId, `runs/${runId}/${artifactId}`, new Date().toISOString(), run!.expires_at).run();

    const rejection = await callBinary(bindings, `/v1/worker/runs/${runId}/artifacts/00000000-0000-4000-8000-000000000711`, {
      method: "PUT", token: WORKER_TOKEN,
      headers: { "content-type": "text/plain", "content-length": "0" },
      body: "",
    });
    expect(rejection.response.status).toBe(413);

    const usage = await call(bindings, "/v1/storage-usage", { token: CLIENT_TOKEN });
    expect(usage.response.status).toBe(200);
    expect(usage.body.data).toMatchObject({
      retentionPolicyVersion: 1,
      maximumRetentionDays: 90,
      usage: {
        artifactCount: 1,
        totalBytes: 7,
        runCount: 1,
        byCategory: [{ category: "execution.summary", artifactCount: 1, totalBytes: 7 }],
        byExecutionEngine: [{ engineId: "kaseki-agent", artifactCount: 1, totalBytes: 7 }],
        growth: { successfulUploadsLast7Days: 0, bytesUploadedLast7Days: 0 },
        reconciliation: {},
        uploadRejections: [expect.objectContaining({ code: "413:ARTIFACT_TOO_LARGE", count: 1 })],
      },
      dryRunRetentionImpact: {
        expiredRuns: 0,
        expiredEvents: 0,
        expiredArtifacts: 0,
        expiredPublicationManifests: 0,
        expiredPublicationRecords: 0,
        expiredObjectReferences: 0,
        estimatedObjectBytes: 0,
        queuedObjectDeletions: 0,
        recordsWithInvalidExpiry: 0,
        recordsRequiringManualReconciliation: 0,
        recordsRequiringChecksumReconciliation: 1,
      },
    });
  });

  it("[ARTIFACT-RECON-01] queues old orphan R2 objects for the durable deletion worker", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const uploadedAt = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
    const objectKey = "runs/00000000-0000-4000-8000-000000000710/00000000-0000-4000-8000-000000000711";
    await r2.put(objectKey, await new Blob(["orphan"]).arrayBuffer(), { customMetadata: { createdAt: uploadedAt } });

    const result = await reconcileArtifactStorage(bindings);
    expect(result.orphanObjectsQueued).toBe(1);
    const queued = await bindings.DB.prepare("SELECT object_key FROM artifact_deletion_queue WHERE object_key = ?")
      .bind(objectKey).first();
    expect(queued).not.toBeNull();

    await purgeOldRuns(bindings);
    expect(r2.objects.has(objectKey)).toBe(false);
  });

  it("[ARTIFACT-RECON-02] marks missing R2 content and downgrades complete delivery", async () => {
    const r2 = memoryArtifactBucket();
    const { bindings } = testEnv({ artifacts: r2.bucket });
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const artifactId = "00000000-0000-4000-8000-000000000712";
    const run = await bindings.DB.prepare("SELECT expires_at FROM runs WHERE id = ?").bind(runId).first<{ expires_at: string }>();
    await bindings.DB.prepare("UPDATE runs SET artifact_delivery_status = 'complete' WHERE id = ?").bind(runId).run();
    await bindings.DB.prepare(`INSERT INTO run_artifacts (
      id, run_id, kind, name, content_type, size_bytes, object_key, created_at, expires_at, state,
      artifact_type, sha256, engine_id
    ) VALUES (?, ?, 'report', 'summary.md', 'text/markdown', 7, ?, ?, ?, 'ready', 'execution.summary', ?, 'kaseki-agent')`)
      .bind(artifactId, runId, `runs/${runId}/${artifactId}`, new Date().toISOString(), run!.expires_at, "a".repeat(64)).run();

    const result = await reconcileArtifactStorage(bindings);
    expect(result.missingObjects).toBe(1);
    const row = await bindings.DB.prepare("SELECT object_status FROM run_artifacts WHERE id = ?")
      .bind(artifactId).first<{ object_status: string }>();
    const persistedRun = await bindings.DB.prepare("SELECT artifact_delivery_status FROM runs WHERE id = ?")
      .bind(runId).first<{ artifact_delivery_status: string }>();
    expect(row?.object_status).toBe("missing");
    expect(persistedRun?.artifact_delivery_status).toBe("partial");
    const listed = await call(bindings, `/v1/runs/${runId}/artifacts`, { token: CLIENT_TOKEN });
    expect(listed.body.data.artifacts[0]).toMatchObject({ id: artifactId, available: false });
  });

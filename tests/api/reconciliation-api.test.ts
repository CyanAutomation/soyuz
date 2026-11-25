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
      summary: "The pre-agent validation command failed.",
      publishedUrl: "https://github.com/example/project/pull/7",
      changedFileCount: 0,
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
    expect(failure.body.data.result).toMatchObject({
      summary: failureBody.summary,
      publishedUrl: failureBody.publishedUrl,
      changedFileCount: failureBody.changedFileCount,
    });
    expect(retry.body.data.status).toBe("failed");
    expect(retry.body.data.result).toMatchObject({
      summary: failureBody.summary,
      publishedUrl: failureBody.publishedUrl,
      changedFileCount: failureBody.changedFileCount,
    });
    expect(stored).toMatchObject({
      status: "failed",
      exit_code: 1,
      failure_class: "validation_failed",
      failure_message: failureBody.failureMessage,
    });
    expect(JSON.parse(stored?.result_json ?? "null")).toMatchObject({
      summary: failureBody.summary,
      publishedUrl: failureBody.publishedUrl,
      changedFileCount: failureBody.changedFileCount,
    });
    const list = await call(bindings, "/v1/runs?limit=30", { token: CLIENT_TOKEN });
    expect(list.body.data.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: runId, failureClass: "validation_failed", failureMessage: failureBody.failureMessage }),
    ]));
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

    await bindings.DB.prepare("UPDATE runs SET result_json = ? WHERE id = ?")
      .bind(JSON.stringify({ publishedUrl: "javascript:alert(1)" }), runId).run();

    const read = await call(bindings, `/v1/runs/${runId}`, { token: CLIENT_TOKEN });
    expect(read.body.data.status).toBe("queued");
    expect(read.body.data.result.publishedUrl).toBeNull();
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
      "SELECT type, payload_json FROM run_events WHERE run_id = ? AND type = 'run.suspected_stalled'",
    ).bind(runId).first<{ type: string; payload_json: string }>();
    expect(stalledEvent?.type).toBe("run.suspected_stalled");
    const stalledPayload = JSON.parse(stalledEvent!.payload_json) as {
      observedAt: string;
      lastHeartbeatAt: string | null;
      startedAt: string | null;
      staleForMs: number;
    };
    const livenessAt = stalledPayload.lastHeartbeatAt ?? stalledPayload.startedAt!;
    expect(stalledPayload.staleForMs).toBe(Date.parse(stalledPayload.observedAt) - Date.parse(livenessAt));
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

  it("skips housekeeping updates for runs whose retention deadline has passed", async () => {
    const { bindings } = testEnv();
    const runId = await startRunningRun(
      bindings,
      "docker-host-retention-boundary",
      "00000000-0000-4000-8000-000000000071",
      "00000000-0000-4000-8000-000000000072",
    );
    const run = await bindings.DB.prepare("SELECT expires_at FROM runs WHERE id = ?")
      .bind(runId).first<{ expires_at: string }>();

    await reconcileStalledRuns(bindings, new Date(Date.parse(run!.expires_at) + 1));

    expect((await getRun(bindings.DB, runId))?.operational_health).toBe("healthy");
    expect(await countRunEvents(bindings, runId, "run.suspected_stalled")).toBe(0);
  });

  it("[RUN-LIVENESS-02] keeps a run suspect when its worker reports no active execution", async () => {
    const { bindings } = testEnv();
    const submitted = await submit(bindings, {}, "00000000-0000-4000-8000-000000000065");
    const runId = submitted.body.data.id as string;
    await claimRun(bindings, runId, "docker-host-idle");
    const started = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "00000000-0000-4000-8000-000000000066",
        workerId: "docker-host-idle",
      },
    });
    expect(started.response.status).toBe(200);

    const heartbeat = await call(bindings, `/v1/worker/runs/${runId}/events`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        eventId: "00000000-0000-4000-8000-000000000067",
        workerId: "docker-host-idle",
        type: "worker.heartbeat",
        payload: { hostHealthy: true, executionActive: false },
      },
    });

    expect(heartbeat.response.status).toBe(202);
    expect(await getRun(bindings.DB, runId)).toMatchObject({
      status: "running",
      operational_health: "suspect_stalled",
    });
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

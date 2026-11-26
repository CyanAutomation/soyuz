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
it("returns a retention response instead of a database error for a late worker callback", async () => {
  const { bindings } = testEnv();
  const id = "019b3000-0000-7000-8000-000000000091";
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 90 * 24 * 60 * 60 * 1_000).toISOString();
  const request = validRequest();
  await bindings.DB.prepare(`INSERT INTO runs (
    id, contract_version, repo_url, git_ref, status, task_mode, publish_mode,
    request_json, request_hash, created_at, updated_at, expires_at,
    correlation_id, request_id, worker_id, started_at
  ) VALUES (?, '1', ?, 'main', 'running', 'patch', 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, request.repoUrl, JSON.stringify(request), "a".repeat(64), createdAt, createdAt, expiresAt,
      "019b3000-0000-7000-8000-000000000092", "019b3000-0000-7000-8000-000000000093", "docker-host-expired", createdAt).run();

  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(expiresAt) + 1);
  let response;
  try {
    response = await call(bindings, `/v1/worker/runs/${id}/failed`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        callbackId: "019b3000-0000-7000-8000-000000000094",
        workerId: "docker-host-expired",
        failureClass: "validation_failed",
        failureMessage: "A late callback must be rejected cleanly.",
      },
    });
  } finally {
    vi.useRealTimers();
  }

  expect(response.response.status).toBe(410);
  expect(response.body.error.code).toBe("RUN_RETENTION_EXPIRED");
  expect((await getRun(bindings.DB, id))?.status).toBe("running");
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
      payload: { source: "pi-agent", publishedUrl: "javascript:alert(1)" },
    };
    const event = await call(bindings, `/v1/worker/runs/${runId}/events`, { method: "POST", token: WORKER_TOKEN, body: eventBody });
    expect(event.body.data.payload.publishedUrl).toBeNull();
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
    expect(eventList.body.data.events.find((entry: { eventId: string }) => entry.eventId === EVENT_ID).payload.publishedUrl).toBeNull();
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
      publishedUrl: "https://github.com/example/project/pull/7",
      outcomeSummary: {
        schemaVersion: 1,
        scorecard: {
          score: 87, grade: "B", rubricVersion: "scorecard-v2", completeness: "complete",
          confidence: 91, scoredAt: now,
        },
        evaluation: {
          assessment: "good", reviewerConfidence: "high", taskCompletionScore: 4,
          improvementCategories: [{ category: "validation", priority: "medium", count: 2 }],
        },
        phaseDurationMs: { coding: 120000, validation: 30000 },
      },
    };
    const unsafeCompleted = await call(bindings, `/v1/worker/runs/${runId}/completed`, {
      method: "POST", token: WORKER_TOKEN,
      body: { ...completedBody, callbackId: "00000000-0000-4000-8000-000000000016", publishedUrl: "javascript:alert(1)" },
    });
    expect(unsafeCompleted.response.status).toBe(422);
    expect(unsafeCompleted.body.error.code).toBe("INVALID_WORKER_CALLBACK");
    const completed = await call(bindings, `/v1/worker/runs/${runId}/completed`, {
      method: "POST", token: WORKER_TOKEN, body: completedBody,
    });
    const completedReplay = await call(bindings, `/v1/worker/runs/${runId}/completed`, {
      method: "POST", token: WORKER_TOKEN, body: completedBody,
    });
    expect(completed.response.status).toBe(200);
    expect(completed.body.data.status).toBe("completed");
    expect(completed.body.data.result.summary).toBe("Updated documentation.");
    expect(completed.body.data.result.publishedUrl).toBe("https://github.com/example/project/pull/7");
    expect(completed.body.data.result.outcomeSummary.scorecard).toMatchObject({ score: 87, grade: "B" });
    expect(completedReplay.body.data.status).toBe("completed");
    const storedProjection = await bindings.DB.prepare("SELECT outcome_summary_json FROM runs WHERE id = ?")
      .bind(runId).first<{ outcome_summary_json: string | null }>();
    expect(JSON.parse(storedProjection?.outcome_summary_json ?? "null")).toEqual(completedBody.outcomeSummary);

    await bindings.DB.prepare("UPDATE runs SET repo_url = ? WHERE id = ?")
      .bind("https://user:secret@github.com/example/project?token=private#details", runId).run();
    const outcomes = await call(bindings, "/v1/run-outcomes", { token: CLIENT_TOKEN });
    expect(outcomes.response.status).toBe(200);
    expect(outcomes.body.data).toMatchObject({
      scope: { retainedRuns: 1, includedRuns: 1, runsWithOutcomeSummary: 1 },
      byAssessment: { good: 1 },
      byGrade: { B: 1 },
      averageScore: 87,
      improvementCategories: [{ category: "validation", priority: "medium", count: 2 }],
      phaseDurations: [
        { phase: "coding", count: 1, averageMs: 120000 },
        { phase: "validation", count: 1, averageMs: 30000 },
      ],
      runs: [expect.objectContaining({ repoUrl: "https://github.com/example/project" })],
    });

    await bindings.DB.prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND type = 'run.completed'")
      .bind(JSON.stringify({ publishedUrl: "javascript:alert(1)" }), runId).run();
    const events = await call(bindings, `/v1/runs/${runId}/events?limit=20`, { token: CLIENT_TOKEN });
    const completionEvent = events.body.data.events.find((event: { type: string }) => event.type === "run.completed");
    expect(completionEvent.payload.publishedUrl).toBeNull();

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

    const cancellationBody = {
      contractVersion: "1",
      callbackId: "00000000-0000-4000-8000-000000000016",
      workerId,
      reason: "Cancellation observed by the execution host",
      summary: "The worker stopped after cancellation was applied.",
      publishedUrl: "https://github.com/example/project/pull/7",
      changedFileCount: 3,
    };
    const confirmed = await call(bindings, `/v1/worker/runs/${runId}/cancelled`, {
      method: "POST", token: WORKER_TOKEN,
      body: cancellationBody,
    });
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body.data.status).toBe("cancelled");
    expect(confirmed.body.data.result).toMatchObject({
      summary: cancellationBody.summary,
      publishedUrl: cancellationBody.publishedUrl,
      changedFileCount: cancellationBody.changedFileCount,
    });
    const stored = await getRun(bindings.DB, runId);
    expect(JSON.parse(stored?.result_json ?? "null")).toMatchObject({
      summary: cancellationBody.summary,
      publishedUrl: cancellationBody.publishedUrl,
      changedFileCount: cancellationBody.changedFileCount,
    });
  });

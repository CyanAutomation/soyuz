import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";
import { insertRun, getRun, RunTransitionError, transitionRun } from "../src/db/runs";
import { reconcileAdmissions } from "../src/queue/reconcile";

const CLIENT_TOKEN = "client-test-token-value-long-enough";
const WORKER_TOKEN = "worker-test-token-value-long-enough";
const CLIENT_KEY = "00000000-0000-4000-8000-000000000010";
const CALLBACK_ID = "00000000-0000-4000-8000-000000000011";
const EVENT_ID = "00000000-0000-4000-8000-000000000012";

type QueueMessage = { runId: string; contractVersion: string; [key: string]: unknown };

function testEnv(options: { queueFailure?: boolean } = {}) {
  const sent: QueueMessage[] = [];
  const send = vi.fn(async (message: unknown) => {
    if (options.queueFailure) throw new Error("simulated queue failure");
    sent.push(message as QueueMessage);
  });
  const bindings: Env = {
    DB: runtimeEnv.DB,
    RUN_QUEUE: { send } as unknown as Env["RUN_QUEUE"],
    CLIENT_API_TOKEN: CLIENT_TOKEN,
    WORKER_API_TOKEN: WORKER_TOKEN,
  };
  return { bindings, sent, send };
}

function apiRequest(
  path: string,
  options: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://soyuz.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function call(
  env: Env,
  path: string,
  options: Parameters<typeof apiRequest>[1] = {},
): Promise<{ response: Response; body: any }> {
  const response = await handleRequest(apiRequest(path, options), env);
  return { response, body: await response.json() };
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    repoUrl: "https://github.com/example/project",
    taskPrompt: "Update the project documentation and keep the API examples current.",
    ...overrides,
  };
}

async function clearDatabase(): Promise<void> {
  await runtimeEnv.DB.prepare("DELETE FROM run_events").run();
  await runtimeEnv.DB.prepare("DELETE FROM runs").run();
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

describe("Soyuz Worker API", () => {
  beforeEach(clearDatabase);

  it("keeps client and worker authentication separate and validates requests", async () => {
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

    const invalid = await call(bindings, "/v1/runs", {
      method: "POST",
      token: CLIENT_TOKEN,
      body: { repoUrl: "not a URL", taskPrompt: "short" },
    });
    expect(invalid.response.status).toBe(422);
    expect(invalid.body.error.code).toBe("INVALID_RUN_REQUEST");
  });

  it("reports missing server keys and rejects expired or rotated client keys clearly", async () => {
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

    const rotated = { ...bindings, CLIENT_API_TOKEN: "rotated-client-key-value-long-enough" };
    const expired = await call(rotated, "/v1/runs", { token: CLIENT_TOKEN });
    expect(expired.response.status).toBe(401);
    expect(expired.body.error.code).toBe("UNAUTHORIZED");
    expect(expired.body.error.message).toContain("expired");
    expect(expired.body.error.message).toContain("current client key");

    const rotatedWorker = { ...bindings, WORKER_API_TOKEN: "rotated-worker-key-value-long-enough" };
    const expiredWorker = await call(rotatedWorker, "/v1/worker/runs/00000000-0000-4000-8000-000000000013", {
      token: WORKER_TOKEN,
    });
    expect(expiredWorker.response.status).toBe(401);
    expect(expiredWorker.body.error.message).toContain("expired");
    expect(expiredWorker.body.error.message).toContain("current worker key");
  });

  it("explains when the run database endpoint is unavailable", async () => {
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

  it("persists accepted runs and publishes a versioned Queue message", async () => {
    const { bindings, sent } = testEnv();
    const { response, body } = await submit(bindings);
    expect(response.status).toBe(202);
    expect(body.data.status).toBe("queued");
    expect(body.data.contractVersion).toBe("1");
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
    expect(stored?.idempotency_key).toBe(CLIENT_KEY);
    expect(stored?.queued_at).toBeTruthy();

    const workerState = await call(bindings, `/v1/worker/runs/${body.data.id}`, { token: WORKER_TOKEN });
    expect(workerState.response.status).toBe(200);
    expect(workerState.body.data.status).toBe("queued");
    const clientCannotPollAsWorker = await call(bindings, `/v1/worker/runs/${body.data.id}`, { token: CLIENT_TOKEN });
    expect(clientCannotPollAsWorker.response.status).toBe(401);
  });

  it("returns the existing run for equivalent idempotent submissions and rejects key reuse", async () => {
    const { bindings, sent } = testEnv();
    const first = await call(bindings, "/v1/runs", {
      method: "POST",
      token: CLIENT_TOKEN,
      body: validRequest({ idempotencyKey: CLIENT_KEY.toUpperCase() }),
    });
    const replay = await submit(bindings);
    expect(first.response.status).toBe(202);
    expect(replay.response.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(sent).toHaveLength(1);

    const conflict = await submit(bindings, { taskPrompt: "Use the same idempotency key with different work." });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(sent).toHaveLength(1);
  });

  it("retries ambiguous Queue publication failures before marking admission_failed", async () => {
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

  it("records started, operational, and terminal worker callbacks idempotently", async () => {
    const { bindings } = testEnv();
    const created = await submit(bindings);
    const runId = created.body.data.id as string;
    const workerId = "docker-host-a";
    const now = new Date().toISOString();

    const firstClaim = await claimRun(bindings, runId, workerId);
    const claimReplay = await claimRun(bindings, runId, workerId);
    const competingClaim = await claimRun(bindings, runId, "docker-host-b", "00000000-0000-4000-8000-000000000031");
    expect(firstClaim.body.data.status).toBe("claimed");
    expect(claimReplay.response.status).toBe(200);
    expect(competingClaim.response.status).toBe(409);

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
    const startedReplay = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN, body: startedBody,
    });
    expect(started.response.status).toBe(200);
    expect(started.body.data.status).toBe("running");
    expect(startedReplay.body.data.status).toBe("running");

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

    const eventList = await call(bindings, `/v1/runs/${runId}/events?limit=20`, { token: CLIENT_TOKEN });
    expect(eventList.response.status).toBe(200);
    expect(eventList.body.data.events.filter((entry: { eventId: string }) => entry.eventId === EVENT_ID)).toHaveLength(1);

    const lateStart = await call(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN, body: { ...startedBody, callbackId: "00000000-0000-4000-8000-000000000015" },
    });
    expect(lateStart.response.status).toBe(409);
  });

  it("records queued cancellation and rejects a late start", async () => {
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

  it("keeps a running cancellation pending until the worker confirms it", async () => {
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

  it("records worker failure and accepts an exact callback retry", async () => {
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
    expect(failure.response.status).toBe(200);
    expect(failure.body.data.status).toBe("failed");
    expect(failure.body.data.failureClass).toBe("validation_failed");
    expect(retry.body.data.status).toBe("failed");
  });

  it("does not apply a stale pre-start cancellation after the run starts", async () => {
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

    const cancellation = await call(bindings, `/v1/runs/${runId}/cancel`, {
      method: "POST",
      token: CLIENT_TOKEN,
    });
    expect(cancellation.body.data.status).toBe("cancel_requested");
  });

  it("lists runs, returns canonical state, and reports unknown IDs", async () => {
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

  it("reconciles a stale admitting run with the same run ID", async () => {
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

  it("expires an abandoned worker claim and republishes the same run ID", async () => {
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

  it("commits only one terminal event when worker outcomes race", async () => {
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
});

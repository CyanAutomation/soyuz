import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";
import type { QueuedRun } from "../src/contracts/queue-message";
import {
  KasekiProtocolSimulator,
  KasekiQueueLeaseHarness,
  requireWorkerRunData,
  type KasekiJobIntent,
} from "./support/kaseki-protocol-simulator";

const CLIENT_TOKEN = "client-kaseki-test-token-value-long-enough";
const KASEKI_TOKEN = "kaseki-submit-test-token-value-long-enough";
const WORKER_TOKEN = "worker-kaseki-test-token-value-long-enough";

function testEnv() {
  const messages: QueuedRun[] = [];
  const bindings: Env = {
    DB: runtimeEnv.DB,
    RUN_QUEUE: {
      send: async (message: unknown) => { messages.push(message as QueuedRun); },
    } as unknown as Env["RUN_QUEUE"],
    OAUTH_REGISTRATION_LIMITER: { limit: async () => ({ success: true }) } as Env["OAUTH_REGISTRATION_LIMITER"],
    OPENUI_GENERATION_LIMITER: { limit: async () => ({ success: true }) } as Env["OPENUI_GENERATION_LIMITER"],
    CLIENT_API_TOKEN: CLIENT_TOKEN,
    KASEKI_SUBMISSION_API_TOKEN: KASEKI_TOKEN,
    KASEKI_SUBMISSION_IDENTITY: "kaseki-test-host",
    WORKER_API_TOKEN: WORKER_TOKEN,
  };
  return { bindings, messages };
}

async function request(
  env: Env,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ response: Response; body: any }> {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await handleRequest(new Request(`https://soyuz.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), env);
  return { response, body: await response.json() };
}

async function submitRun(env: Env) {
  return request(env, "/v1/runs", {
    method: "POST",
    token: KASEKI_TOKEN,
    body: {
      repoUrl: "https://github.com/example/kaseki-test",
      taskPrompt: "Update the README with the local test endpoint.",
      publishMode: "none",
      idempotencyKey: crypto.randomUUID(),
    },
  });
}

function queueLease(body: unknown, leaseId: string, attempts = 1) {
  return {
    id: "soyuz-queue-message-1",
    lease_id: leaseId,
    timestamp_ms: Date.now(),
    attempts,
    body,
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

async function countEvents(env: Env, runId: string, type: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND type = ?")
    .bind(runId, type).first<{ count: number }>();
  return row?.count ?? 0;
}

describe("Kaseki protocol simulator", () => {
  beforeEach(clearDatabase);

  it("[KASEKI-HANDOFF-01/KASEKI-RECOVERY-01] replays queue delivery and callbacks across a simulated host restart", async () => {
    const { bindings, messages } = testEnv();
    const submitted = await submitRun(bindings);
    expect(submitted.response.status).toBe(202);
    expect(messages).toHaveLength(1);

    const message = messages[0];
    expect(message).toMatchObject({
      contractVersion: "1",
      runId: submitted.body.data.id,
      request: {
        repoUrl: "https://github.com/example/kaseki-test",
        ref: "main",
        taskMode: "patch",
        publishMode: "none",
      },
    });

    const durableIntents = new Map<string, KasekiJobIntent>();
    const queue = new KasekiQueueLeaseHarness();
    const firstHost = new KasekiProtocolSimulator(bindings, "kaseki-test-worker", durableIntents);
    const firstDelivery = await firstHost.consume(queueLease(message, "lease-1"), queue, {
      loseFirstClaimResponse: true,
      stopAfterClaim: true,
    });
    expect(firstDelivery).toMatchObject({ disposition: "retried", status: "claimed" });
    expect(queue.actions).toEqual([{
      type: "retry",
      id: "soyuz-queue-message-1",
      leaseId: "lease-1",
      delaySeconds: 10,
    }]);
    expect(durableIntents.get(message.runId)).toMatchObject({
      localJobPersisted: false,
      startAuthorized: false,
    });
    expect(await countEvents(bindings, message.runId, "run.claimed")).toBe(1);
    expect(await countEvents(bindings, message.runId, "run.started")).toBe(0);

    const restartedHost = new KasekiProtocolSimulator(bindings, "kaseki-test-worker", durableIntents);
    const recovered = await restartedHost.consume(queueLease(message, "lease-2", 2), queue);
    const duplicateDelivery = await restartedHost.consume(queueLease(message, "lease-3", 3), queue);
    expect(recovered).toMatchObject({
      runId: message.runId,
      status: "running",
      disposition: "acknowledged",
      startAuthorized: true,
    });
    expect(duplicateDelivery).toMatchObject({
      runId: message.runId,
      status: "running",
      disposition: "acknowledged",
      startAuthorized: true,
      intent: {
        claimCallbackId: firstDelivery.intent?.claimCallbackId,
        startedCallbackId: firstDelivery.intent?.startedCallbackId,
      },
    });
    expect(queue.actions.map(({ type }) => type)).toEqual(["retry", "ack", "ack"]);
    expect(durableIntents.size).toBe(1);
    expect(await countEvents(bindings, message.runId, "run.claimed")).toBe(1);
    expect(await countEvents(bindings, message.runId, "run.started")).toBe(1);
    const startRequests = restartedHost.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/started"));
    expect(startRequests).toHaveLength(1);
    expect((startRequests[0].body as Record<string, unknown>).callbackId)
      .toBe(firstDelivery.intent?.startedCallbackId);

    await restartedHost.sendHeartbeat(message.runId);
    await restartedHost.sendHeartbeat(message.runId);
    expect(await countEvents(bindings, message.runId, "worker.heartbeat")).toBe(1);

    await restartedHost.complete(message.runId, "README updated.");
    await restartedHost.complete(message.runId, "README updated.");
    expect(await countEvents(bindings, message.runId, "run.completed")).toBe(1);
    await expect(restartedHost.consume(queueLease(message, "lease-4", 4), queue))
      .resolves.toMatchObject({ status: "completed", disposition: "acknowledged" });
    expect(firstHost.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/claim"))).toHaveLength(2);
    expect(restartedHost.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/claim"))).toHaveLength(1);

    const finalRun = await request(bindings, `/v1/runs/${message.runId}`, { token: CLIENT_TOKEN });
    expect(finalRun.body.data).toMatchObject({
      status: "completed",
      origin: { type: "kaseki", id: "kaseki-test-host" },
      result: { summary: "README updated." },
    });
  });

  it("[KASEKI-CANCEL-POLL-01] observes canonical cancellation and confirms it after worker cleanup", async () => {
    const { bindings, messages } = testEnv();
    await submitRun(bindings);
    const message = messages[0];
    const host = new KasekiProtocolSimulator(bindings, "kaseki-test-worker");
    const queue = new KasekiQueueLeaseHarness();
    await expect(host.consume(queueLease(message, "lease-1"), queue))
      .resolves.toMatchObject({ disposition: "acknowledged", startAuthorized: true });

    const cancellation = await request(bindings, `/v1/runs/${message.runId}/cancel`, {
      method: "POST",
      token: KASEKI_TOKEN,
    });
    expect(cancellation.body.data.status).toBe("cancel_requested");

    await expect(host.pollAndConfirmCancellation(message.runId)).resolves.toBe(true);
    await expect(host.pollAndConfirmCancellation(message.runId)).resolves.toBe(false);
    expect(await countEvents(bindings, message.runId, "run.cancelled")).toBe(1);

    const finalRun = await request(bindings, `/v1/runs/${message.runId}`, { token: CLIENT_TOKEN });
    expect(finalRun.body.data.status).toBe("cancelled");
  });

  it("[KASEKI-SIMULATOR-01] rejects unsupported Queue contract versions before calling Soyuz", async () => {
    const { bindings } = testEnv();
    const host = new KasekiProtocolSimulator(bindings, "kaseki-test-worker");
    const queue = new KasekiQueueLeaseHarness();

    await expect(host.consume(queueLease({ contractVersion: "2" }, "lease-invalid"), queue))
      .resolves.toMatchObject({ disposition: "retried", error: "Unsupported Soyuz contract version: 2." });
    expect(queue.actions).toEqual([{
      type: "retry",
      id: "soyuz-queue-message-1",
      leaseId: "lease-invalid",
      delaySeconds: 10,
    }]);
    expect(host.requests).toHaveLength(0);
  });

  it("[KASEKI-START-AUTH-RECOVERY-01] retries after started commits but before durable start authorization, then recovers without duplicate start events", async () => {
    const { bindings, messages } = testEnv();
    await submitRun(bindings);
    const message = messages[0];
    const durableIntents = new Map<string, KasekiJobIntent>();
    const queue = new KasekiQueueLeaseHarness();
    const firstHost = new KasekiProtocolSimulator(bindings, "kaseki-test-worker", durableIntents);

    const interrupted = await firstHost.consume(queueLease(message, "lease-start-1"), queue, {
      stopAfterStartedBeforeAuthorization: true,
    });
    expect(interrupted).toMatchObject({ disposition: "retried", status: "running" });
    expect(durableIntents.get(message.runId)).toMatchObject({
      localJobPersisted: true,
      startedCallbackSent: true,
      startAuthorized: false,
    });
    expect(await countEvents(bindings, message.runId, "run.started")).toBe(1);

    const restartedHost = new KasekiProtocolSimulator(bindings, "kaseki-test-worker", durableIntents);
    const recovered = await restartedHost.consume(queueLease(message, "lease-start-2", 2), queue);
    expect(recovered).toMatchObject({ disposition: "acknowledged", status: "running", startAuthorized: true });
    expect(durableIntents.get(message.runId)).toMatchObject({
      localJobPersisted: true,
      startedCallbackSent: true,
      startAuthorized: true,
    });
    const startedRequests = restartedHost.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/started"));
    expect(startedRequests).toHaveLength(1);
    expect((startedRequests[0].body as Record<string, unknown>).callbackId)
      .toBe(durableIntents.get(message.runId)?.startedCallbackId);
    expect(await countEvents(bindings, message.runId, "run.started")).toBe(1);
    expect(queue.actions.map(({ type }) => type)).toEqual(["retry", "ack"]);
  });

  it("[KASEKI-ACK-RECOVERY-01] treats a lost acknowledgement response as uncertain and deduplicates the redelivery by run ID", async () => {
    const { bindings, messages } = testEnv();
    await submitRun(bindings);
    const message = messages[0];
    const durableIntents = new Map<string, KasekiJobIntent>();
    const queue = new KasekiQueueLeaseHarness();
    const firstHost = new KasekiProtocolSimulator(bindings, "kaseki-test-worker", durableIntents);

    const first = await firstHost.consume(queueLease(message, "lease-ack-1"), queue, { loseAckResponse: true });
    expect(first).toMatchObject({ disposition: "ack-uncertain", status: "running", startAuthorized: true });
    expect(queue.actions).toEqual([{
      type: "ack",
      id: "soyuz-queue-message-1",
      leaseId: "lease-ack-1",
      responseLost: true,
    }]);

    const restartedHost = new KasekiProtocolSimulator(bindings, "kaseki-test-worker", durableIntents);
    const replay = await restartedHost.consume(queueLease(message, "lease-ack-2", 2), queue);
    expect(replay).toMatchObject({ disposition: "acknowledged", status: "running", startAuthorized: true });
    expect(durableIntents.size).toBe(1);
    expect(restartedHost.requests.filter((entry) => entry.method === "POST")).toHaveLength(0);
    expect(await countEvents(bindings, message.runId, "run.claimed")).toBe(1);
    expect(await countEvents(bindings, message.runId, "run.started")).toBe(1);
    expect(queue.actions.map(({ type }) => type)).toEqual(["ack", "ack"]);
  });

  it("[KASEKI-SIMULATOR-DATA-01] rejects successful worker responses without an object data envelope", () => {
    const error = "Soyuz worker read returned a 2xx response without valid run data.";
    expect(() => requireWorkerRunData(undefined)).toThrow(error);
    expect(() => requireWorkerRunData(null)).toThrow(error);
    expect(() => requireWorkerRunData([])).toThrow(error);
    expect(() => requireWorkerRunData({})).toThrow(error);
    expect(() => requireWorkerRunData({ runId: "run-id" })).toThrow(error);
    expect(requireWorkerRunData({ runId: "run-id", status: "running" }))
      .toEqual({ runId: "run-id", status: "running" });
  });
});

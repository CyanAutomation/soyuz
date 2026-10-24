import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";
import type { QueuedRun } from "../src/contracts/queue-message";
import { KasekiProtocolSimulator, type KasekiJobIntent } from "./support/kaseki-protocol-simulator";

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
    const firstHost = new KasekiProtocolSimulator(bindings, "kaseki-test-worker", durableIntents);
    const firstDelivery = await firstHost.deliver(message, {
      loseFirstClaimResponse: true,
      stopAfterClaim: true,
    });
    expect(firstDelivery.status).toBe("claimed");
    expect(await countEvents(bindings, message.runId, "run.claimed")).toBe(1);
    expect(await countEvents(bindings, message.runId, "run.started")).toBe(0);

    const restartedHost = new KasekiProtocolSimulator(bindings, "kaseki-test-worker", durableIntents);
    const recovered = await restartedHost.deliver(message);
    const duplicateDelivery = await restartedHost.deliver(message);
    expect(recovered).toMatchObject({ runId: message.runId, status: "running" });
    expect(duplicateDelivery).toMatchObject({
      runId: message.runId,
      status: "running",
      claimCallbackId: firstDelivery.claimCallbackId,
      startedCallbackId: firstDelivery.startedCallbackId,
    });
    expect(await countEvents(bindings, message.runId, "run.claimed")).toBe(1);
    expect(await countEvents(bindings, message.runId, "run.started")).toBe(1);
    const startRequests = restartedHost.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/started"));
    expect(startRequests).toHaveLength(2);
    expect(startRequests.map((entry) => (entry.body as Record<string, unknown>).claimCallbackId))
      .toEqual([firstDelivery.claimCallbackId, firstDelivery.claimCallbackId]);

    await restartedHost.sendHeartbeat(message.runId);
    await restartedHost.sendHeartbeat(message.runId);
    expect(await countEvents(bindings, message.runId, "worker.heartbeat")).toBe(1);

    await restartedHost.complete(message.runId, "README updated.");
    await restartedHost.complete(message.runId, "README updated.");
    expect(await countEvents(bindings, message.runId, "run.completed")).toBe(1);
    await expect(restartedHost.deliver(message)).resolves.toMatchObject({ status: "completed" });
    expect(firstHost.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/claim"))).toHaveLength(2);
    expect(restartedHost.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/claim"))).toHaveLength(2);

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
    await host.deliver(message);

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

    await expect(host.deliver({ contractVersion: "2" })).rejects.toThrow("Unsupported Soyuz contract version");
    expect(host.requests).toHaveLength(0);
  });
});

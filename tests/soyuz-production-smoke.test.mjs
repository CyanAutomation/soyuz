import { describe, expect, it, vi } from "vitest";
import { runProductionSmoke, SoyuzSmokeError } from "../scripts/soyuz-production-smoke.mjs";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const BASE_URL = "https://soyuz.example.test";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const QUEUE_ID = "abcdef0123456789abcdef0123456789";

function env(overrides = {}) {
  return {
    SOYUZ_BASE_URL: BASE_URL,
    CLIENT_API_TOKEN: "client-secret-long-enough",
    SOYUZ_WORKER_API_TOKEN: "worker-secret-long-enough",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    SOYUZ_QUEUE_ID: QUEUE_ID,
    SOYUZ_QUEUE_API_TOKEN: "queue-secret-long-enough",
    DISPOSABLE_REPO_URL: "https://github.com/example/disposable-smoke-repo",
    SMOKE_IDEMPOTENCY_KEY: "22222222-2222-4222-8222-222222222222",
    SOYUZ_SMOKE_ACK_EXECUTION: "yes",
    SOYUZ_SMOKE_TIMEOUT_SECONDS: "60",
    SOYUZ_SMOKE_MAX_WAIT_SECONDS: "90",
    SOYUZ_SMOKE_POLL_INTERVAL_MS: "1000",
    ...overrides,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetch({ activeStatus, queueMessages = [], consumers, runStatuses = ["queued", "completed"] } = {}) {
  const calls = [];
  let runStatusIndex = 0;
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers: init.headers, body });

    if (url.origin === BASE_URL && url.pathname === "/health") {
      return json({ status: "ok", contractVersion: "1" });
    }
    if (url.origin === BASE_URL && url.pathname === "/v1/runs" && method === "GET") {
      const runs = activeStatus === url.searchParams.get("status") ? [{ id: RUN_ID, status: activeStatus }] : [];
      return json({ data: { runs, nextCursor: null } });
    }
    if (url.origin === BASE_URL && url.pathname === "/v1/runs" && method === "POST") {
      return json({ data: { id: RUN_ID, status: "queued" } }, 202);
    }
    if (url.origin === BASE_URL && url.pathname === `/v1/runs/${RUN_ID}` && method === "GET") {
      const status = runStatuses[Math.min(runStatusIndex, runStatuses.length - 1)];
      runStatusIndex += 1;
      return json({ data: { id: RUN_ID, status, publishMode: "none", result: null } });
    }
    if (url.origin === BASE_URL && url.pathname === `/v1/worker/runs/${RUN_ID}` && method === "GET") {
      return json({ data: { runId: RUN_ID, status: runStatuses[Math.min(runStatusIndex - 1, runStatuses.length - 1)] } });
    }
    if (url.origin === BASE_URL && url.pathname === `/v1/runs/${RUN_ID}/events` && method === "GET") {
      return json({ data: { events: [
        { type: "run.started" },
        { type: "run.completed" },
      ] } });
    }
    if (url.origin === "https://api.cloudflare.com" && url.pathname.endsWith("/consumers") && method === "GET") {
      return json({ success: true, result: consumers ?? [{ type: "http_pull", dead_letter_queue: "soyuz-runs-dlq" }] });
    }
    if (url.origin === "https://api.cloudflare.com" && url.pathname.endsWith("/messages/peek") && method === "POST") {
      return json({ success: true, result: { messages: queueMessages } });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  return { fetchImpl, calls };
}

describe("production Soyuz smoke check", () => {
  it("checks health, active runs, Queue consumer/DLQ, and a non-leasing peek without submitting work by default", async () => {
    const { fetchImpl, calls } = createFetch();

    await expect(runProductionSmoke({ env: env(), fetchImpl })).resolves.toMatchObject({
      status: "preflight_passed",
      visibleQueueMessages: 0,
    });
    expect(calls.some((call) => call.method === "POST" && call.url.pathname === "/v1/runs")).toBe(false);
    expect(calls.find((call) => call.url.pathname.endsWith("/messages/peek"))?.body).toEqual({ batch_size: 10 });
  });

  it("blocks execution when active canonical runs exist", async () => {
    const { fetchImpl, calls } = createFetch({ activeStatus: "running" });

    await expect(runProductionSmoke({ env: env(), fetchImpl, execute: true })).rejects.toMatchObject({
      code: "ACTIVE_RUNS_PRESENT",
    });
    expect(calls.some((call) => call.method === "POST" && call.url.pathname === "/v1/runs")).toBe(false);
  });

  it("blocks execution when Queue messages are already visible", async () => {
    const { fetchImpl, calls } = createFetch({ queueMessages: [{ id: "opaque-message-id" }] });

    await expect(runProductionSmoke({ env: env(), fetchImpl, execute: true })).rejects.toMatchObject({
      code: "QUEUE_NOT_EMPTY",
    });
    expect(calls.some((call) => call.method === "POST" && call.url.pathname === "/v1/runs")).toBe(false);
  });

  it("requires an HTTP pull consumer with a dead-letter queue", async () => {
    const { fetchImpl } = createFetch({ consumers: [{ type: "http_pull", dead_letter_queue: "" }] });

    await expect(runProductionSmoke({ env: env(), fetchImpl })).rejects.toMatchObject({
      code: "QUEUE_CONSUMER_UNSAFE",
    });
  });

  it("rejects tokens with leading or trailing whitespace instead of silently changing them", async () => {
    await expect(runProductionSmoke({
      env: env({ CLIENT_API_TOKEN: " client-secret-long-enough " }),
      fetchImpl: createFetch().fetchImpl,
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("cancels an oversized response as soon as its byte limit is exceeded", async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_001));
      },
      cancel() {
        cancelled = true;
      },
    })));

    await expect(runProductionSmoke({ env: env(), fetchImpl })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(cancelled).toBe(true);
  });

  it("requires an explicit execution acknowledgement before submitting work", async () => {
    const { fetchImpl, calls } = createFetch();

    await expect(runProductionSmoke({
      env: env({ SOYUZ_SMOKE_ACK_EXECUTION: "" }),
      fetchImpl,
      execute: true,
    })).rejects.toBeInstanceOf(SoyuzSmokeError);
    expect(calls.some((call) => call.method === "POST" && call.url.pathname === "/v1/runs")).toBe(false);
  });

  it("submits a bounded inspect-only run with idempotency and verifies terminal callbacks", async () => {
    const { fetchImpl, calls } = createFetch();
    let now = 0;

    await expect(runProductionSmoke({
      env: env(),
      fetchImpl,
      execute: true,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      log: () => undefined,
    })).resolves.toMatchObject({ status: "completed", runId: RUN_ID });

    const submission = calls.find((call) => call.method === "POST" && call.url.pathname === "/v1/runs");
    expect(submission?.body).toMatchObject({
      repoUrl: "https://github.com/example/disposable-smoke-repo",
      taskMode: "inspect",
      publishMode: "none",
      timeoutSeconds: 60,
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });
    expect(submission?.headers).toMatchObject({ authorization: "Bearer client-secret-long-enough" });
  });

  it("reports timeout with the run ID and never cancels automatically", async () => {
    const { fetchImpl, calls } = createFetch({ runStatuses: ["queued"] });
    let now = 0;

    await expect(runProductionSmoke({
      env: env({ SOYUZ_SMOKE_MAX_WAIT_SECONDS: "60" }),
      fetchImpl,
      execute: true,
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
      log: () => undefined,
    })).resolves.toMatchObject({ status: "timed_out", runId: RUN_ID });
    expect(calls.some((call) => call.url.pathname.endsWith("/cancel"))).toBe(false);
  });
});

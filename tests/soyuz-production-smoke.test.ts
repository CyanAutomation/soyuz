import { describe, expect, it, vi } from "vitest";
import { runProductionSmoke, runSmokeCli, SoyuzSmokeError } from "../scripts/soyuz-production-smoke.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const BASE_URL = "https://soyuz.example.test";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const QUEUE_ID = "abcdef0123456789abcdef0123456789";

type SmokeEnvironment = Record<string, string | undefined>;

interface MockRequest {
  url: URL;
  method: string;
  headers: RequestInit["headers"] | undefined;
  body: unknown;
}

interface MockRoute {
  matches(request: MockRequest): boolean;
  respond(request: MockRequest): Response;
}

interface CreateFetchOptions {
  activeStatus?: string;
  queueMessages?: unknown[];
  consumers?: unknown[];
  runStatuses?: string[];
}

function env(overrides: SmokeEnvironment = {}): SmokeEnvironment {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetch({
  activeStatus,
  queueMessages = [],
  consumers,
  runStatuses = ["queued", "completed"],
}: CreateFetchOptions = {}) {
  const calls: MockRequest[] = [];
  const state = { runStatusIndex: 0 };
  const routes: MockRoute[] = [
    exactRoute(BASE_URL, "/health", "GET", () => json({ status: "ok", contractVersion: "1" })),
    exactRoute(BASE_URL, "/v1/runs", "GET", (request) => activeRunsResponse(request, activeStatus)),
    exactRoute(BASE_URL, "/v1/runs", "POST", () => json({ data: { id: RUN_ID, status: "queued" } }, 202)),
    exactRoute(BASE_URL, `/v1/runs/${RUN_ID}`, "GET", () => canonicalRunResponse(runStatuses, state)),
    exactRoute(BASE_URL, `/v1/worker/runs/${RUN_ID}`, "GET", () => workerRunResponse(runStatuses, state)),
    exactRoute(BASE_URL, `/v1/runs/${RUN_ID}/events`, "GET", () => json({ data: { events: [
      { type: "run.started" },
      { type: "run.completed" },
    ] } })),
    suffixRoute("https://api.cloudflare.com", "/consumers", "GET", () => json({
      success: true,
      result: consumers ?? [{ type: "http_pull", dead_letter_queue: "soyuz-runs-dlq", settings: { max_retries: 3 } }],
    })),
    suffixRoute("https://api.cloudflare.com", "/messages/peek", "POST", () => json({
      success: true,
      result: { messages: queueMessages },
    })),
  ];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => dispatchMockFetch(input, init ?? {}, calls, routes));
  return { fetchImpl, calls };
}

function exactRoute(
  origin: string,
  pathname: string,
  method: string,
  respond: (request: MockRequest) => Response,
): MockRoute {
  return { matches: (request) => request.url.origin === origin && request.url.pathname === pathname && request.method === method, respond };
}

function suffixRoute(
  origin: string,
  pathnameSuffix: string,
  method: string,
  respond: (request: MockRequest) => Response,
): MockRoute {
  return { matches: (request) => request.url.origin === origin && request.url.pathname.endsWith(pathnameSuffix) && request.method === method, respond };
}

function activeRunsResponse(request: MockRequest, activeStatus: string | undefined): Response {
  const requestedStatus = request.url.searchParams.get("status");
  const runs = activeStatus === requestedStatus ? [{ id: RUN_ID, status: activeStatus }] : [];
  return json({ data: { runs, nextCursor: null } });
}

function canonicalRunResponse(runStatuses: string[], state: { runStatusIndex: number }): Response {
  const status = runStatuses[Math.min(state.runStatusIndex, runStatuses.length - 1)];
  state.runStatusIndex += 1;
  return json({ data: { id: RUN_ID, status, publishMode: "none", result: null } });
}

function workerRunResponse(runStatuses: string[], state: { runStatusIndex: number }): Response {
  const status = runStatuses[Math.min(state.runStatusIndex - 1, runStatuses.length - 1)];
  return json({ data: { runId: RUN_ID, status } });
}

function dispatchMockFetch(
  input: string | URL | Request,
  init: RequestInit,
  calls: MockRequest[],
  routes: MockRoute[],
): Response {
  const request = readMockRequest(input, init);
  calls.push(request);
  const route = routes.find((candidate) => candidate.matches(request));
  if (!route) throw new Error(`Unexpected request ${request.method} ${request.url}`);
  return route.respond(request);
}

function readMockRequest(input: string | URL | Request, init: RequestInit): MockRequest {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  return { url, method, headers: init.headers, body };
}

describe("production Soyuz smoke check", () => {
  it("[DEPLOY-SMOKE-CLI-01] validates CLI arguments and returns the corresponding exit code", async () => {
    const writeError = vi.fn();
    const run = vi.fn(async () => ({ status: "preflight_passed" }));

    await expect(runSmokeCli(["--unknown"], { run, writeError })).resolves.toBe(2);
    await expect(runSmokeCli(["--run", "--run"], { run, writeError })).resolves.toBe(2);
    await expect(runSmokeCli([], { run, writeError })).resolves.toBe(0);
    await expect(runSmokeCli(["--run"], { run: async () => ({ status: "timed_out" }), writeError })).resolves.toBe(1);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ execute: false });
    expect(writeError).toHaveBeenCalledTimes(2);
    expect(writeError).toHaveBeenCalledWith("Usage: node scripts/soyuz-production-smoke.ts [--run]");
  });

  it("[DEPLOY-SMOKE-CLI-01] reports bounded and unexpected CLI failures with a failing exit code", async () => {
    const writeError = vi.fn();

    await expect(runSmokeCli([], {
      run: async () => { throw new SoyuzSmokeError("CONFIG_INVALID", "Invalid smoke configuration."); },
      writeError,
    })).resolves.toBe(1);
    await expect(runSmokeCli([], {
      run: async () => { throw new Error("sensitive upstream detail"); },
      writeError,
    })).resolves.toBe(1);

    expect(writeError).toHaveBeenNthCalledWith(1, "Soyuz smoke check failed (CONFIG_INVALID): Invalid smoke configuration.");
    expect(writeError).toHaveBeenNthCalledWith(2, "Soyuz smoke check failed (UNEXPECTED_ERROR): The smoke check stopped unexpectedly.");
  });

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

  it("requires the HTTP pull consumer to have a finite retry limit", async () => {
    const { fetchImpl } = createFetch({ consumers: [{ type: "http_pull", dead_letter_queue: "soyuz-runs-dlq", settings: {} }] });

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

  it("rejects an unsafe service URL before making readiness requests", async () => {
    const fetchImpl = vi.fn();

    await expect(runProductionSmoke({
      env: env({ SOYUZ_BASE_URL: "http://soyuz.example.test" }),
      fetchImpl,
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(fetchImpl).not.toHaveBeenCalled();
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

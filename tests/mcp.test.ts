import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";

const CLIENT_TOKEN = "client-mcp-test-token-value-long-enough";
const WORKER_TOKEN = "worker-mcp-test-token-value-long-enough";
const MCP_VERSION = "2025-03-26";
const MCP_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-protocol-version": MCP_VERSION,
};

type SentMessage = { runId: string; contractVersion: string; request: Record<string, unknown> };

function testEnv(options: { queueFailure?: boolean } = {}) {
  const sent: SentMessage[] = [];
  const send = vi.fn(async (message: unknown) => {
    if (options.queueFailure) throw new Error("simulated Queue publication failure");
    sent.push(message as SentMessage);
  });
  const bindings: Env = {
    DB: runtimeEnv.DB,
    RUN_QUEUE: { send } as unknown as Env["RUN_QUEUE"],
    CLIENT_API_TOKEN: CLIENT_TOKEN,
    WORKER_API_TOKEN: WORKER_TOKEN,
  };
  return { bindings, sent, send };
}

function request(path: string, body: unknown, token = CLIENT_TOKEN, headers: Record<string, string> = {}): Request {
  return new Request(`https://soyuz.test${path}`, {
    method: "POST",
    headers: { ...MCP_HEADERS, authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
}

async function rpc(
  env: Env,
  method: string,
  params: Record<string, unknown> | undefined,
  id?: number,
  token = CLIENT_TOKEN,
) {
  const message: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) message.params = params;
  if (id !== undefined) message.id = id;
  const response = await handleRequest(request("/mcp", message, token), env);
  const raw = await response.text();
  let body: any = null;
  if (raw.trim()) {
    const dataLines = raw.split("\n").filter((line) => line.startsWith("data: "));
    body = JSON.parse(dataLines.length > 0 ? dataLines.at(-1)!.slice(6) : raw);
  }
  return { response, body, raw };
}

async function clearDatabase(): Promise<void> {
  await runtimeEnv.DB.prepare("DELETE FROM run_events").run();
  await runtimeEnv.DB.prepare("DELETE FROM runs").run();
}

async function createRun(env: Env, overrides: Record<string, unknown> = {}) {
  return rpc(env, "tools/call", {
    name: "create_run",
    arguments: {
      repoUrl: "https://github.com/example/project",
      taskPrompt: "Investigate the authentication issue and describe a focused fix.",
      ...overrides,
    },
  }, 20);
}

async function api(env: Env, path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await handleRequest(new Request(`https://soyuz.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), env);
  return { response, body: await response.json() as any };
}

async function initializeAndListTools(env: Env) {
  const initialized = await rpc(env, "initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "soyuz-mcp-test", version: "1.0.0" },
  }, 1);
  expect(initialized.response.status).toBe(200);
  expect(initialized.body.result.protocolVersion).toBe(MCP_VERSION);

  await rpc(env, "notifications/initialized", undefined);
  return rpc(env, "tools/list", {}, 2);
}

describe("Soyuz remote MCP interface", () => {
  beforeEach(clearDatabase);

  it("requires client authentication, initializes Streamable HTTP, and exposes only the five client tools", async () => {
    const { bindings, send } = testEnv();
    const unauthenticated = await handleRequest(request("/mcp", {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_run", arguments: { repoUrl: "https://github.com/example/project", taskPrompt: "Unauthorized work must not be admitted." } },
    }, ""), bindings);
    expect(unauthenticated.status).toBe(401);

    const workerCredential = await handleRequest(request("/mcp", {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_run", arguments: { repoUrl: "https://github.com/example/project", taskPrompt: "Worker credentials must not admit client work." } },
    }, WORKER_TOKEN), bindings);
    expect(workerCredential.status).toBe(401);

    const sameCredentialForBothBoundaries = {
      ...bindings,
      CLIENT_API_TOKEN: WORKER_TOKEN,
      WORKER_API_TOKEN: WORKER_TOKEN,
    };
    const collidingWorkerCredential = await handleRequest(request("/mcp", {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_run", arguments: { repoUrl: "https://github.com/example/project", taskPrompt: "Colliding secrets must deny MCP access." } },
    }, WORKER_TOKEN), sameCredentialForBothBoundaries);
    expect(collidingWorkerCredential.status).toBe(401);
    expect(send).not.toHaveBeenCalled();

    const missingClientKey = { ...bindings, CLIENT_API_TOKEN: undefined as unknown as string };
    const serviceMisconfigured = await handleRequest(request("/mcp", {
      jsonrpc: "2.0", id: 1, method: "tools/list",
    }), missingClientKey);
    expect(serviceMisconfigured.status).toBe(503);
    expect(await serviceMisconfigured.text()).toContain("not configured");

    const tools = await initializeAndListTools(bindings);
    expect(tools.response.status).toBe(200);
    const names = tools.body.result.tools.map((tool: { name: string }) => tool.name).sort();
    expect(names).toEqual(["cancel_run", "create_run", "get_run", "get_run_events", "list_runs"]);
    expect(names.some((name: string) => name.includes("worker") || name.includes("claim"))).toBe(false);

    const listTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "list_runs");
    const cancelTool = tools.body.result.tools.find((tool: { name: string }) => tool.name === "cancel_run");
    expect(listTool.annotations.readOnlyHint).toBe(true);
    expect(cancelTool.annotations.readOnlyHint).toBe(false);
    expect(cancelTool.annotations.destructiveHint).toBe(true);
  });

  it("creates through the shared admission path with a safe publication default and REST-compatible idempotency", async () => {
    const { bindings, sent } = testEnv();
    const key = "00000000-0000-4000-8000-000000000010";
    const first = await createRun(bindings, { idempotencyKey: key });
    const summary = first.body.result.structuredContent;
    expect(first.body.result.isError).toBeUndefined();
    expect(summary).toMatchObject({
      status: "queued",
      repoUrl: "https://github.com/example/project",
      ref: "main",
      publishMode: "none",
    });
    expect(summary.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].request.publishMode).toBe("none");

    const stored = await runtimeEnv.DB.prepare("SELECT status, publish_mode, idempotency_key FROM runs WHERE id = ?")
      .bind(summary.runId).first<{ status: string; publish_mode: string; idempotency_key: string }>();
    expect(stored).toEqual({ status: "queued", publish_mode: "none", idempotency_key: key });

    const replay = await createRun(bindings, { idempotencyKey: key });
    expect(replay.body.result.structuredContent.runId).toBe(summary.runId);
    expect(sent).toHaveLength(1);

    const explicitPublish = await createRun(bindings, {
      idempotencyKey: "00000000-0000-4000-8000-000000000011",
      publishMode: "branch",
    });
    expect(explicitPublish.body.result.structuredContent.publishMode).toBe("branch");
    expect(sent[1].request.publishMode).toBe("branch");

    const credentialedUrl = await createRun(bindings, {
      repoUrl: "https://clone-user:embedded-secret@github.com/example/private-project?access_token=embedded-token",
      idempotencyKey: "00000000-0000-4000-8000-000000000012",
    });
    const safeSummary = credentialedUrl.body.result.structuredContent;
    expect(safeSummary.repoUrl).toBe("https://github.com/example/private-project");
    expect(JSON.stringify(safeSummary)).not.toContain("embedded-secret");
    expect(JSON.stringify(safeSummary)).not.toContain("embedded-token");

    const conflict = await createRun(bindings, {
      idempotencyKey: key,
      taskPrompt: "Use the same key for a different request to check admission conflicts.",
    });
    expect(conflict.body.result.isError).toBe(true);
    expect(conflict.body.result.structuredContent.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects invalid input safely without creating canonical state or publishing a Queue message", async () => {
    const { bindings, send } = testEnv();
    const invalid = await createRun(bindings, { taskPrompt: "short" });
    expect(invalid.body.error || invalid.body.result?.isError).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    const count = await runtimeEnv.DB.prepare("SELECT COUNT(*) AS count FROM runs").first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("maps uncertain Queue admission safely and tells callers to reuse the idempotency key", async () => {
    const { bindings, send } = testEnv({ queueFailure: true });
    const idempotencyKey = "00000000-0000-4000-8000-000000000015";
    const first = await createRun(bindings, { idempotencyKey });
    expect(first.body.result.isError).toBe(true);
    expect(first.body.result.structuredContent.error).toMatchObject({
      code: "QUEUE_PUBLISH_UNCERTAIN",
      retryable: true,
    });
    expect(first.body.result.structuredContent.error.message).toContain("same Idempotency-Key");

    const retry = await createRun(bindings, { idempotencyKey });
    expect(retry.body.result.structuredContent.error).toMatchObject({
      code: "RUN_ADMISSION_PENDING",
      retryable: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const row = await runtimeEnv.DB.prepare("SELECT status FROM runs WHERE idempotency_key = ?")
      .bind(idempotencyKey).first<{ status: string }>();
    expect(row?.status).toBe("admitting");
  });

  it("lists bounded summaries and returns canonical detail without internal fields", async () => {
    const { bindings } = testEnv();
    const first = (await createRun(bindings, { idempotencyKey: "00000000-0000-4000-8000-000000000020" })).body.result.structuredContent;
    const second = (await createRun(bindings, { idempotencyKey: "00000000-0000-4000-8000-000000000021" })).body.result.structuredContent;

    const listed = await rpc(bindings, "tools/call", {
      name: "list_runs",
      arguments: { status: "queued", limit: 1 },
    }, 30);
    const page = listed.body.result.structuredContent;
    expect(page.runs).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    expect(page.runs[0].status).toBe("queued");
    expect(page.runs[0]).not.toHaveProperty("workerId");
    expect(page.runs[0]).not.toHaveProperty("request");
    expect(page.runs[0]).not.toHaveProperty("request_hash");

    const next = await rpc(bindings, "tools/call", {
      name: "list_runs",
      arguments: { status: "queued", limit: 1, cursor: page.nextCursor },
    }, 31);
    expect(next.body.result.structuredContent.runs).toHaveLength(1);
    expect([first.runId, second.runId]).toContain(next.body.result.structuredContent.runs[0].runId);

    const detail = await rpc(bindings, "tools/call", { name: "get_run", arguments: { runId: first.runId } }, 32);
    expect(detail.body.result.structuredContent).toMatchObject({
      runId: first.runId,
      status: "queued",
      repoUrl: "https://github.com/example/project",
      ref: "main",
      cancellation: { state: "none", requestedAt: null },
    });
    expect(detail.body.result.structuredContent).not.toHaveProperty("workerId");
    expect(detail.body.result.structuredContent).not.toHaveProperty("claimExpiresAt");
    expect(detail.body.result.structuredContent).not.toHaveProperty("request");
    expect(JSON.stringify(detail.body.result.structuredContent)).not.toContain(CLIENT_TOKEN);
    expect(JSON.stringify(detail.body.result.structuredContent)).not.toContain(WORKER_TOKEN);

    const missing = await rpc(bindings, "tools/call", {
      name: "get_run", arguments: { runId: "00000000-0000-4000-8000-000000000099" },
    }, 33);
    expect(missing.body.result.isError).toBe(true);
    expect(missing.body.result.structuredContent.error.code).toBe("RUN_NOT_FOUND");
  });

  it("redacts malformed persisted URLs instead of failing MCP reads", async () => {
    const { bindings } = testEnv();
    const created = (await createRun(bindings, {
      idempotencyKey: "00000000-0000-4000-8000-000000000022",
    })).body.result.structuredContent;
    const malformedRepoUrl = "not a URL/embedded-repository-secret";
    const malformedPublishedUrl = "not a URL/embedded-publication-secret";
    await runtimeEnv.DB.prepare("UPDATE runs SET repo_url = ?, result_json = ? WHERE id = ?")
      .bind(malformedRepoUrl, JSON.stringify({ publishedUrl: malformedPublishedUrl }), created.runId).run();

    const listed = await rpc(bindings, "tools/call", {
      name: "list_runs",
      arguments: { status: "queued" },
    }, 34);
    expect(listed.body.result.isError).toBeUndefined();
    expect(listed.body.result.structuredContent.runs[0].repoUrl).toBe("about:invalid");

    const detail = await rpc(bindings, "tools/call", {
      name: "get_run",
      arguments: { runId: created.runId },
    }, 35);
    expect(detail.body.result.isError).toBeUndefined();
    expect(detail.body.result.structuredContent).toMatchObject({
      repoUrl: "about:invalid",
      publishedUrl: "about:invalid",
    });
    expect(JSON.stringify([listed.body, detail.body])).not.toContain("embedded-");
  });

  it("returns ordered operational events with the existing after cursor semantics", async () => {
    const { bindings } = testEnv();
    const created = (await createRun(bindings, { idempotencyKey: "00000000-0000-4000-8000-000000000040" })).body.result.structuredContent;
    const runId = created.runId as string;
    const workerId = "mcp-test-host";
    await api(bindings, `/v1/worker/runs/${runId}/claim`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000041", workerId },
    });
    await api(bindings, `/v1/worker/runs/${runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000042", workerId, stage: "prepare" },
    });
    await api(bindings, `/v1/worker/runs/${runId}/events`, {
      method: "POST", token: WORKER_TOKEN,
      body: {
        contractVersion: "1",
        eventId: "00000000-0000-4000-8000-000000000043",
        workerId,
        type: "stage.changed",
        stage: "execute",
        payload: { source: "pi-agent", stdout: "raw Pi output must not reach MCP clients" },
      },
    });

    const firstPage = await rpc(bindings, "tools/call", {
      name: "get_run_events", arguments: { runId, limit: 2 },
    }, 40);
    const events = firstPage.body.result.structuredContent.events;
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBeLessThan(events[1].sequence);
    const nextAfter = firstPage.body.result.structuredContent.nextAfter;
    expect(nextAfter).toBe(events[1].sequence);

    const later = await rpc(bindings, "tools/call", {
      name: "get_run_events", arguments: { runId, after: nextAfter, limit: 20 },
    }, 41);
    const laterEvents = later.body.result.structuredContent.events;
    expect(laterEvents).toHaveLength(3);
    expect(laterEvents.every((event: { sequence: number }) => event.sequence > nextAfter)).toBe(true);
    expect(laterEvents[0].sequence).toBeLessThan(laterEvents[1].sequence);
    expect(laterEvents[1].sequence).toBeLessThan(laterEvents[2].sequence);
    expect(laterEvents[2]).toMatchObject({ type: "stage.changed", stage: "execute", payload: { source: "pi-agent" } });
    expect(laterEvents[2]).not.toHaveProperty("workerId");
    expect(JSON.stringify(laterEvents)).not.toContain("stdout");
  });

  it("uses canonical cancellation behavior for queued, running, and terminal runs", async () => {
    const { bindings } = testEnv();
    const queued = (await createRun(bindings, { idempotencyKey: "00000000-0000-4000-8000-000000000050" })).body.result.structuredContent;
    const queuedCancel = await rpc(bindings, "tools/call", { name: "cancel_run", arguments: { runId: queued.runId } }, 50);
    expect(queuedCancel.body.result.structuredContent.status).toBe("cancelled");
    const queuedReplay = await rpc(bindings, "tools/call", { name: "cancel_run", arguments: { runId: queued.runId } }, 51);
    expect(queuedReplay.body.result.structuredContent.status).toBe("cancelled");

    const claimed = (await createRun(bindings, { idempotencyKey: "00000000-0000-4000-8000-000000000058" })).body.result.structuredContent;
    await api(bindings, `/v1/worker/runs/${claimed.runId}/claim`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000059", workerId: "mcp-claimed-host" },
    });
    const claimedCancel = await rpc(bindings, "tools/call", { name: "cancel_run", arguments: { runId: claimed.runId } }, 54);
    expect(claimedCancel.body.result.structuredContent.status).toBe("cancelled");

    const running = (await createRun(bindings, { idempotencyKey: "00000000-0000-4000-8000-000000000051" })).body.result.structuredContent;
    const workerId = "mcp-cancel-host";
    await api(bindings, `/v1/worker/runs/${running.runId}/claim`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000052", workerId },
    });
    await api(bindings, `/v1/worker/runs/${running.runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000053", workerId },
    });
    const runningCancel = await rpc(bindings, "tools/call", { name: "cancel_run", arguments: { runId: running.runId } }, 52);
    expect(runningCancel.body.result.structuredContent).toMatchObject({
      status: "cancel_requested",
      cancellation: { state: "requested" },
    });

    const terminal = (await createRun(bindings, { idempotencyKey: "00000000-0000-4000-8000-000000000054" })).body.result.structuredContent;
    await api(bindings, `/v1/worker/runs/${terminal.runId}/claim`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000055", workerId: "mcp-terminal-host" },
    });
    await api(bindings, `/v1/worker/runs/${terminal.runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000056", workerId: "mcp-terminal-host" },
    });
    await api(bindings, `/v1/worker/runs/${terminal.runId}/completed`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000057", workerId: "mcp-terminal-host", summary: "Done." },
    });
    const terminalCancel = await rpc(bindings, "tools/call", { name: "cancel_run", arguments: { runId: terminal.runId } }, 53);
    expect(terminalCancel.body.result.isError).toBe(true);
    expect(terminalCancel.body.result.structuredContent.error.code).toBe("RUN_ALREADY_TERMINAL");

    const missingCancel = await rpc(bindings, "tools/call", {
      name: "cancel_run", arguments: { runId: "00000000-0000-4000-8000-000000000099" },
    }, 55);
    expect(missingCancel.body.result.isError).toBe(true);
    expect(missingCancel.body.result.structuredContent.error.code).toBe("RUN_NOT_FOUND");
  });
});

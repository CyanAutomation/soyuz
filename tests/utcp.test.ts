import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UtcpClient, UtcpClientConfigSchema, UtcpManualSerializer } from "@utcp/sdk";
import { HttpCallTemplateSerializer } from "@utcp/http";
import { handleRequest } from "../src/index";
import type { Env } from "../src/env";
import {
  AgentCancelRunOutputSchema,
  AgentCreateRunOutputSchema,
  AgentGetRunEventsOutputSchema,
  AgentGetRunOutputSchema,
  AgentListRunsOutputSchema,
} from "../src/contracts/agent-tools";

const CLIENT_TOKEN = "client-test-token-value-long-enough";
const KASEKI_TOKEN = "kaseki-submit-token-value-long-enough";
const WORKER_TOKEN = "worker-test-token-value-long-enough";

function testEnv(options: { queueFailure?: boolean; clientToken?: string } = {}) {
  const sent: Array<{ runId: string; request: Record<string, unknown> }> = [];
  const send = vi.fn(async (message: unknown) => {
    if (options.queueFailure) throw new Error("simulated queue failure");
    sent.push(message as { runId: string; request: Record<string, unknown> });
  });
  const bindings: Env = {
    DB: runtimeEnv.DB,
    RUN_QUEUE: { send } as unknown as Env["RUN_QUEUE"],
    OAUTH_REGISTRATION_LIMITER: { limit: async () => ({ success: true }) } as Env["OAUTH_REGISTRATION_LIMITER"],
    OPENUI_GENERATION_LIMITER: { limit: async () => ({ success: true }) } as Env["OPENUI_GENERATION_LIMITER"],
    JEV_DECISION_LIMITER: { limit: async () => ({ success: true }) } as Env["JEV_DECISION_LIMITER"],
    SENKU: (runtimeEnv as unknown as Env).SENKU,
    CLIENT_API_TOKEN: options.clientToken ?? CLIENT_TOKEN,
    KASEKI_SUBMISSION_API_TOKEN: KASEKI_TOKEN,
    KASEKI_SUBMISSION_IDENTITY: "kaseki-utcp-test",
    WORKER_API_TOKEN: WORKER_TOKEN,
    SOYUZ_ENVIRONMENT: "production",
    SOYUZ_PUBLIC_URL: "https://soyuz.test",
  };
  return { bindings, send, sent };
}

function request(
  path: string,
  options: { method?: string; body?: unknown; token?: string; headers?: Record<string, string>; host?: string } = {},
): Request {
  const headers = new Headers(options.headers);
  headers.set("host", options.host ?? "soyuz.test");
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
  options: Parameters<typeof request>[1] = {},
): Promise<{ response: Response; body: any }> {
  const response = await handleRequest(request(path, options), env);
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
  await runtimeEnv.DB.batch([
    runtimeEnv.DB.prepare("DELETE FROM run_events"),
    runtimeEnv.DB.prepare("DELETE FROM artifact_deletion_queue"),
    runtimeEnv.DB.prepare("DELETE FROM run_idempotency_keys"),
    runtimeEnv.DB.prepare("DELETE FROM jev_feedback"),
    runtimeEnv.DB.prepare("DELETE FROM runs"),
  ]);
}

async function createAgentRun(env: Env, overrides: Record<string, unknown> = {}) {
  return call(env, "/v1/agent/runs", {
    method: "POST",
    token: CLIENT_TOKEN,
    body: validRequest(overrides),
  });
}

describe("Soyuz UTCP discovery and agent API", () => {
  beforeEach(clearDatabase);

  it("[UTCP-DISCOVERY-01] publishes a valid five-tool UTCP 1.0.0 manual from the trusted configured origin", async () => {
    const { bindings } = testEnv();
    const response = await handleRequest(request("/utcp", { host: "attacker.invalid" }), bindings);
    const manual = await response.json() as any;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(manual.utcp_version).toBe("1.0.0");
    expect(manual.manual_version).toBe("1.0.0");
    expect(() => new UtcpManualSerializer().validateDict(manual)).not.toThrow();
    expect(manual.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "cancel_run", "create_run", "get_run", "get_run_events", "list_runs",
    ]);
    expect(manual.tools.every((tool: any) => tool.tool_call_template.url.startsWith("https://soyuz.test/"))).toBe(true);
    expect(JSON.stringify(manual)).not.toContain("attacker.invalid");
    expect(JSON.stringify(manual)).not.toContain(CLIENT_TOKEN);
    expect(manual.tools.find((tool: any) => tool.name === "create_run")).toMatchObject({
      inputs: {
        type: "object",
        properties: { body: { type: "object", properties: { repoUrl: { type: "string" } } } },
        required: ["body"],
      },
      outputs: {
        type: "object",
        properties: {
          data: { type: "object", properties: { runId: { type: "string" }, displayId: { type: "string" } } },
          requestId: { type: "string" },
        },
      },
      tool_call_template: {
        call_template_type: "http",
        http_method: "POST",
        url: "https://soyuz.test/v1/agent/runs",
        body_field: "body",
        content_type: "application/json",
        auth: { auth_type: "api_key", api_key: "Bearer ${CLIENT_API_TOKEN}", var_name: "Authorization", location: "header" },
      },
    });
    expect(manual.tools.find((tool: any) => tool.name === "get_run_events").tool_call_template.url)
      .toBe("https://soyuz.test/v1/agent/runs/{runId}/events");
    expect(manual.tools.find((tool: any) => tool.name === "cancel_run").tool_call_template)
      .toMatchObject({ http_method: "POST", url: "https://soyuz.test/v1/agent/runs/{runId}/cancel" });
  });

  it("[UTCP-ORIGIN-01] rejects unconfigured or production loopback origins and permits explicit local loopback", async () => {
    const { bindings } = testEnv();
    expect((await handleRequest(request("/utcp"), { ...bindings, SOYUZ_PUBLIC_URL: undefined })).status).toBe(503);
    expect((await handleRequest(request("/utcp"), {
      ...bindings,
      SOYUZ_PUBLIC_URL: "http://127.0.0.1:8787",
    })).status).toBe(503);

    const local = await handleRequest(request("/utcp"), {
      ...bindings,
      SOYUZ_ENVIRONMENT: "development",
      SOYUZ_PUBLIC_URL: "http://127.0.0.1:8787",
    });
    expect(local.status).toBe(200);
    const localManual = await local.json() as any;
    expect(localManual.tools.every((tool: any) => tool.tool_call_template.url.startsWith("http://127.0.0.1:8787/"))).toBe(true);
  });

  it("[UTCP-INTEROP-01] discovers and invokes Soyuz through the official TypeScript UTCP HTTP client", async () => {
    const { bindings, sent } = testEnv();
    const requests: Array<{ method: string; url: string; authorization: string | null; contentType: string | null; body: string }> = [];
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const forwarded = new Request(input, init);
      const copy = forwarded.clone();
      const body = forwarded.method === "GET" || forwarded.method === "HEAD" ? "" : await copy.text();
      requests.push({
        method: forwarded.method,
        url: forwarded.url,
        authorization: forwarded.headers.get("authorization"),
        contentType: forwarded.headers.get("content-type"),
        body,
      });
      return handleRequest(forwarded, bindings);
    });

    const serializer = new HttpCallTemplateSerializer();
    const client = await UtcpClient.create("/workspace/soyuz", UtcpClientConfigSchema.parse({
      variables: { soyuz_CLIENT_API_TOKEN: CLIENT_TOKEN },
      manual_call_templates: [serializer.validateDict({
        name: "soyuz",
        call_template_type: "http",
        http_method: "GET",
        url: "https://soyuz.test/utcp",
      })],
    }));

    try {
      const names = (await client.getTools()).map((tool) => tool.name).sort();
      expect(names).toEqual([
        "soyuz.cancel_run", "soyuz.create_run", "soyuz.get_run", "soyuz.get_run_events", "soyuz.list_runs",
      ]);

      const listed = await client.callTool("soyuz.list_runs", { limit: 5 });
      expect(AgentListRunsOutputSchema.parse(listed).data.runs).toEqual([]);

      const created = await client.callTool("soyuz.create_run", {
        body: {
          ...validRequest(),
          idempotencyKey: "00000000-0000-4000-8000-000000000101",
        },
      });
      const parsed = AgentCreateRunOutputSchema.parse(created);
      expect(parsed.data).toMatchObject({ status: "queued", publishMode: "none", displayId: expect.stringMatching(/^soyuz-\d+$/) });
      expect(sent).toHaveLength(1);
      expect(sent[0].request.publishMode).toBe("none");
      expect(requests[0].url).toBe("https://soyuz.test/utcp");
      expect(requests[1]).toMatchObject({ method: "GET", url: "https://soyuz.test/v1/agent/runs?limit=5", authorization: `Bearer ${CLIENT_TOKEN}` });
      expect(requests[2]).toMatchObject({
        method: "POST",
        url: "https://soyuz.test/v1/agent/runs",
        authorization: `Bearer ${CLIENT_TOKEN}`,
        contentType: "application/json",
      });
      expect(JSON.parse(requests[2].body)).toMatchObject({ repoUrl: "https://github.com/example/project" });
    } finally {
      await client.close();
      vi.stubGlobal("fetch", previousFetch);
    }
  });

  it("[UTCP-AUTH-01] removes the MCP transport while keeping agent operations client-token-only", async () => {
    const { bindings, send } = testEnv();
    for (const path of ["/mcp", "/mcp/"]) {
      const removed = await handleRequest(request(path, { method: "POST", token: CLIENT_TOKEN, body: {} }), bindings);
      expect(removed.status).toBe(404);
    }

    for (const token of [undefined, "invalid-client-token-value-long-enough", WORKER_TOKEN, KASEKI_TOKEN]) {
      const rejected = await call(bindings, "/v1/agent/runs", {
        method: "POST", token, body: validRequest(),
      });
      expect(rejected.response.status).toBe(401);
    }
    const clientAndWorkerCollision = await call({ ...bindings, CLIENT_API_TOKEN: WORKER_TOKEN }, "/v1/agent/runs", {
      method: "POST", token: WORKER_TOKEN, body: validRequest(),
    });
    expect(clientAndWorkerCollision.response.status).toBe(503);
    expect(clientAndWorkerCollision.body.error.code).toBe("AUTHENTICATION_UNAVAILABLE");
    const clientAndKasekiCollision = await call({ ...bindings, CLIENT_API_TOKEN: KASEKI_TOKEN }, "/v1/agent/runs", {
      method: "POST", token: KASEKI_TOKEN, body: validRequest(),
    });
    expect(clientAndKasekiCollision.response.status).toBe(503);
    expect(clientAndKasekiCollision.body.error.code).toBe("AUTHENTICATION_UNAVAILABLE");
    expect(send).not.toHaveBeenCalled();
  });

  it("[UTCP-CREATE-01/UTCP-IDEMPOTENCY-01] keeps agent admission bounded, idempotent, and publication-safe", async () => {
    const { bindings, sent } = testEnv();
    const key = "00000000-0000-4000-8000-000000000111";
    const first = await createAgentRun(bindings, {
      repoUrl: "https://clone-user:embedded-secret@github.com/example/private-project?access_token=embedded-token#fragment",
      idempotencyKey: key,
    });
    expect(first.response.status).toBe(202);
    const created = AgentCreateRunOutputSchema.parse(first.body).data;
    expect(created.publishMode).toBe("none");
    expect(created.repoUrl).toBe("https://github.com/example/private-project");
    expect(JSON.stringify(created)).not.toContain("embedded-secret");
    expect(JSON.stringify(created)).not.toContain("embedded-token");
    expect(sent[0].request.publishMode).toBe("none");

    const replay = await createAgentRun(bindings, {
      repoUrl: "https://clone-user:embedded-secret@github.com/example/private-project?access_token=embedded-token#fragment",
      idempotencyKey: key,
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body.data.runId).toBe(created.runId);
    expect(sent).toHaveLength(1);

    const conflict = await createAgentRun(bindings, {
      idempotencyKey: key,
      taskPrompt: "Use this same idempotency key with a different task to check conflict handling.",
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const explicitPublish = await createAgentRun(bindings, {
      idempotencyKey: "00000000-0000-4000-8000-000000000112",
      publishMode: "branch",
    });
    expect(explicitPublish.body.data.publishMode).toBe("branch");
    expect(sent[1].request.publishMode).toBe("branch");

    const invalidUrl = await createAgentRun(bindings, { repoUrl: "git@github.com:example/project.git" });
    expect(invalidUrl.response.status).toBe(422);
    const invalidPrompt = await createAgentRun(bindings, { taskPrompt: "short" });
    expect(invalidPrompt.response.status).toBe(422);
    expect(sent).toHaveLength(2);
  });

  it("[UTCP-ORIGIN-02] isolates agent ownership and idempotency from the general client API", async () => {
    const { bindings } = testEnv();
    const idempotencyKey = "00000000-0000-4000-8000-000000000116";
    const agent = await createAgentRun(bindings, { idempotencyKey });
    const agentRun = AgentCreateRunOutputSchema.parse(agent.body).data;
    const agentOrigin = await bindings.DB.prepare("SELECT origin_type, origin_id FROM runs WHERE id = ?")
      .bind(agentRun.runId)
      .first<{ origin_type: string; origin_id: string }>();
    expect(agentOrigin).toEqual({ origin_type: "api_client", origin_id: "utcp-agent" });

    const client = await call(bindings, "/v1/runs", {
      method: "POST",
      token: CLIENT_TOKEN,
      body: { ...validRequest(), publishMode: "none", idempotencyKey },
    });
    expect(client.response.status).toBe(202);
    expect(client.body.data.id).not.toBe(agentRun.runId);
    expect(client.body.data.origin).toEqual({ type: "api_client", id: "client-api" });

    const clientCancel = await call(bindings, `/v1/runs/${agentRun.runId}/cancel`, {
      method: "POST", token: CLIENT_TOKEN,
    });
    expect(clientCancel.response.status).toBe(403);
    expect(clientCancel.body.error.code).toBe("RUN_ORIGIN_MISMATCH");
  });

  it("[UTCP-IDEMPOTENCY-01] preserves uncertain Queue publication behavior and retry guidance", async () => {
    const { bindings } = testEnv({ queueFailure: true });
    const key = "00000000-0000-4000-8000-000000000121";
    const first = await createAgentRun(bindings, { idempotencyKey: key });
    expect(first.response.status).toBe(503);
    expect(first.body.error.code).toBe("QUEUE_PUBLISH_UNCERTAIN");
    expect(first.body.error.message).toContain("same Idempotency-Key");
    const retry = await createAgentRun(bindings, { idempotencyKey: key });
    expect(retry.response.status).toBe(503);
    expect(retry.body.error.code).toBe("RUN_ADMISSION_PENDING");
    expect(retry.body.error.message).toContain("same idempotency key");
  });

  it("[UTCP-READ-01] paginates retained summaries and returns sanitized detail schemas", async () => {
    const { bindings } = testEnv();
    const created = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await createAgentRun(bindings, { idempotencyKey: `00000000-0000-4000-8000-00000000013${index}` });
      created.push(AgentCreateRunOutputSchema.parse(result.body).data);
    }
    const first = await call(bindings, "/v1/agent/runs?limit=1", { token: CLIENT_TOKEN });
    const firstPage = AgentListRunsOutputSchema.parse(first.body).data;
    expect(firstPage.runs).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    const second = await call(bindings, `/v1/agent/runs?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, { token: CLIENT_TOKEN });
    const secondPage = AgentListRunsOutputSchema.parse(second.body).data;
    expect(secondPage.runs).toHaveLength(1);
    expect(secondPage.runs[0].runId).not.toBe(firstPage.runs[0].runId);

    const detail = await call(bindings, `/v1/agent/runs/${created[0].runId}`, { token: CLIENT_TOKEN });
    const detailData = AgentGetRunOutputSchema.parse(detail.body).data;
    expect(detailData).toMatchObject({ runId: created[0].runId, cancellation: { state: "none", requestedAt: null } });
    expect(detailData).not.toHaveProperty("workerId");
    expect(detailData).not.toHaveProperty("request");
    expect(detailData).not.toHaveProperty("failureMessage");
    expect((await call(bindings, "/v1/agent/runs/not-a-uuid", { token: CLIENT_TOKEN })).response.status).toBe(404);

    await bindings.DB.prepare("UPDATE runs SET result_json = ? WHERE id = ?")
      .bind(JSON.stringify({ summary: "Legacy result", publishedUrl: "javascript:alert(1)" }), created[0].runId)
      .run();
    const legacyDetail = await call(bindings, `/v1/agent/runs/${created[0].runId}`, { token: CLIENT_TOKEN });
    expect(AgentGetRunOutputSchema.parse(legacyDetail.body).data.publishedUrl).toBeNull();

    await bindings.DB.prepare("UPDATE runs SET result_json = ? WHERE id = ?")
      .bind(JSON.stringify({ summary: "s".repeat(2_500) }), created[0].runId)
      .run();
    const longDetail = await call(bindings, `/v1/agent/runs/${created[0].runId}`, { token: CLIENT_TOKEN });
    expect(longDetail.response.status).toBe(200);
    expect(AgentGetRunOutputSchema.parse(longDetail.body).data.outcomeSummary).toHaveLength(2_000);
  });

  it("[UTCP-EVENTS-01] returns bounded operational event metadata and supports sequence pagination", async () => {
    const { bindings } = testEnv();
    const createdResponse = await createAgentRun(bindings, { idempotencyKey: "00000000-0000-4000-8000-000000000141" });
    const run = AgentCreateRunOutputSchema.parse(createdResponse.body).data;
    const worker = async (path: string, body: Record<string, unknown>) => call(bindings, path, {
      method: "POST", token: WORKER_TOKEN, body,
    });
    const workerId = "utcp-test-host";
    await worker(`/v1/worker/runs/${run.runId}/claim`, {
      contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000142", workerId,
    });
    await worker(`/v1/worker/runs/${run.runId}/started`, {
      contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000143", workerId, stage: "prepare",
    });
    await worker(`/v1/worker/runs/${run.runId}/events`, {
      contractVersion: "1",
      eventId: "00000000-0000-4000-8000-000000000144",
      workerId,
      type: "stage.changed",
      stage: "execute",
      payload: { source: "pi-agent", progressPercent: 42, stdout: "private transcript", arbitrary: "private payload" },
    });

    const first = await call(bindings, `/v1/agent/runs/${run.runId}/events?limit=2`, { token: CLIENT_TOKEN });
    const page = AgentGetRunEventsOutputSchema.parse(first.body).data;
    expect(page.events).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const next = await call(bindings, `/v1/agent/runs/${run.runId}/events?after=${page.nextAfter}&limit=20`, { token: CLIENT_TOKEN });
    const later = AgentGetRunEventsOutputSchema.parse(next.body).data;
    expect(later.events.at(-1)).toMatchObject({ type: "stage.changed", stage: "execute", payload: { source: "pi-agent", progressPercent: 42 } });
    expect(JSON.stringify(later.events)).not.toContain("stdout");
    expect(JSON.stringify(later.events)).not.toContain("private transcript");
    expect(JSON.stringify(later.events)).not.toContain("arbitrary");
    expect(later.events.every((event) => !("workerId" in event))).toBe(true);
  });

  it("[UTCP-CANCEL-01] records cancellation intent through the shared application layer and enforces run origin", async () => {
    const { bindings } = testEnv();
    const queued = AgentCreateRunOutputSchema.parse((await createAgentRun(bindings, {
      idempotencyKey: "00000000-0000-4000-8000-000000000151",
    })).body).data;
    const queuedCancel = await call(bindings, `/v1/agent/runs/${queued.runId}/cancel`, { method: "POST", token: CLIENT_TOKEN });
    expect(queuedCancel.response.status).toBe(202);
    expect(AgentCancelRunOutputSchema.parse(queuedCancel.body).data.status).toBe("cancelled");

    const kasekiRun = await call(bindings, "/v1/runs", {
      method: "POST", token: KASEKI_TOKEN, body: validRequest(),
    });
    const mismatch = await call(bindings, `/v1/agent/runs/${kasekiRun.body.data.id}/cancel`, { method: "POST", token: CLIENT_TOKEN });
    expect(mismatch.response.status).toBe(403);
    expect(mismatch.body.error.code).toBe("RUN_ORIGIN_MISMATCH");

    const running = AgentCreateRunOutputSchema.parse((await createAgentRun(bindings, {
      idempotencyKey: "00000000-0000-4000-8000-000000000152",
    })).body).data;
    const workerId = "utcp-cancel-host";
    await call(bindings, `/v1/worker/runs/${running.runId}/claim`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000153", workerId },
    });
    await call(bindings, `/v1/worker/runs/${running.runId}/started`, {
      method: "POST", token: WORKER_TOKEN,
      body: { contractVersion: "1", callbackId: "00000000-0000-4000-8000-000000000154", workerId },
    });
    const runningCancel = await call(bindings, `/v1/agent/runs/${running.runId}/cancel`, { method: "POST", token: CLIENT_TOKEN });
    const detail = AgentCancelRunOutputSchema.parse(runningCancel.body).data;
    expect(detail.status).toBe("cancel_requested");
    expect(detail.cancellation.state).toBe("requested");
    expect(detail.cancellation.requestedAt).toBeTruthy();
    const repeated = await call(bindings, `/v1/agent/runs/${running.runId}/cancel`, { method: "POST", token: CLIENT_TOKEN });
    expect(AgentCancelRunOutputSchema.parse(repeated.body).data.status).toBe("cancel_requested");
  });
});

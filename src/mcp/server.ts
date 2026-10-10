import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { createRun, listRunsPage, readRun, readRunEventsPage, requestRunCancellation, RunApplicationError } from "../application/runs";
import { McpCreateRunInputSchema } from "../contracts/run-request";
import { parseEventPayload, parseResult, type RunEventRow, type RunRow } from "../db/runs";
import { RUN_STATUSES } from "../domain/run-state-machine";
import type { Env } from "../env";
import { requestIdFor } from "../api/http";

const ListRunsInputSchema = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
}).strict();

const RunIdInputSchema = z.object({ runId: z.string().uuid() }).strict();

const RunEventsInputSchema = z.object({
  runId: z.string().uuid(),
  after: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

const ToolErrorOutputSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  }).strict(),
}).strict();

const RunSummaryOutputSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(RUN_STATUSES),
  createdAt: z.string().datetime({ offset: true }),
  repoUrl: z.string().url(),
  ref: z.string(),
  publishMode: z.enum(["auto", "none", "branch", "pr"]),
}).strict();

const RunListItemOutputSchema = z.object({
  runId: z.string().uuid(),
  repoUrl: z.string().url(),
  ref: z.string(),
  status: z.enum(RUN_STATUSES),
  stage: z.string().nullable(),
  taskMode: z.enum(["patch", "inspect"]),
  publishMode: z.enum(["auto", "none", "branch", "pr"]),
  createdAt: z.string().datetime({ offset: true }),
  queuedAt: z.string().datetime({ offset: true }).nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

const RunDetailOutputSchema = RunListItemOutputSchema.extend({
  updatedAt: z.string().datetime({ offset: true }),
  outcomeSummary: z.string().nullable(),
  publishedUrl: z.string().url().nullable(),
  changedFileCount: z.number().int().nullable(),
  failureClass: z.string().nullable(),
  cancellation: z.object({
    state: z.enum(["none", "requested", "cancelled"]),
    requestedAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
}).strict();

const RunEventOutputSchema = z.object({
  sequence: z.number().int(),
  eventId: z.string(),
  type: z.string(),
  stage: z.string().nullable(),
  step: z.string().nullable(),
  timestamp: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.union([z.string().max(160), z.number(), z.boolean()])),
}).strict();

const MCP_EVENT_PAYLOAD_KEYS = new Set([
  "source",
  "status",
  "percent",
  "progressPercent",
  "current",
  "total",
  "completed",
  "passed",
  "failed",
  "exitCode",
  "durationMs",
  "changedFileCount",
  "failureClass",
]);

export function createSoyuzMcpHandler(env: Env) {
  return createMcpHandler(
    ({ requestInfo }) => createSoyuzMcpServer(env, requestInfo),
    { route: "/mcp", legacy: "stateless", responseMode: "auto" },
  );
}

function createSoyuzMcpServer(env: Env, requestInfo?: Request): McpServer {
  const server = new McpServer({ name: "Soyuz", version: "1.0.0" });
  const requestId = requestInfo ? requestIdFor(requestInfo) : crypto.randomUUID();

  server.registerTool("create_run", {
    title: "Create a Kaseki run",
    description: "Create a Kaseki coding-agent run through Soyuz. Use this when the user wants Kaseki to work against a repository. Soyuz validates and queues the request; execution may happen later on an available Kaseki host. Omitted publishMode defaults to none; an explicit publishMode is honored and may publish a branch or pull request. Use the same idempotencyKey when retrying so a transport retry cannot create a duplicate run. This does not execute Kaseki immediately or return repository files or logs.",
    inputSchema: McpCreateRunInputSchema,
    outputSchema: z.union([RunSummaryOutputSchema, ToolErrorOutputSchema]),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async (input) => executeTool(async () => {
    const admission = await createRun(env, {
      ...input,
      publishMode: input.publishMode ?? "none",
    }, requestId);
    return mcpRunSummary(admission.row);
  }));

  server.registerTool("list_runs", {
    title: "List recent runs",
    description: "List bounded summaries of recent Kaseki runs recorded by Soyuz, optionally filtered by status and paginated with cursor. Use this to find or monitor run IDs. This reads Soyuz control-plane state only; it does not inspect repositories, execution hosts, logs, or artifacts.",
    inputSchema: ListRunsInputSchema,
    outputSchema: z.union([z.object({
      runs: z.array(RunListItemOutputSchema).max(100),
      nextCursor: z.string().nullable(),
    }).strict(), ToolErrorOutputSchema]),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input) => executeTool(async () => {
    const page = await listRunsPage(env, input);
    return {
      runs: page.rows.map(mcpRunListItem),
      nextCursor: page.nextCursor,
    };
  }));

  server.registerTool("get_run", {
    title: "Get run status",
    description: "Read Soyuz's canonical state for one run, including its repository, lifecycle timestamps, compact outcome, publication summary, and cancellation state. Use this to inspect a known run ID. It does not reveal worker credentials or lease data and does not fetch execution logs or artifacts.",
    inputSchema: RunIdInputSchema,
    outputSchema: z.union([RunDetailOutputSchema, ToolErrorOutputSchema]),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ runId }) => executeTool(async () => mcpRunDetail(await readRun(env, runId))));

  server.registerTool("get_run_events", {
    title: "Get run events",
    description: "Read a bounded, sequence-paginated page of Soyuz's operational events for one run. Use this for lifecycle and progress metadata. This returns only the events stored by Soyuz; it does not fetch stdout, stderr, raw Pi output, repository contents, or Kaseki artifacts.",
    inputSchema: RunEventsInputSchema,
    outputSchema: z.union([z.object({
      runId: z.string().uuid(),
      events: z.array(RunEventOutputSchema).max(200),
      nextAfter: z.number().int().min(0),
    }).strict(), ToolErrorOutputSchema]),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ runId, after, limit }) => executeTool(async () => {
    const page = await readRunEventsPage(env, runId, { after, limit });
    return {
      runId,
      events: page.events.map(mcpRunEvent),
      nextAfter: page.nextAfter,
    };
  }));

  server.registerTool("cancel_run", {
    title: "Request run cancellation",
    description: "Request cancellation through Soyuz. Queued or claimed work may become cancelled immediately; a running run moves to cancel_requested so the Kaseki execution host can handle cancellation through its existing runtime path. This records control-plane intent and does not immediately terminate a Docker process.",
    inputSchema: RunIdInputSchema,
    outputSchema: z.union([RunDetailOutputSchema, ToolErrorOutputSchema]),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ runId }) => executeTool(async () => {
    const result = await requestRunCancellation(env, runId);
    return mcpRunDetail(result.row);
  }));

  return server;
}

function mcpRunSummary(row: RunRow): Record<string, unknown> {
  return {
    runId: row.id,
    status: row.status,
    createdAt: row.created_at,
    repoUrl: safeUrlForMcp(row.repo_url),
    ref: row.git_ref,
    publishMode: row.publish_mode,
  };
}

function mcpRunListItem(row: RunRow): Record<string, unknown> {
  return mcpRunFields(row);
}

function mcpRunFields(row: RunRow): Record<string, unknown> {
  return {
    runId: row.id,
    repoUrl: safeUrlForMcp(row.repo_url),
    ref: row.git_ref,
    status: row.status,
    stage: row.stage,
    taskMode: row.task_mode,
    publishMode: row.publish_mode,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mcpRunDetail(row: RunRow): Record<string, unknown> {
  const result = parseResult(row);
  const summary = typeof result?.summary === "string" ? result.summary : null;
  const publishedUrl = typeof result?.publishedUrl === "string" ? safeUrlForMcp(result.publishedUrl) : null;
  const changedFileCount = typeof result?.changedFileCount === "number" ? result.changedFileCount : null;
  return {
    ...mcpRunFields(row),
    updatedAt: row.updated_at,
    outcomeSummary: summary,
    publishedUrl,
    changedFileCount,
    failureClass: row.failure_class,
    cancellation: {
      state: row.status === "cancel_requested" ? "requested" : row.status === "cancelled" ? "cancelled" : "none",
      requestedAt: row.cancel_requested_at,
    },
  };
}

function safeUrlForMcp(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Do not echo malformed persisted values, which may contain embedded secrets.
    return "about:invalid";
  }
}

function mcpRunEvent(row: RunEventRow): Record<string, unknown> {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    type: row.type,
    stage: row.stage,
    step: row.step,
    timestamp: row.occurred_at,
    payload: mcpEventPayload(parseEventPayload(row)),
  };
}

function mcpEventPayload(payload: Record<string, unknown>): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!MCP_EVENT_PAYLOAD_KEYS.has(key)) continue;
    if (typeof value === "string" && value.length <= 160) safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "boolean") safe[key] = value;
  }
  return safe;
}

async function executeTool(operation: () => Promise<Record<string, unknown>>) {
  try {
    const result = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    const mapped = error instanceof RunApplicationError
      ? error
      : new RunApplicationError(503, "RUN_OPERATION_UNAVAILABLE", "Soyuz could not reach a required service to complete this operation. Retry shortly; if this continues, contact the service administrator.", undefined, true);
    const structuredContent = {
      error: {
        code: mapped.code,
        message: mapped.publicMessage,
        retryable: mapped.retryable,
        ...(mapped.details !== undefined ? { details: mapped.details } : {}),
      },
    };
    return {
      isError: true,
      content: [{ type: "text" as const, text: mapped.publicMessage }],
      structuredContent,
    };
  }
}

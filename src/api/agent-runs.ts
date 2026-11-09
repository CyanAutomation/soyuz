import type { ZodType } from "zod";
import {
  createRun,
  listRunsPage,
  readRun,
  readRunEventsPage,
  requestRunCancellation,
  RunApplicationError,
} from "../application/runs";
import { AgentCreateRunInputSchema } from "../contracts/run-request";
import { parseEventPayload, parseResult, type RunEventRow, type RunRow } from "../db/runs";
import type { Env } from "../env";
import { safeUrlForDisplay } from "../lib/safe-url";
import { isUuid } from "../lib/uuid";
import {
  AgentCancelRunOutputSchema,
  AgentCreateRunOutputSchema,
  AgentGetRunEventsOutputSchema,
  AgentGetRunOutputSchema,
  AgentListRunsOutputSchema,
} from "../contracts/agent-tools";
import { ApiError, errorResponse, jsonResponse, parseJsonBody, validationDetails } from "./http";

const AGENT_RUN_ORIGIN = { type: "api_client", id: "utcp-agent" } as const;

const AGENT_EVENT_PAYLOAD_KEYS = new Set([
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

export async function handleAgentRuns(request: Request, env: Env, url: URL, requestId: string): Promise<Response | null> {
  if (url.pathname === "/v1/agent/runs" && request.method === "POST") {
    return submitAgentRun(request, env, requestId);
  }
  if (url.pathname === "/v1/agent/runs" && request.method === "GET") {
    return listAgentRuns(url, env, requestId);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[0] !== "v1" || segments[1] !== "agent" || segments[2] !== "runs") return null;
  const runId = segments[3];
  if (!isUuid(runId)) return errorResponse(requestId, 404, "RUN_NOT_FOUND", "Run was not found");

  if (segments.length === 4 && request.method === "GET") return getAgentRun(runId, env, requestId);
  if (segments.length === 5 && segments[4] === "events" && request.method === "GET") {
    return getAgentRunEvents(runId, url, env, requestId);
  }
  if (segments.length === 5 && segments[4] === "cancel" && request.method === "POST") {
    return cancelAgentRun(runId, env, requestId);
  }
  return null;
}

async function submitAgentRun(request: Request, env: Env, requestId: string): Promise<Response> {
  try {
    const body = await parseJsonBody(request, requestId);
    const parsed = AgentCreateRunInputSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(requestId, 422, "INVALID_RUN_REQUEST", "Run request failed validation", {
        details: validationDetails(parsed.error.issues),
      });
    }
    const admission = await createRun(env, {
      ...parsed.data,
      publishMode: parsed.data.publishMode ?? "none",
    }, requestId, request.headers.get("idempotency-key"), AGENT_RUN_ORIGIN);
    return agentSuccessResponse(requestId, AgentCreateRunOutputSchema, agentRunSummary(admission.row), admission.statusCode);
  } catch (error) {
    return applicationErrorResponse(error, requestId);
  }
}

async function listAgentRuns(url: URL, env: Env, requestId: string): Promise<Response> {
  try {
    const page = await listRunsPage(env, {
      limit: url.searchParams.get("limit"),
      status: url.searchParams.get("status"),
      cursor: url.searchParams.get("cursor"),
    });
    return agentSuccessResponse(requestId, AgentListRunsOutputSchema, {
      runs: page.rows.map(agentRunListItem),
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    return applicationErrorResponse(error, requestId);
  }
}

async function getAgentRun(runId: string, env: Env, requestId: string): Promise<Response> {
  try {
    return agentSuccessResponse(requestId, AgentGetRunOutputSchema, agentRunDetail(await readRun(env, runId)));
  } catch (error) {
    return applicationErrorResponse(error, requestId);
  }
}

async function getAgentRunEvents(runId: string, url: URL, env: Env, requestId: string): Promise<Response> {
  try {
    const page = await readRunEventsPage(env, runId, {
      after: url.searchParams.get("after"),
      limit: url.searchParams.get("limit"),
    });
    return agentSuccessResponse(requestId, AgentGetRunEventsOutputSchema, {
      runId,
      displayId: page.run.display_id,
      events: page.events.map(agentRunEvent),
      nextAfter: page.nextAfter,
      hasMore: page.hasMore,
    });
  } catch (error) {
    return applicationErrorResponse(error, requestId);
  }
}

async function cancelAgentRun(runId: string, env: Env, requestId: string): Promise<Response> {
  try {
    const result = await requestRunCancellation(env, runId, AGENT_RUN_ORIGIN);
    return agentSuccessResponse(requestId, AgentCancelRunOutputSchema, agentRunDetail(result.row), result.statusCode);
  } catch (error) {
    return applicationErrorResponse(error, requestId);
  }
}

function applicationErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) return error.toResponse(requestId);
  if (error instanceof RunApplicationError) {
    return errorResponse(requestId, error.status, error.code, error.publicMessage, { details: error.details });
  }
  return errorResponse(requestId, 503, "RUN_OPERATION_UNAVAILABLE", "Soyuz could not reach a required service to complete the run operation. Retry shortly; if this continues, contact the service administrator.");
}

function agentSuccessResponse<T extends ZodType>(
  requestId: string,
  schema: T,
  data: unknown,
  status = 200,
): Response {
  const result = schema.safeParse({ data, requestId });
  if (!result.success) {
    return errorResponse(requestId, 500, "AGENT_RESPONSE_INVALID", "Soyuz could not safely return this agent response.");
  }
  return jsonResponse(status, result.data);
}

function agentRunSummary(row: RunRow): Record<string, unknown> {
  return {
    runId: row.id,
    displayId: row.display_id,
    status: row.status,
    createdAt: row.created_at,
    repoUrl: safeUrlForDisplay(row.repo_url),
    ref: row.git_ref,
    publishMode: row.publish_mode,
  };
}

function agentRunListItem(row: RunRow): Record<string, unknown> {
  return {
    runId: row.id,
    displayId: row.display_id,
    repoUrl: safeUrlForDisplay(row.repo_url),
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

function agentRunDetail(row: RunRow): Record<string, unknown> {
  const result = parseResult(row);
  const summary = typeof result?.summary === "string" ? result.summary : null;
  const publishedUrl = typeof result?.publishedUrl === "string" ? safeUrlForDisplay(result.publishedUrl) : null;
  const changedFileCount = typeof result?.changedFileCount === "number" ? result.changedFileCount : null;
  return {
    ...agentRunListItem(row),
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

function agentRunEvent(row: RunEventRow): Record<string, unknown> {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    type: row.type,
    stage: row.stage,
    step: row.step,
    timestamp: row.occurred_at,
    payload: agentEventPayload(parseEventPayload(row)),
  };
}

function agentEventPayload(payload: Record<string, unknown>): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!AGENT_EVENT_PAYLOAD_KEYS.has(key)) continue;
    if (typeof value === "string" && value.length <= 160) safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === "boolean") safe[key] = value;
  }
  return safe;
}

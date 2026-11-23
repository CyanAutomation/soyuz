import { readRun, RunApplicationError } from "../application/runs";
import { ApiError, errorResponse, parseJsonBody, requestIdFor, successResponse } from "../api/http";
import { parseResult } from "../db/runs";
import type { Env } from "../env";
import { SenkuDecisionError, requestSenkuDecision, type SenkuUsage } from "./senku-client";
import { JevProfileIdSchema, type JevProfileId } from "./profiles";
import { z } from "zod";

const DecisionRequestSchema = z.object({
  profileId: JevProfileIdSchema,
  runId: z.string().uuid(),
}).strict();

export async function handleJevAnalysisRequest(
  request: Request,
  env: Env,
  requestId = requestIdFor(request),
  senkuBinding: Env["SENKU"] | undefined = env.SENKU,
): Promise<Response> {
  let body: unknown;
  try {
    body = await parseJsonBody(request, requestId);
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse(requestId);
    return errorResponse(requestId, 400, "INVALID_REQUEST", "Decision request is invalid.");
  }
  const parsed = DecisionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(requestId, 400, "INVALID_REQUEST", "Decision request must contain an approved profile and a run UUID.");
  }

  const startedAt = Date.now();
  let outcome = "error";
  let model: string | undefined;
  let safeErrorCode: string | undefined;
  let senkuRequestId: string | undefined;
  let providerAttemptCount = 0;
  let usage: SenkuUsage | undefined;

  try {
    const row = await readRun(env, parsed.data.runId);
    let sourceRow: RetainedRun | undefined;
    if (parsed.data.profileId === "run_retry_review_v1") {
      if (!row.retry_of) throw new RunApplicationError(409, "JEV_PROFILE_NOT_APPLICABLE", "Retry comparison is available only for runs linked to an earlier run.");
      try {
        sourceRow = await readRun(env, row.retry_of);
      } catch (error) {
        if (error instanceof RunApplicationError && error.status === 404) {
          throw new RunApplicationError(409, "JEV_PROFILE_NOT_APPLICABLE", "The source run for this retry is no longer available.");
        }
        throw error;
      }
      if (sourceRow.origin_type !== row.origin_type || sourceRow.origin_id !== row.origin_id) {
        throw new RunApplicationError(409, "JEV_PROFILE_NOT_APPLICABLE", "Retry comparison is unavailable for this run relationship.");
      }
    }
    const input = buildSenkuInput(parsed.data.profileId, row, sourceRow);
    const decision = await requestSenkuDecision(env, parsed.data.profileId, input, senkuBinding);
    outcome = "success";
    model = decision.model;
    senkuRequestId = decision.requestId;
    providerAttemptCount = decision.attemptCount;
    usage = decision.usage;
    return successResponse(requestId, { model: decision.model, answers: decision.answers });
  } catch (error) {
    if (error instanceof RunApplicationError) {
      safeErrorCode = error.code;
      outcome = error.code.toLowerCase();
      return errorResponse(requestId, error.status, error.code, error.publicMessage, { details: error.details });
    }
    if (error instanceof SenkuDecisionError) {
      safeErrorCode = error.code;
      senkuRequestId = error.senkuRequestId;
      outcome = error.code.toLowerCase();
      switch (error.code) {
        case "NOT_CONFIGURED":
          return errorResponse(requestId, 503, "JEV_UNAVAILABLE", "JEV analysis is not configured. Contact your Soyuz administrator.");
        case "PROVIDER_TIMEOUT":
          return errorResponse(requestId, 504, "JEV_PROVIDER_TIMEOUT", "JEV analysis timed out. Retry shortly.");
        case "PROVIDER_UNAVAILABLE":
          return errorResponse(requestId, 502, "JEV_PROVIDER_UNAVAILABLE", "JEV analysis could not reach Senku.");
        case "INVALID_RESPONSE":
          return errorResponse(requestId, 502, "JEV_RESPONSE_INVALID", "Senku returned an unsupported decision response.");
        case "INVALID_REQUEST":
          return errorResponse(requestId, 500, "JEV_REQUEST_INVALID", "Soyuz could not prepare the approved decision request.");
      }
    }
    outcome = "context_unavailable";
    safeErrorCode = "JEV_CONTEXT_UNAVAILABLE";
    return errorResponse(requestId, 503, "JEV_CONTEXT_UNAVAILABLE", "Soyuz could not prepare run data for JEV analysis.");
  } finally {
    console.info(JSON.stringify({
      event: "soyuz_jev_decision",
      backend: "senku",
      profileId: parsed.data.profileId,
      ...(model ? { model } : {}),
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome,
      ...(safeErrorCode ? { errorCode: safeErrorCode } : {}),
      providerAttemptCount,
      ...(senkuRequestId ? { senkuRequestId } : {}),
      ...(usage ? { usage } : {}),
    }));
  }
}

type RetainedRun = Awaited<ReturnType<typeof readRun>>;

export function buildSenkuInput(profileId: JevProfileId, row: RetainedRun, sourceRow?: RetainedRun): Record<string, unknown> {
  switch (profileId) {
    case "run_operations_triage_v1":
      return {
        run: {
          status: row.status,
          stage: row.stage,
          operationalHealth: row.operational_health,
          failureClass: row.failure_class,
          createdAt: row.created_at,
          queuedAt: row.queued_at,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          lastHeartbeatAt: row.last_heartbeat_at,
        },
      };
    case "kaseki_output_review_v1":
    case "kaseki_output_review_v2": {
      const result = parseResult(row);
      const summary = typeof result?.summary === "string"
        ? Array.from(result.summary).slice(0, 2_000).join("")
        : null;
      const changedFileCount = typeof result?.changedFileCount === "number"
        && Number.isSafeInteger(result.changedFileCount)
        && result.changedFileCount >= 0
        && result.changedFileCount <= 1_000_000
        ? result.changedFileCount
        : null;
      return {
        canonicalRun: {
          status: row.status,
          failureClass: row.failure_class,
          exitCode: row.exit_code,
          changedFileCount,
        },
        summary,
      };
    }
    case "run_retry_review_v1": {
      if (!sourceRow) throw new RunApplicationError(409, "JEV_PROFILE_NOT_APPLICABLE", "Retry comparison is unavailable for this run.");
      return { retryComparison: { source: retryEvidence(sourceRow), retry: retryEvidence(row) } };
    }
    default:
      return assertNever(profileId);
  }
}

function retryEvidence(row: RetainedRun): Record<string, unknown> {
  const result = parseResult(row);
  const summary = typeof result?.summary === "string"
    ? Array.from(result.summary).slice(0, 2_000).join("")
    : null;
  const changedFileCount = typeof result?.changedFileCount === "number"
    && Number.isSafeInteger(result.changedFileCount)
    && result.changedFileCount >= 0
    && result.changedFileCount <= 1_000_000
    ? result.changedFileCount
    : null;
  const exitCode = typeof row.exit_code === "number" && Number.isInteger(row.exit_code)
    && row.exit_code >= -1 && row.exit_code <= 255 ? row.exit_code : null;
  return {
    status: row.status,
    failureClass: typeof row.failure_class === "string" && row.failure_class.length <= 128 ? row.failure_class : null,
    exitCode,
    changedFileCount,
    summary,
  };
}

function assertNever(value: never): never {
  void value;
  throw new Error("Unsupported JEV profile.");
}

import { parseRunOutcomeSummaryJson, type RunOutcomeSummary } from "../contracts/run-outcome";
import { listRecentRunOutcomeRows, readRunOutcomeAggregate } from "../db/run-outcomes";
import type { RunRow } from "../db/runs";
import type { Env } from "../env";
import { MAX_RUN_PAGE_SIZE } from "../persistence/retention-policy";
import { safeUrlForDisplay } from "../lib/safe-url";
import { errorResponse, successResponse } from "./http";

export async function handleRunOutcomes(
  request: Request,
  env: Env,
  requestId: string,
  runProjectionLimit = MAX_RUN_PAGE_SIZE,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/run-outcomes") return null;
  if (request.method !== "GET") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Run outcome history accepts GET requests.");

  const limit = Math.min(MAX_RUN_PAGE_SIZE, Math.max(1, Math.trunc(runProjectionLimit)));
  try {
    const asOf = new Date().toISOString();
    const [aggregate, rows] = await Promise.all([
      readRunOutcomeAggregate(env.DB, asOf),
      listRecentRunOutcomeRows(env.DB, asOf, limit),
    ]);
    const runs = rows.map((row) => publicOutcomeRun(row, parseRunOutcomeSummaryJson(row.outcome_summary_json)));

    return successResponse(requestId, {
      scope: {
        retainedRuns: aggregate.retainedRuns,
        includedRuns: aggregate.retainedRuns,
        runsWithOutcomeSummary: aggregate.runsWithOutcomeSummary,
        returnedRuns: runs.length,
        runsTruncated: aggregate.retainedRuns > runs.length,
      },
      byAssessment: aggregate.byAssessment,
      byReviewerConfidence: aggregate.byReviewerConfidence,
      byGrade: aggregate.byGrade,
      averageScore: aggregate.scoreCount
        ? Math.round((aggregate.scoreTotal / aggregate.scoreCount) * 10) / 10
        : null,
      improvementCategories: aggregate.improvementCategories,
      phaseDurations: aggregate.phaseTotals
        .map(({ phase, count, totalMs }) => ({ phase, count, averageMs: Math.round(totalMs / count) }))
        .sort((left, right) => right.averageMs - left.averageMs || left.phase.localeCompare(right.phase)),
      runs,
    });
  } catch {
    return errorResponse(requestId, 503, "RUN_OUTCOMES_UNAVAILABLE", "Soyuz could not read retained run outcome summaries. Retry shortly.");
  }
}

function publicOutcomeRun(row: RunRow, outcome: RunOutcomeSummary | undefined) {
  return {
    id: row.id,
    displayId: row.display_id,
    repoUrl: safeUrlForDisplay(row.repo_url),
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    artifactDeliveryStatus: row.artifact_delivery_status,
    outcomeSummary: outcome ?? null,
  };
}

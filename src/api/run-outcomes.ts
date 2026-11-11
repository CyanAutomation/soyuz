import { listRunsPage } from "../application/runs";
import type { Env } from "../env";
import { MAX_RETAINED_RUNS, parseResult } from "../db/runs";
import type { RunRow } from "../db/runs";
import { RunOutcomeSummarySchema, type RunOutcomeSummary } from "../contracts/run-outcome";
import { errorResponse, successResponse } from "./http";

export async function handleRunOutcomes(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/run-outcomes") return null;
  if (request.method !== "GET") return errorResponse(requestId, 405, "METHOD_NOT_ALLOWED", "Run outcome history accepts GET requests.");

  try {
    const page = await listRunsPage(env, { limit: MAX_RETAINED_RUNS });
    const runs = page.rows.map((row) => ({ row, outcome: outcomeFromRow(row) }));
    const withOutcomes = runs.filter(({ outcome }) => outcome !== undefined);
    const assessments: Record<string, number> = {};
    const confidences: Record<string, number> = {};
    const grades: Record<string, number> = {};
    const phaseTotals = new Map<string, { count: number; totalMs: number }>();
    const opportunities = new Map<string, { category: string; priority: string; count: number }>();
    let scoreTotal = 0;
    let scoreCount = 0;

    for (const { outcome } of withOutcomes) {
      const evaluation = outcome?.evaluation;
      if (evaluation) {
        increment(assessments, evaluation.assessment);
        increment(confidences, evaluation.reviewerConfidence);
        for (const item of evaluation.improvementCategories) {
          const key = `${item.category}\0${item.priority}`;
          const group = opportunities.get(key) ?? { category: item.category, priority: item.priority, count: 0 };
          group.count += item.count;
          opportunities.set(key, group);
        }
      }
      const scorecard = outcome?.scorecard;
      if (scorecard) {
        increment(grades, scorecard.grade);
        scoreTotal += scorecard.score;
        scoreCount += 1;
      }
      for (const [phase, durationMs] of Object.entries(outcome?.phaseDurationMs ?? {})) {
        if (durationMs === undefined) continue;
        const aggregate = phaseTotals.get(phase) ?? { count: 0, totalMs: 0 };
        aggregate.count += 1;
        aggregate.totalMs += durationMs;
        phaseTotals.set(phase, aggregate);
      }
    }

    return successResponse(requestId, {
      scope: {
        retainedRuns: MAX_RETAINED_RUNS,
        includedRuns: runs.length,
        runsWithOutcomeSummary: withOutcomes.length,
      },
      byAssessment: assessments,
      byReviewerConfidence: confidences,
      byGrade: grades,
      averageScore: scoreCount ? Math.round((scoreTotal / scoreCount) * 10) / 10 : null,
      improvementCategories: [...opportunities.values()]
        .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
        .slice(0, 20),
      phaseDurations: [...phaseTotals.entries()]
        .map(([phase, total]) => ({ phase, count: total.count, averageMs: Math.round(total.totalMs / total.count) }))
        .sort((left, right) => right.averageMs - left.averageMs || left.phase.localeCompare(right.phase)),
      runs: runs.map(({ row, outcome }) => publicOutcomeRun(row, outcome)),
    });
  } catch {
    return errorResponse(requestId, 503, "RUN_OUTCOMES_UNAVAILABLE", "Soyuz could not read retained run outcome summaries. Retry shortly.");
  }
}

function outcomeFromRow(row: RunRow): RunOutcomeSummary | undefined {
  try {
    const result = parseResult(row);
    const parsed = RunOutcomeSummarySchema.safeParse(result?.outcomeSummary);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function publicOutcomeRun(row: RunRow, outcome: RunOutcomeSummary | undefined) {
  return {
    id: row.id,
    displayId: row.display_id,
    repoUrl: row.repo_url,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    outcomeSummary: outcome ?? null,
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

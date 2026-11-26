import type { RunRow } from "./runs";

type OutcomeAggregateRow = {
  retained_runs: number;
  runs_with_outcome_summary: number;
  score_total: number | null;
  score_count: number;
  by_assessment_json: string;
  by_reviewer_confidence_json: string;
  by_grade_json: string;
  improvement_categories_json: string;
  phase_totals_json: string;
};

export interface RunOutcomeAggregate {
  retainedRuns: number;
  runsWithOutcomeSummary: number;
  scoreTotal: number;
  scoreCount: number;
  byAssessment: Record<string, number>;
  byReviewerConfidence: Record<string, number>;
  byGrade: Record<string, number>;
  improvementCategories: Array<{ category: string; priority: string; count: number }>;
  phaseTotals: Array<{ phase: string; count: number; totalMs: number }>;
}

const OUTCOME_AGGREGATE_SQL = `
  WITH summaries AS (
    SELECT outcome_summary_json AS summary
    FROM runs
    WHERE expires_at > ? AND outcome_summary_json IS NOT NULL
  )
  SELECT
    (SELECT COUNT(*) FROM runs WHERE expires_at > ?) AS retained_runs,
    (SELECT COUNT(*) FROM summaries) AS runs_with_outcome_summary,
    (SELECT COALESCE(SUM(json_extract(summary, '$.scorecard.score')), 0)
      FROM summaries
      WHERE json_type(summary, '$.scorecard.score') IN ('integer', 'real')) AS score_total,
    (SELECT COUNT(*)
      FROM summaries
      WHERE json_type(summary, '$.scorecard.score') IN ('integer', 'real')) AS score_count,
    COALESCE((
      SELECT json_group_object(metric, tally)
      FROM (
        SELECT json_extract(summary, '$.evaluation.assessment') AS metric, COUNT(*) AS tally
        FROM summaries
        WHERE json_type(summary, '$.evaluation.assessment') = 'text'
        GROUP BY metric
      )
    ), '{}') AS by_assessment_json,
    COALESCE((
      SELECT json_group_object(metric, tally)
      FROM (
        SELECT json_extract(summary, '$.evaluation.reviewerConfidence') AS metric, COUNT(*) AS tally
        FROM summaries
        WHERE json_type(summary, '$.evaluation.reviewerConfidence') = 'text'
        GROUP BY metric
      )
    ), '{}') AS by_reviewer_confidence_json,
    COALESCE((
      SELECT json_group_object(metric, tally)
      FROM (
        SELECT json_extract(summary, '$.scorecard.grade') AS metric, COUNT(*) AS tally
        FROM summaries
        WHERE json_type(summary, '$.scorecard.grade') = 'text'
        GROUP BY metric
      )
    ), '{}') AS by_grade_json,
    COALESCE((
      SELECT json_group_array(json_object('category', category, 'priority', priority, 'count', tally))
      FROM (
        SELECT json_extract(item.value, '$.category') AS category,
          json_extract(item.value, '$.priority') AS priority,
          SUM(json_extract(item.value, '$.count')) AS tally
        FROM summaries AS summary_row,
          json_each(summary_row.summary, '$.evaluation.improvementCategories') AS item
        WHERE json_type(item.value, '$.category') = 'text'
          AND json_type(item.value, '$.priority') = 'text'
          AND json_type(item.value, '$.count') = 'integer'
        GROUP BY category, priority
        ORDER BY tally DESC, category ASC, priority ASC
        LIMIT 20
      )
    ), '[]') AS improvement_categories_json,
    COALESCE((
      SELECT json_group_array(json_object('phase', phase, 'count', tally, 'totalMs', total_ms))
      FROM (
        SELECT item.key AS phase, COUNT(*) AS tally, SUM(item.value) AS total_ms
        FROM summaries AS summary_row,
          json_each(summary_row.summary, '$.phaseDurationMs') AS item
        WHERE item.type IN ('integer', 'real')
        GROUP BY phase
      )
    ), '[]') AS phase_totals_json
`;

export async function readRunOutcomeAggregate(db: D1Database, asOf: string): Promise<RunOutcomeAggregate> {
  const row = await db.prepare(OUTCOME_AGGREGATE_SQL).bind(asOf, asOf).first<OutcomeAggregateRow>();
  if (!row) throw new Error("D1 did not return the run outcome aggregate row");

  return {
    retainedRuns: Number(row.retained_runs),
    runsWithOutcomeSummary: Number(row.runs_with_outcome_summary),
    scoreTotal: Number(row.score_total ?? 0),
    scoreCount: Number(row.score_count),
    byAssessment: parseCountRecord(row.by_assessment_json),
    byReviewerConfidence: parseCountRecord(row.by_reviewer_confidence_json),
    byGrade: parseCountRecord(row.by_grade_json),
    improvementCategories: parseJsonArray(row.improvement_categories_json, isImprovementCategory),
    phaseTotals: parseJsonArray(row.phase_totals_json, isPhaseTotal),
  };
}

export async function listRecentRunOutcomeRows(db: D1Database, asOf: string, limit: number): Promise<RunRow[]> {
  const rows = await db.prepare(`
    SELECT * FROM runs
    WHERE expires_at > ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).bind(asOf, limit).all<RunRow>();
  return rows.results ?? [];
}

function parseCountRecord(value: string): Record<string, number> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new TypeError("D1 returned invalid grouped outcome counts");
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(parsed)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("D1 returned an invalid grouped outcome count");
    }
    counts[key] = count;
  }
  return counts;
}

function parseJsonArray<T>(value: string, isValue: (candidate: unknown) => candidate is T): T[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(isValue)) {
    throw new TypeError("D1 returned an invalid run outcome aggregate");
  }
  return parsed;
}

function isImprovementCategory(value: unknown): value is RunOutcomeAggregate["improvementCategories"][number] {
  return isRecord(value)
    && typeof value.category === "string"
    && typeof value.priority === "string"
    && typeof value.count === "number"
    && Number.isSafeInteger(value.count)
    && value.count > 0;
}

function isPhaseTotal(value: unknown): value is RunOutcomeAggregate["phaseTotals"][number] {
  return isRecord(value)
    && typeof value.phase === "string"
    && typeof value.count === "number"
    && Number.isSafeInteger(value.count)
    && value.count > 0
    && typeof value.totalMs === "number"
    && Number.isFinite(value.totalMs)
    && value.totalMs >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

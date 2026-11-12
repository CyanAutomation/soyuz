import { z } from "zod";

export const RunOutcomeSummarySchema = z.object({
  schemaVersion: z.literal(1),
  scorecard: z.object({
    score: z.number().min(0).max(100),
    grade: z.enum(["A", "B", "C", "D", "F"]),
    rubricVersion: z.string().min(1).max(100),
    completeness: z.enum(["complete", "provisional", "not_applicable", "unavailable"]),
    confidence: z.number().min(0).max(100),
    scoredAt: z.string().datetime({ offset: true }),
  }).strict().optional(),
  evaluation: z.object({
    assessment: z.enum(["excellent", "good", "mixed", "poor", "unknown"]),
    reviewerConfidence: z.enum(["high", "medium", "low", "unknown"]),
    taskCompletionScore: z.number().int().min(1).max(5).optional(),
    improvementCategories: z.array(z.object({
      category: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      priority: z.enum(["low", "medium", "high", "unknown"]),
      count: z.number().int().positive().max(10_000),
    }).strict()).max(20),
  }).strict().optional(),
  phaseDurationMs: z.partialRecord(
    z.enum(["goal_setting", "scouting", "coding", "validation", "goal_check", "run_evaluation"]),
    z.number().finite().nonnegative().max(86_400_000),
  ).optional(),
}).strict().refine((value) => Boolean(value.scorecard || value.evaluation), {
  message: "Outcome summary must contain scorecard or evaluation data",
});

export type RunOutcomeSummary = z.infer<typeof RunOutcomeSummarySchema>;

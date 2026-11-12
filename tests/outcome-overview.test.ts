import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { createOutcomeOverviewCard, type RunOutcomesOverview } from "../dashboard/outcome-overview";

describe("shared run outcome overview", () => {
  it("renders aggregate evidence through shared card, badge, and definition-list primitives", () => {
    const { document } = parseHTML("<html><body></body></html>");
    const card = createOutcomeOverviewCard({
      scope: { retainedRuns: 30, includedRuns: 12, runsWithOutcomeSummary: 8 },
      byAssessment: { good: 5, mixed: 2, poor: 1 },
      byReviewerConfidence: { high: 5, medium: 2, low: 1 },
      byGrade: { A: 3, B: 4, C: 1 },
      averageScore: 84.5,
      improvementCategories: [{ category: "validation", priority: "medium", count: 6 }],
      phaseDurations: [{ phase: "coding", count: 8, averageMs: 120_000 }],
    }, document);

    expect(card.className).toContain("card--structured");
    expect(card.querySelector(".badge")?.textContent).toBe("8 of 12 runs with outcome data");
    expect(card.textContent).toContain("Average score");
    expect(card.textContent).toContain("84.5 / 100");
    expect(card.textContent).toContain("Validation · Medium · 6");
    expect(card.textContent).toContain("Coding · 8 runs · 2 min average");
  });

  it("shows an explicit empty state when retained runs have no outcome data", () => {
    const { document } = parseHTML("<html><body></body></html>");
    const empty: RunOutcomesOverview = {
      scope: { retainedRuns: 30, includedRuns: 0, runsWithOutcomeSummary: 0 },
      byAssessment: {}, byReviewerConfidence: {}, byGrade: {}, averageScore: null,
      improvementCategories: [], phaseDurations: [],
    };
    const card = createOutcomeOverviewCard(empty, document);
    expect(card.textContent).toContain("No outcome summaries have been reported in the retained run window.");
  });
});

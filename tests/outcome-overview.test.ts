import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { createOutcomeOverviewCard, type RunOutcomesOverview } from "../dashboard/outcome-overview";

describe("shared run outcome overview", () => {
  it("[DASHBOARD-OUTCOME-OVERVIEW-01] presents the retained outcome aggregates in readable content", () => {
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

    expect(card.querySelector("h2")?.textContent).toBe("Recent outcome overview");
    expect(card.textContent).toContain("Based on the newest 30 retained runs; currently includes 12.");
    expect(card.textContent).toContain("8 of 12 runs with outcome data");
    expect(definitionValue(card, "Average score")).toBe("84.5 / 100");
    expect(definitionValue(card, "Assessments")).toBe("Good · 5, Mixed · 2, Poor · 1");
    expect(definitionValue(card, "Reviewer confidence")).toBe("High · 5, Low · 1, Medium · 2");
    expect(definitionValue(card, "Scorecard grades")).toBe("A · 3, B · 4, C · 1");
    expect([...card.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Validation · Medium · 6",
      "Coding · 8 runs · 2 min average",
    ]);
  });

  it("[DASHBOARD-OUTCOME-OVERVIEW-01] explains the empty state when no runs have outcome data", () => {
    const { document } = parseHTML("<html><body></body></html>");
    const empty: RunOutcomesOverview = {
      scope: { retainedRuns: 30, includedRuns: 0, runsWithOutcomeSummary: 0 },
      byAssessment: {}, byReviewerConfidence: {}, byGrade: {}, averageScore: null,
      improvementCategories: [], phaseDurations: [],
    };
    const card = createOutcomeOverviewCard(empty, document);
    expect(card.querySelector("h2")?.textContent).toBe("Recent outcome overview");
    expect(card.textContent).toContain("0 of 0 runs with outcome data");
    expect(card.textContent).toContain("No outcome summaries have been reported in the retained run window.");
    expect(definitionValue(card, "Average score")).toBe("Not reported");
    expect(definitionValue(card, "Assessments")).toBe("Not reported");
    expect(definitionValue(card, "Reviewer confidence")).toBe("Not reported");
    expect(definitionValue(card, "Scorecard grades")).toBe("Not reported");
  });
});

function definitionValue(card: HTMLElement, label: string): string {
  const term = [...card.querySelectorAll("dt")].find((item) => item.textContent === label);
  return term?.nextElementSibling?.textContent ?? "";
}

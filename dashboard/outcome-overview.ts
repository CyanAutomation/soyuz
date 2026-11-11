import { createBadge, createCard, createDefinitionList } from "./ui/components.js";
import { formatMachineLabel } from "./presentation.js";

export interface RunOutcomesOverview {
  scope: { retainedRuns: number; includedRuns: number; runsWithOutcomeSummary: number };
  byAssessment: Record<string, number>;
  byReviewerConfidence: Record<string, number>;
  byGrade: Record<string, number>;
  averageScore: number | null;
  improvementCategories: Array<{ category: string; priority: string; count: number }>;
  phaseDurations: Array<{ phase: string; count: number; averageMs: number }>;
}

/** Present the canonical retained-window aggregates using the shared dashboard primitives. */
export function createOutcomeOverviewCard(
  overview: RunOutcomesOverview,
  ownerDocument: Document = document,
): HTMLElement {
  const { element, header, body } = createCard({ className: "outcome-overview" }, ownerDocument);
  const title = ownerDocument.createElement("h2");
  title.className = "card__title";
  title.textContent = "Recent outcome overview";
  header.append(title, createBadge(
    `${overview.scope.runsWithOutcomeSummary} of ${overview.scope.includedRuns} runs with outcome data`,
    overview.scope.runsWithOutcomeSummary > 0 ? "success" : "neutral",
    ownerDocument,
  ));

  const windowNote = ownerDocument.createElement("p");
  windowNote.className = "meta outcome-overview__scope";
  windowNote.textContent = `Based on the newest ${overview.scope.retainedRuns} retained runs; currently includes ${overview.scope.includedRuns}.`;
  body.append(windowNote);

  const facts = createDefinitionList([
    ["Average score", overview.averageScore === null ? "Not reported" : `${overview.averageScore.toFixed(1)} / 100`],
    ["Assessments", formatCounts(overview.byAssessment)],
    ["Reviewer confidence", formatCounts(overview.byReviewerConfidence)],
    ["Scorecard grades", formatCounts(overview.byGrade)],
  ], "data-list outcome-overview__facts", ownerDocument);
  body.append(facts);

  if (overview.scope.runsWithOutcomeSummary === 0) {
    const empty = ownerDocument.createElement("p");
    empty.className = "notice notice--empty outcome-overview__empty";
    empty.textContent = "No outcome summaries have been reported in the retained run window.";
    body.append(empty);
    return element;
  }

  if (overview.improvementCategories.length > 0) {
    body.append(createSummaryList(
      "Common improvement areas",
      overview.improvementCategories.slice(0, 5).map((item) =>
        `${formatMachineLabel(item.category)} · ${formatMachineLabel(item.priority)} · ${item.count}`),
      ownerDocument,
    ));
  }
  if (overview.phaseDurations.length > 0) {
    body.append(createSummaryList(
      "Average phase duration",
      overview.phaseDurations.slice(0, 5).map((item) =>
        `${formatMachineLabel(item.phase)} · ${item.count} runs · ${formatDuration(item.averageMs)} average`),
      ownerDocument,
    ));
  }
  return element;
}

function createSummaryList(titleText: string, lines: string[], ownerDocument: Document): HTMLElement {
  const section = ownerDocument.createElement("section");
  section.className = "outcome-overview__section";
  const heading = ownerDocument.createElement("h3");
  heading.textContent = titleText;
  const list = ownerDocument.createElement("ul");
  for (const line of lines) {
    const item = ownerDocument.createElement("li");
    item.textContent = line;
    list.append(item);
  }
  section.append(heading, list);
  return section;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, count]) => Number.isFinite(count) && count > 0);
  if (entries.length === 0) return "Not reported";
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${formatMachineLabel(key)} · ${count}`)
    .join(", ");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)} sec`;
  const minutes = durationMs / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

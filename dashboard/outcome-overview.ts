import { createBadge, createCard, createDefinitionList, createSummaryList as createReusableSummaryList } from "./ui/components.js";
import { formatMachineLabel } from "./presentation.js";
import { a2uiCard, a2uiColumn, a2uiList, a2uiText, createFixedA2uiSurface, type A2uiComponentDefinition } from "../a2ui/surface-primitives.js";

export interface RunOutcomesOverview {
  scope: { retainedRuns: number; includedRuns: number; runsWithOutcomeSummary: number };
  byAssessment: Record<string, number>;
  byReviewerConfidence: Record<string, number>;
  byGrade: Record<string, number>;
  averageScore: number | null;
  improvementCategories: Array<{ category: string; priority: string; count: number }>;
  phaseDurations: Array<{ phase: string; count: number; averageMs: number }>;
}

export interface OutcomeOverviewProjection {
  outcomes: {
    scopeSummary: string;
    retainedSummary: string;
    averageScore: string;
    metrics: Array<{ summary: string }>;
    improvementCategories: Array<{ summary: string }>;
    phaseDurations: Array<{ summary: string }>;
    emptySummary: string;
  };
}

/** Project server aggregates into bounded display strings for the fixed A2UI template. */
export function projectOutcomeOverview(overview: RunOutcomesOverview): OutcomeOverviewProjection {
  return {
    outcomes: {
      scopeSummary: `${count(overview.scope.runsWithOutcomeSummary)} of ${count(overview.scope.includedRuns)} runs with outcome data`,
      retainedSummary: `Based on the newest ${count(overview.scope.retainedRuns)} retained runs; currently includes ${count(overview.scope.includedRuns)}.`,
      averageScore: overview.averageScore === null || !Number.isFinite(overview.averageScore)
        ? "Not reported"
        : `${overview.averageScore.toFixed(1)} / 100`,
      metrics: [
        { summary: `Assessments · ${formatCounts(overview.byAssessment)}` },
        { summary: `Reviewer confidence · ${formatCounts(overview.byReviewerConfidence)}` },
        { summary: `Scorecard grades · ${formatCounts(overview.byGrade)}` },
      ],
      improvementCategories: overview.improvementCategories.slice(0, 5).map((item) => ({
        summary: `${formatMachineLabel(item.category)} · ${formatMachineLabel(item.priority)} · ${count(item.count)}`.slice(0, 240),
      })),
      phaseDurations: overview.phaseDurations.slice(0, 5).map((item) => ({
        summary: `${formatMachineLabel(item.phase)} · ${count(item.count)} runs · ${formatDuration(item.averageMs)} average`.slice(0, 240),
      })),
      emptySummary: overview.scope.runsWithOutcomeSummary > 0
        ? ""
        : "No outcome summaries have been reported in the retained run window.",
    },
  };
}

/** Fixed A2UI v1.0 template shared by every retained outcome overview. */
export function createOutcomeOverviewSurface(): unknown[] {
  const components: A2uiComponentDefinition[] = [
    a2uiColumn("root", ["heading", "scopeCard", "metricsCard", "improvementsCard", "phasesCard", "emptySummary"]),
    a2uiText("heading", "Recent outcome overview"),
    a2uiCard("scopeCard", "scopeContent"),
    a2uiColumn("scopeContent", ["scopeSummary", "retainedSummary", "averageScore"]),
    a2uiText("scopeSummary", { "@path": "/outcomes/scopeSummary" }),
    a2uiText("retainedSummary", { "@path": "/outcomes/retainedSummary" }),
    a2uiText("averageScore", { "@path": "/outcomes/averageScore" }),
    a2uiCard("metricsCard", "metricsContent"),
    a2uiColumn("metricsContent", ["metricsTitle", "metricsList"]),
    a2uiText("metricsTitle", "Outcome measures"),
    a2uiList("metricsList", "/outcomes/metrics", "metricRow"),
    a2uiText("metricRow", { "@path": "summary" }),
    a2uiCard("improvementsCard", "improvementsContent"),
    a2uiColumn("improvementsContent", ["improvementsTitle", "improvementsList"]),
    a2uiText("improvementsTitle", "Common improvement areas"),
    a2uiList("improvementsList", "/outcomes/improvementCategories", "improvementRow"),
    a2uiText("improvementRow", { "@path": "summary" }),
    a2uiCard("phasesCard", "phasesContent"),
    a2uiColumn("phasesContent", ["phasesTitle", "phasesList"]),
    a2uiText("phasesTitle", "Average phase duration"),
    a2uiList("phasesList", "/outcomes/phaseDurations", "phaseRow"),
    a2uiText("phaseRow", { "@path": "summary" }),
    a2uiText("emptySummary", { "@path": "/outcomes/emptySummary" }),
  ];
  return createFixedA2uiSurface("soyuz-outcome-overview", components);
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
    body.append(createReusableSummaryList(
      "Common improvement areas",
      overview.improvementCategories.slice(0, 5).map((item) =>
        `${formatMachineLabel(item.category)} · ${formatMachineLabel(item.priority)} · ${item.count}`),
      ownerDocument,
      "outcome-overview__section",
    ));
  }
  if (overview.phaseDurations.length > 0) {
    body.append(createReusableSummaryList(
      "Average phase duration",
      overview.phaseDurations.slice(0, 5).map((item) =>
        `${formatMachineLabel(item.phase)} · ${item.count} runs · ${formatDuration(item.averageMs)} average`),
      ownerDocument,
      "outcome-overview__section",
    ));
  }
  return element;
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
  if (!Number.isFinite(durationMs) || durationMs < 0) return "Not reported";
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)} sec`;
  const minutes = durationMs / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

function count(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

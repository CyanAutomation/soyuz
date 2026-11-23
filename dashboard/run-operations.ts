import { a2uiButton, a2uiCard, a2uiColumn, a2uiList, a2uiText, createFixedA2uiSurface, type A2uiComponentDefinition } from "../a2ui/surface-primitives.js";
import { getRunStatusPresentation, formatMachineLabel } from "./presentation.js";
import { calculateRunMetrics, formatDuration, type RunTimingInput } from "./run-metrics.js";

export interface RunOperationsPublication {
  state: string;
  attemptCount: number;
  nextAttemptAt: string | null;
}

export interface RunOperationsInput extends RunTimingInput {
  runId: string;
  displayId: string;
  repoUrl: string;
  ref: string;
  origin: { type: string; id: string };
  retryOf: string | null;
  stage: string | null;
  operationalHealth: "unknown" | "healthy" | "suspect_stalled";
  outcomeSummary?: string | null;
  failureMessage?: string | null;
  legacyPublished?: boolean;
  publication?: RunOperationsPublication | null;
}

export interface RunOperationsItem {
  runId: string;
  displayId: string;
  summary: string;
  publicationState: string | null;
}

export interface RunOperationsProjection {
  ops: {
    attentionSummary: string;
    attentionRuns: RunOperationsItem[];
    activeSummary: string;
    activeRuns: RunOperationsItem[];
    completedSummary: string;
    completedRuns: RunOperationsItem[];
    publicationSummary: string;
    publicationRuns: RunOperationsItem[];
  };
}

const MAX_RUNS = 30;

/** Project only bounded, presentation-ready fields into the fixed A2UI surface. */
export function projectRunOperations(
  runs: RunOperationsInput[],
  now = Date.now(),
  publicationStatusAvailable = true,
): RunOperationsProjection {
  const attentionRuns: RunOperationsItem[] = [];
  const activeRuns: RunOperationsItem[] = [];
  const completedRuns: RunOperationsItem[] = [];
  const publicationRuns: RunOperationsItem[] = [];

  for (const run of runs.slice(0, MAX_RUNS)) {
    const item = projectRun(run, now);
    const status = getRunStatusPresentation(run.status);
    const attention = run.status === "failed" || run.status === "admission_failed"
      || (status.active && run.operationalHealth === "suspect_stalled");
    if (attention) attentionRuns.push(item);
    else if (status.active) activeRuns.push(item);
    else if (run.status === "completed" || run.status === "cancelled") completedRuns.push(item);

    if (item.publicationState) publicationRuns.push(item);
  }

  return {
    ops: {
      attentionSummary: countSummary(attentionRuns.length, "run needs review", "runs need review", "No failed or stalled runs need attention."),
      attentionRuns,
      activeSummary: countSummary(activeRuns.length, "active run", "active runs", "No runs are currently active."),
      activeRuns,
      completedSummary: countSummary(completedRuns.length, "completed run", "completed runs", "No completed runs are in the retained window."),
      completedRuns,
      publicationSummary: publicationStatusAvailable
        ? countSummary(publicationRuns.length, "publication record", "publication records", "No publication records are in the retained window.")
        : "Publication status could not be loaded.",
      publicationRuns,
    },
  };
}

/** Fixed application-owned A2UI; no model prompt or run data is involved. */
export function createRunOperationsSurface(): unknown[] {
  const groups = [
    { id: "attention", title: "Needs attention", path: "/ops/attentionRuns", summary: "/ops/attentionSummary" },
    { id: "active", title: "Active runs", path: "/ops/activeRuns", summary: "/ops/activeSummary" },
    { id: "completed", title: "Completed runs", path: "/ops/completedRuns", summary: "/ops/completedSummary" },
    { id: "publication", title: "Publication status", path: "/ops/publicationRuns", summary: "/ops/publicationSummary" },
  ];
  const components: A2uiComponentDefinition[] = [
    a2uiColumn("root", ["heading", "groupList"]),
    a2uiText("heading", "Run operations"),
    a2uiColumn("groupList", groups.map((group) => `${group.id}Group`)),
  ];

  for (const group of groups) {
    components.push(
      a2uiCard(`${group.id}Group`, `${group.id}Content`),
      a2uiColumn(`${group.id}Content`, [`${group.id}Title`, `${group.id}Summary`, `${group.id}Runs`]),
      a2uiText(`${group.id}Title`, group.title),
      a2uiText(`${group.id}Summary`, { "@path": group.summary }),
      a2uiList(`${group.id}Runs`, group.path, `${group.id}Run`),
      a2uiCard(`${group.id}Run`, `${group.id}RunContent`),
      a2uiColumn(`${group.id}RunContent`, [`${group.id}DisplayId`, `${group.id}RunSummary`, `${group.id}ViewLabel`, `${group.id}ViewButton`]),
      a2uiText(`${group.id}DisplayId`, { "@path": "displayId" }),
      a2uiText(`${group.id}RunSummary`, { "@path": "summary" }),
      a2uiText(`${group.id}ViewLabel`, "View run"),
      a2uiButton(`${group.id}ViewButton`, `${group.id}ViewLabel`, "select_run", { runId: { "@path": "runId" } }),
    );
  }

  return createFixedA2uiSurface("soyuz-run-operations", components);
}

function projectRun(run: RunOperationsInput, now: number): RunOperationsItem {
  const metrics = calculateRunMetrics(run, now);
  const status = getRunStatusPresentation(run.status).label;
  const stage = run.stage ? formatMachineLabel(run.stage) : "Not reported";
  const outcome = typeof run.outcomeSummary === "string" ? run.outcomeSummary.slice(0, 240) : null;
  const publicationState = run.publication?.state
    ? formatMachineLabel(run.publication.state)
    : run.legacyPublished
      ? "Legacy published"
      : null;
  const facts = [
    status,
    `Stage ${stage}`,
    `Age ${formatDuration(metrics.runAgeMs)}`,
    `Queue ${formatDuration(metrics.queueDurationMs)}`,
    `Execution ${formatDuration(metrics.executionDurationMs)}`,
    `Heartbeat ${formatDuration(metrics.heartbeatAgeMs)}`,
    ...(outcome ? [`Outcome ${outcome}`] : []),
    ...(publicationState ? [`Publication ${publicationState}`] : []),
  ];

  return {
    runId: run.runId,
    displayId: run.displayId.slice(0, 80),
    summary: facts.join(" · "),
    publicationState,
  };
}

function countSummary(count: number, singular: string, plural: string, empty: string): string {
  if (count === 0) return empty;
  return `${count} ${count === 1 ? singular : plural}`;
}

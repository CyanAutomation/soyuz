import { a2uiButton, a2uiCard, a2uiColumn, a2uiList, a2uiRow, a2uiText, createFixedA2uiSurface, type A2uiComponentDefinition } from "../a2ui/surface-primitives.js";
import { formatEventLabel, formatEventPayloadValue, formatMachineLabel, formatTimestamp, getRunStatusPresentation } from "./presentation.js";

export interface RunDetailsSurfaceInput {
  run: {
    runId: string;
    displayId: string;
    status: string;
    stage: string | null;
    taskMode?: string | null;
    publishMode?: string | null;
    origin?: { type: string; id: string } | null;
    retryOf: string | null;
    outcomeSummary: string | null;
    failureClass: string | null;
    exitCode: number | null;
    changedFileCount: number | null;
    publicationStatusAvailable: boolean;
    publication: { state: string; attemptCount: number; nextAttemptAt: string | null } | null;
    legacyPublished: boolean;
  };
  events: Array<{
    sequence: number;
    type: string;
    stage: string | null;
    step: string | null;
    timestamp: string;
    payload: Record<string, string | number | boolean>;
  }>;
  artifacts: Array<{ id: string; name: string; size: number }>;
}

export interface RunDetailsSurfaceProjection {
  selectedRun: {
    runId: string;
    displayId: string;
    summary: string;
    publicationSummary: string;
    eventsSummary: string;
    artifactsSummary: string;
  };
  events: Array<{ summary: string }>;
  artifacts: Array<{ id: string; summary: string }>;
}

const SAFE_EVENT_FIELDS = new Set([
  "status", "percent", "progressPercent", "current", "total", "completed", "passed", "failed",
  "uploadedCount", "failedCount", "skippedCount", "exitCode", "durationMs", "changedFileCount", "failureClass",
]);
const MAX_EVENTS = 100;
const MAX_ARTIFACTS = 100;

/** Build a concise host projection; raw errors, URLs, origin IDs, and event payloads stay out. */
export function projectRunDetails(input: RunDetailsSurfaceInput): RunDetailsSurfaceProjection {
  const stage = input.run.stage ? formatMachineLabel(input.run.stage) : "Not reported";
  const status = getRunStatusPresentation(input.run.status).label;
  const summary = [
    `Status ${status}`,
    `Stage ${stage}`,
    input.run.retryOf ? "Retry run" : "Original run",
    input.run.failureClass ? `Failure class ${formatMachineLabel(input.run.failureClass)}` : null,
    input.run.taskMode ? `Task ${formatMachineLabel(input.run.taskMode)}` : null,
    input.run.publishMode ? `Publishing ${formatMachineLabel(input.run.publishMode)}` : null,
    input.run.exitCode === null ? null : `Exit code ${input.run.exitCode}`,
    input.run.changedFileCount === null ? null : `Changed files ${input.run.changedFileCount}`,
    input.run.outcomeSummary ? `Outcome ${input.run.outcomeSummary.slice(0, 1_000)}` : "No outcome summary was reported.",
  ].filter((part): part is string => part !== null).join(" · ").slice(0, 2_000);
  const publicationSummary = !input.run.publicationStatusAvailable
    ? "Publication status could not be loaded."
    : input.run.publication
      ? `Publication ${formatMachineLabel(input.run.publication.state)} · ${safeCount(input.run.publication.attemptCount)} attempts${input.run.publication.nextAttemptAt ? ` · next retry ${formatTimestamp(input.run.publication.nextAttemptAt)}` : ""}`
      : input.run.legacyPublished
        ? "Publication Legacy published"
        : "Publication No record";
  const events = input.events.slice(-MAX_EVENTS).map((event) => ({
    summary: [
      formatEventLabel(event.type),
      event.stage ? formatMachineLabel(event.stage) : null,
      event.step ? formatMachineLabel(event.step) : null,
      formatTimestamp(event.timestamp),
      ...safeEventSummaryFields(event.payload),
    ].filter(Boolean).join(" · ").slice(0, 1_000),
  }));
  const artifacts = input.artifacts.slice(0, MAX_ARTIFACTS).map((artifact) => ({
    id: artifact.id,
    summary: `${artifact.name.slice(0, 160)} · ${formatBytes(artifact.size)}`,
  }));

  return {
    selectedRun: {
      runId: input.run.runId,
      displayId: input.run.displayId.slice(0, 80),
      summary,
      publicationSummary,
      eventsSummary: events.length === 0 ? "No activity has been recorded for this run yet." : `${events.length} event${events.length === 1 ? "" : "s"} shown`,
      artifactsSummary: artifacts.length === 0 ? "No artifacts are available for this run." : `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} available`,
    },
    events,
    artifacts,
  };
}

/** Fixed application-owned A2UI template for selected-run metadata and evidence lists. */
export function createRunDetailsSurface(options: { showJevAction: boolean; showLoadMore: boolean }): unknown[] {
  const children = ["title", "summaryCard", "eventsCard", "artifactsCard"];
  const components: A2uiComponentDefinition[] = [
    a2uiColumn("root", children),
    a2uiText("title", "Selected run"),
    a2uiCard("summaryCard", "summaryContent"),
    a2uiColumn("summaryContent", ["displayId", "runSummary", "publicationSummary"]),
    a2uiText("displayId", { "@path": "/selectedRun/displayId" }),
    a2uiText("runSummary", { "@path": "/selectedRun/summary" }),
    a2uiText("publicationSummary", { "@path": "/selectedRun/publicationSummary" }),
    a2uiCard("eventsCard", "eventsContent"),
    a2uiColumn("eventsContent", ["eventsTitle", "eventsSummary", "eventsList"]),
    a2uiText("eventsTitle", "Activity"),
    a2uiText("eventsSummary", { "@path": "/selectedRun/eventsSummary" }),
    a2uiList("eventsList", "/events", "eventRow"),
    a2uiText("eventRow", { "@path": "summary" }),
    a2uiCard("artifactsCard", "artifactsContent"),
    a2uiColumn("artifactsContent", ["artifactsTitle", "artifactsSummary", "artifactsList"]),
    a2uiText("artifactsTitle", "Files"),
    a2uiText("artifactsSummary", { "@path": "/selectedRun/artifactsSummary" }),
    a2uiList("artifactsList", "/artifacts", "artifactRow"),
    a2uiRow("artifactRow", ["artifactSummary", "downloadButton"]),
    a2uiText("artifactSummary", { "@path": "summary" }),
    a2uiText("downloadLabel", "Download"),
    a2uiButton("downloadButton", "downloadLabel", "download_artifact", {
      runId: { "@path": "/selectedRun/runId" },
      artifactId: { "@path": "id" },
    }),
  ];

  const actionIds: string[] = [];
  if (options.showJevAction) actionIds.push("assessButton");
  if (options.showLoadMore) actionIds.push("loadMoreButton");
  if (actionIds.length > 0) {
    children.push("actionsRow");
    components.push(a2uiRow("actionsRow", actionIds));
    if (options.showJevAction) {
      components.push(
        a2uiText("assessLabel", "Assess with JEV"),
        a2uiButton("assessButton", "assessLabel", "assess_run", { runId: { "@path": "/selectedRun/runId" } }),
      );
    }
    if (options.showLoadMore) {
      components.push(
        a2uiText("loadMoreLabel", "Load more activity"),
        a2uiButton("loadMoreButton", "loadMoreLabel", "load_more_events", { runId: { "@path": "/selectedRun/runId" } }),
      );
    }
  }

  return createFixedA2uiSurface("soyuz-run-details", components);
}

function safeEventSummaryFields(payload: Record<string, string | number | boolean>): string[] {
  return Object.entries(payload)
    .filter(([key, value]) => SAFE_EVENT_FIELDS.has(key)
      && (typeof value !== "string" || Array.from(value).length <= 160))
    .slice(0, 6)
    .map(([key, value]) => `${formatMachineLabel(key)} ${formatEventPayloadValue(key, value)}`);
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function formatBytes(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "size unavailable";
  if (value < 1_000) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1_000;
  let unit = units[0]!;
  for (const next of units.slice(1)) {
    if (size < 1_000) break;
    size /= 1_000;
    unit = next;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${unit}`;
}

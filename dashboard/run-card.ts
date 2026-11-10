import { createBadge, createCard, createDefinitionList, createTimestamp } from "./ui/components.js";
import {
  formatMachineLabel,
  formatRepositoryName,
  formatTimestamp,
  getRunStatusPresentation,
} from "./presentation.js";

export interface DashboardRunSummary {
  status: string;
  runId: string;
  displayId: string;
  repoUrl: string;
  ref: string;
  origin: { type: string; id: string };
  retryOf: string | null;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  stage: string | null;
  operationalHealth: "unknown" | "healthy" | "suspect_stalled";
  lastHeartbeatAt: string | null;
}

export interface RunCardOptions {
  ownerDocument?: Document;
  expanded?: boolean;
  onCopyId?: (runId: string) => void;
  onDetailsToggle?: (
    run: DashboardRunSummary,
    details: HTMLDetailsElement,
    content: HTMLElement,
    expanded: boolean,
  ) => void;
}

/** Build the shared recent-run card, leaving data fetching and clipboard effects to its owner. */
export function createRunCard(run: DashboardRunSummary, options: RunCardOptions = {}): HTMLElement {
  const ownerDocument = options.ownerDocument ?? document;
  const { element: card, header, body, footer } = createCard({ className: "run-card" }, ownerDocument);
  header.className += " run-card__header";

  const identity = ownerDocument.createElement("div");
  identity.className = "run-card__identity";
  const heading = ownerDocument.createElement("h2");
  heading.className = "card__title";
  heading.textContent = formatRepositoryName(run.repoUrl);
  const ref = ownerDocument.createElement("p");
  ref.className = "run-card__ref";
  ref.textContent = `Ref · ${run.ref || "Not reported"}`;
  identity.append(heading, ref);

  const statusPresentation = getRunStatusPresentation(run.status);
  const status = createBadge(`Status: ${statusPresentation.label}`, statusPresentation.tone, ownerDocument);
  header.append(identity, status);

  const identifiers = ownerDocument.createElement("div");
  identifiers.className = "run-card__identifiers";
  const displayId = ownerDocument.createElement("p");
  displayId.className = "run-card__id";
  displayId.textContent = `Soyuz run · ${run.displayId}`;
  identifiers.append(displayId);

  const technicalId = ownerDocument.createElement("p");
  technicalId.className = "run-card__technical-id";
  const technicalIdLabel = ownerDocument.createElement("span");
  technicalIdLabel.textContent = "Technical ID · ";
  const technicalIdCode = ownerDocument.createElement("code");
  technicalIdCode.textContent = run.runId;
  technicalId.append(technicalIdLabel, technicalIdCode);
  const copyIdButton = ownerDocument.createElement("button");
  copyIdButton.className = "button button--secondary run-card__copy-id";
  copyIdButton.type = "button";
  copyIdButton.textContent = "Copy ID";
  copyIdButton.setAttribute("aria-label", "Copy technical run ID");
  copyIdButton.addEventListener("click", () => options.onCopyId?.(run.runId));

  const facts = createDefinitionList([
    ["Created", formatOptionalTimestamp(run.createdAt)],
    ["Queued", formatOptionalTimestamp(run.queuedAt)],
    ["Started", formatOptionalTimestamp(run.startedAt)],
    ["Completed", formatOptionalTimestamp(run.completedAt)],
  ], "data-list run-facts", ownerDocument);

  body.append(identifiers, createTimestamp("Created", run.createdAt, "run-card__created", ownerDocument));

  const progress = ownerDocument.createElement("p");
  progress.className = "run-card__progress";
  progress.textContent = statusPresentation.active
    ? [
      `Current stage · ${formatMachineLabel(run.stage)}`,
      run.operationalHealth === "suspect_stalled" || !run.lastHeartbeatAt ? "" : `Last check-in · ${formatTimestamp(run.lastHeartbeatAt)}`,
    ].filter(Boolean).join(" · ")
    : run.completedAt
      ? `Finished · ${formatTimestamp(run.completedAt)}`
      : "Run finished";
  body.append(progress);

  const health = ownerDocument.createElement("p");
  health.className = "notice notice--warning run-card__health";
  health.textContent = run.lastHeartbeatAt
    ? `The worker hasn't checked in recently. Last check-in: ${formatTimestamp(run.lastHeartbeatAt)}.`
    : "The worker hasn't checked in recently. This run may be stalled.";
  health.hidden = run.operationalHealth !== "suspect_stalled";
  body.append(health);

  const metadata = ownerDocument.createElement("details");
  metadata.className = "run-card__metadata";
  const metadataSummary = ownerDocument.createElement("summary");
  metadataSummary.textContent = "More run metadata · technical ID and timestamps";
  const metadataContent = ownerDocument.createElement("div");
  metadataContent.className = "details-content";
  const metadataIdentifiers = ownerDocument.createElement("div");
  metadataIdentifiers.className = "run-card__identifiers";
  metadataIdentifiers.append(technicalId, copyIdButton);
  metadataContent.append(metadataIdentifiers, facts);
  metadata.append(metadataSummary, metadataContent);
  footer.append(metadata);

  const details = ownerDocument.createElement("details");
  details.className = "run-card__details";
  const summary = ownerDocument.createElement("summary");
  summary.textContent = "View outcome, activity, and files";
  const content = ownerDocument.createElement("div");
  content.className = "details-content";
  details.append(summary, content);
  details.addEventListener("toggle", () => {
    options.onDetailsToggle?.(run, details, content, details.open);
  });
  details.open = options.expanded ?? false;
  footer.append(details);

  return card;
}

function formatOptionalTimestamp(value: string | null): string {
  return value ? formatTimestamp(value) : "Not reported";
}

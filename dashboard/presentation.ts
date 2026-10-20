export type RunStatusTone = "active" | "warning" | "success" | "danger" | "neutral";

export interface RunStatusPresentation {
  value: string;
  label: string;
  tone: RunStatusTone;
  active: boolean;
}

export const RUN_STATUS_OPTIONS: readonly RunStatusPresentation[] = [
  { value: "admitting", label: "Admitting", tone: "active", active: true },
  { value: "queued", label: "Queued", tone: "active", active: true },
  { value: "claimed", label: "Claimed", tone: "active", active: true },
  { value: "running", label: "Running", tone: "active", active: true },
  { value: "cancel_requested", label: "Cancellation requested", tone: "warning", active: true },
  { value: "cancelled", label: "Cancelled", tone: "neutral", active: false },
  { value: "completed", label: "Completed", tone: "success", active: false },
  { value: "failed", label: "Failed", tone: "danger", active: false },
  { value: "admission_failed", label: "Admission failed", tone: "danger", active: false },
];

const runStatuses = new Map(RUN_STATUS_OPTIONS.map((status) => [status.value, status]));

const eventLabels: Record<string, string> = {
  "run.admitting": "Preparing run",
  "run.queued": "Added to queue",
  "run.claimed": "Worker picked up run",
  "run.started": "Run started",
  "run.completed": "Run completed",
  "run.failed": "Run failed",
  "run.cancel_requested": "Cancellation requested",
  "run.cancelled": "Run cancelled",
  "run.admission_failed": "Run setup failed",
  "run.claim_expired": "Worker did not pick up run",
  "worker.heartbeat": "Worker checked in",
  "stage.changed": "Stage changed",
};

export function getRunStatusPresentation(status: string): RunStatusPresentation {
  return runStatuses.get(status) ?? {
    value: status,
    label: formatMachineLabel(status),
    tone: "neutral",
    active: false,
  };
}

export function formatMachineLabel(value: string | null | undefined): string {
  const words = value?.trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!words) return "Not reported";
  return words[0]!.toUpperCase() + words.slice(1);
}

export function formatEventLabel(type: string): string {
  if (eventLabels[type]) return eventLabels[type];
  if (type.startsWith("run.progress.")) return "Progress update";
  return formatMachineLabel(type);
}

export function formatEventPayloadValue(key: string, value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "string") return String(value);

  switch (key.toLowerCase()) {
    case "status":
      return getRunStatusPresentation(value).label;
    case "stage":
    case "step":
    case "taskmode":
    case "publishmode":
      return formatMachineLabel(value);
    default:
      return value;
  }
}

export function formatRepositoryName(repoUrl: string): string {
  const repo = repoUrl.trim();
  if (!repo) return "Repository not available";

  const sshPath = /^git@[^:]+:(.+)$/.exec(repo)?.[1];
  let path = sshPath;
  if (!path) {
    try {
      path = new URL(repo).pathname;
    } catch {
      return repo;
    }
  }

  return path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "") || repo;
}

export const RUN_STATUSES = [
  "admitting",
  "queued",
  "claimed",
  "running",
  "cancel_requested",
  "cancelled",
  "completed",
  "failed",
  "admission_failed",
] as const;

export type RunStatus = typeof RUN_STATUSES[number];

const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  admitting: ["queued", "admission_failed", "cancelled"],
  queued: ["claimed", "cancelled"],
  claimed: ["running", "admitting", "cancelled"],
  running: ["cancel_requested", "completed", "failed", "cancelled"],
  cancel_requested: ["completed", "failed", "cancelled"],
  cancelled: [],
  completed: [],
  failed: [],
  admission_failed: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: RunStatus): readonly RunStatus[] {
  return TRANSITIONS[from];
}

export function isTerminalStatus(status: RunStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "failed" || status === "admission_failed";
}

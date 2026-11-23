export interface RunTimingInput {
  status: string;
  createdAt: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastHeartbeatAt: string | null;
}

export interface RunMetrics {
  runAgeMs: number | null;
  queueDurationMs: number | null;
  executionDurationMs: number | null;
  heartbeatAgeMs: number | null;
}

const ACTIVE_STATUSES = new Set(["admitting", "queued", "claimed", "running", "cancel_requested"]);

/** Calculate elapsed run phases without treating absent or invalid timestamps as zero. */
export function calculateRunMetrics(run: RunTimingInput, now = Date.now()): RunMetrics {
  const referenceTime = Number.isFinite(now) ? now : Date.now();
  const createdAt = timestamp(run.createdAt);
  const queuedAt = timestamp(run.queuedAt);
  const startedAt = timestamp(run.startedAt);
  const completedAt = timestamp(run.completedAt);
  const heartbeatAt = timestamp(run.lastHeartbeatAt);
  const active = ACTIVE_STATUSES.has(run.status);

  return {
    runAgeMs: elapsed(createdAt, completedAt ?? (active ? referenceTime : null)),
    queueDurationMs: elapsed(queuedAt, startedAt ?? (active ? referenceTime : null)),
    executionDurationMs: elapsed(startedAt, completedAt ?? (active ? referenceTime : null)),
    heartbeatAgeMs: elapsed(heartbeatAt, referenceTime),
  };
}

/** Format an elapsed value with useful units; null means the measurement is unknown. */
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return "Not reported";
  const totalSeconds = Math.floor(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m${seconds ? ` ${seconds}s` : ""}`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h${minutes ? ` ${minutes}m` : ""}`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d${hours ? ` ${hours}h` : ""}`;
}

function timestamp(value: string | null): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function elapsed(start: number | null, end: number | null): number | null {
  if (start === null || end === null || end < start) return null;
  return end - start;
}

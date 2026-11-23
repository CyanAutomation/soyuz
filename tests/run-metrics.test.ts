import { describe, expect, it } from "vitest";
import { calculateRunMetrics, formatDuration, type RunTimingInput } from "../dashboard/run-metrics";

const now = Date.parse("2026-11-22T12:10:00.000Z");

describe("dashboard run timing", () => {
  it("[DASHBOARD-RUN-METRICS-01] calculates elapsed values for a completed run", () => {
    const run: RunTimingInput = {
      status: "completed",
      createdAt: "2026-11-22T12:00:00.000Z",
      queuedAt: "2026-11-22T12:00:10.000Z",
      startedAt: "2026-11-22T12:01:00.000Z",
      completedAt: "2026-11-22T12:04:00.000Z",
      lastHeartbeatAt: "2026-11-22T12:03:50.000Z",
    };

    expect(calculateRunMetrics(run, now)).toEqual({
      runAgeMs: 4 * 60_000,
      queueDurationMs: 50_000,
      executionDurationMs: 3 * 60_000,
      heartbeatAgeMs: 6 * 60_000 + 10_000,
    });
  });

  it("[DASHBOARD-RUN-METRICS-01] calculates active age and unfinished phase durations", () => {
    const queued: RunTimingInput = {
      status: "queued",
      createdAt: "2026-11-22T12:00:00.000Z",
      queuedAt: "2026-11-22T12:01:00.000Z",
      startedAt: null,
      completedAt: null,
      lastHeartbeatAt: null,
    };

    expect(calculateRunMetrics(queued, now)).toEqual({
      runAgeMs: 10 * 60_000,
      queueDurationMs: 9 * 60_000,
      executionDurationMs: null,
      heartbeatAgeMs: null,
    });
  });

  it("[DASHBOARD-RUN-METRICS-01] distinguishes missing measurements from zero", () => {
    const run: RunTimingInput = {
      status: "failed",
      createdAt: "not-a-timestamp",
      queuedAt: null,
      startedAt: "2026-11-22T12:10:00.000Z",
      completedAt: "2026-11-22T12:10:00.000Z",
      lastHeartbeatAt: null,
    };

    expect(calculateRunMetrics(run, now)).toEqual({
      runAgeMs: null,
      queueDurationMs: null,
      executionDurationMs: 0,
      heartbeatAgeMs: null,
    });
    expect(formatDuration(null)).toBe("Not reported");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-1)).toBe("Not reported");
  });

  it("[DASHBOARD-RUN-METRICS-01] formats durations with useful units", () => {
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_661_000)).toBe("1h 1m");
    expect(formatDuration(90_061_000)).toBe("1d 1h");
  });
});

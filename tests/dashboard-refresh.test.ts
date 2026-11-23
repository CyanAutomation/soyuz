import { describe, expect, it } from "vitest";
import { DASHBOARD_REFRESH_INTERVAL_MS } from "../dashboard/refresh-policy";

describe("dashboard background refresh policy", () => {
  it("[DASHBOARD-REFRESH-01] polls hourly while preserving manual refresh", () => {
    expect(DASHBOARD_REFRESH_INTERVAL_MS).toBe(60 * 60 * 1_000);
  });
});

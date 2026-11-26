import { describe, expect, it, vi } from "vitest";
import { backfillOutcomeSummaries, serializeBackfillOutcomeSummary } from "../scripts/backfill-outcome-summaries.ts";

const validOutcome = {
  schemaVersion: 1,
  evaluation: { assessment: "good", reviewerConfidence: "high", improvementCategories: [] },
};

function d1Response(results: unknown[], changes = 0): Response {
  return new Response(JSON.stringify({
    success: true,
    result: [{ success: true, results, meta: { changes } }],
  }), { headers: { "content-type": "application/json" } });
}

describe("outcome summary backfill", () => {
  it("[RUN-OUTCOMES-BACKFILL-01] validates historical result summaries with the live contract", () => {
    expect(serializeBackfillOutcomeSummary(JSON.stringify({ outcomeSummary: validOutcome }))).toBe(JSON.stringify({
      evaluation: { assessment: "good", improvementCategories: [], reviewerConfidence: "high" },
      schemaVersion: 1,
    }));
    expect(serializeBackfillOutcomeSummary("not JSON")).toBeNull();
    expect(serializeBackfillOutcomeSummary(JSON.stringify({ outcomeSummary: { schemaVersion: 1 } }))).toBeNull();
  });

  it("[RUN-OUTCOMES-BACKFILL-02] pages a stable retained snapshot and only writes validated missing projections", async () => {
    const calls: Array<{ url: string; body: { sql: string; params?: unknown[] } }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { sql: string; params?: unknown[] };
      calls.push({ url: String(input), body });
      if (calls.length === 1) return d1Response([{ id: "high-water", created_at: "2026-11-20T00:00:00.000Z" }]);
      if (calls.length === 2) return d1Response([
        { id: "valid-1", created_at: "2026-11-01T00:00:00.000Z", result_json: JSON.stringify({ outcomeSummary: validOutcome }) },
        { id: "invalid", created_at: "2026-11-02T00:00:00.000Z", result_json: JSON.stringify({ outcomeSummary: { schemaVersion: 1 } }) },
      ]);
      if (calls.length === 3) return d1Response([], 1);
      if (calls.length === 4) return d1Response([
        { id: "valid-2", created_at: "2026-11-03T00:00:00.000Z", result_json: JSON.stringify({ outcomeSummary: validOutcome }) },
      ]);
      if (calls.length === 5) return d1Response([], 1);
      return d1Response([]);
    });

    const result = await backfillOutcomeSummaries({
      configText: JSON.stringify({ d1_databases: [{ binding: "DB", database_id: "a".repeat(32) }] }),
      accountId: "b".repeat(32),
      apiToken: "edit-token",
      fetchImpl,
      pageSize: 2,
      asOf: "2026-11-26T00:00:00.000Z",
    });

    expect(result).toEqual({ scanned: 3, backfilled: 2, skippedInvalid: 1 });
    expect(calls).toHaveLength(5);
    expect(calls[0]?.url).toContain("/accounts/" + "b".repeat(32) + "/d1/database/" + "a".repeat(32) + "/query");
    const updates = calls.filter(({ body }) => body.sql.includes("WITH incoming"));
    expect(updates).toHaveLength(2);
    expect(updates.every(({ body }) => body.sql.includes("outcome_summary_json IS NULL"))).toBe(true);
    const updateParams = updates.flatMap(({ body }) => body.params ?? []);
    expect(updateParams).toContain("valid-1");
    expect(updateParams).toContain("valid-2");
    expect(updateParams).not.toContain("invalid");
  });
});

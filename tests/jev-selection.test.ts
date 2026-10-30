import { describe, expect, it } from "vitest";
import { suggestedJevProfile } from "../dashboard/analysis/jev-selection";
import { JEV_PROFILES } from "../src/jev/profiles";

describe("JEV profile suggestion", () => {
  it("suggests outcome review for completed runs", () => {
    expect(suggestedJevProfile({ status: "completed" })).toBe("kaseki_output_review_v2");
  });

  it.each(["failed", "admission_failed"])(
    "suggests operational triage for %s runs",
    (status) => expect(suggestedJevProfile({ status })).toBe("run_operations_triage_v1"),
  );
  it("suggests operational triage for suspect stalled runs", () => {
    expect(suggestedJevProfile({ status: "running", operationalHealth: "suspect_stalled" })).toBe("run_operations_triage_v1");
  });
  it.each(["running", "queued", "cancelled", "unknown"])(
    "does not auto-suggest a profile for %s runs without a risk signal",
    (status) => expect(suggestedJevProfile({ status, operationalHealth: "healthy" })).toBeNull(),
  );

  it("keeps the v1 answer contract and adds recorded outcome scoring in v2", () => {
    expect(Object.keys(JEV_PROFILES.kaseki_output_review_v1.questions)).not.toContain("recorded_outcome");
    expect(Object.keys(JEV_PROFILES.kaseki_output_review_v2.questions)).toContain("recorded_outcome");
  });
});

import { describe, expect, it } from "vitest";
import { suggestedJevProfile } from "../dashboard/analysis/jev-selection";
import { JEV_PROFILE_CONTRACTS } from "../src/jev/profiles";

describe("JEV profile suggestion", () => {
  it("[JEV-SELECT-01] suggests outcome review for completed runs", () => {
    expect(suggestedJevProfile({ status: "completed" })).toBe("kaseki_output_review_v2");
  });

  it.each(["failed", "admission_failed"])(
    "[JEV-SELECT-01] suggests operational triage for %s runs",
    (status) => expect(suggestedJevProfile({ status })).toBe("run_operations_triage_v1"),
  );
  it("[JEV-SELECT-01] suggests operational triage for suspect stalled runs", () => {
    expect(suggestedJevProfile({ status: "running", operationalHealth: "suspect_stalled" })).toBe("run_operations_triage_v1");
  });
  it.each(["running", "queued", "cancelled", "unknown"])(
    "[JEV-SELECT-01] does not auto-suggest a profile for %s runs without a risk signal",
    (status) => expect(suggestedJevProfile({ status, operationalHealth: "healthy" })).toBeNull(),
  );

  it("[JEV-SELECT-01] preserves the v1 answer contract and adds recorded outcome scoring only in v2", () => {
    const v1 = JEV_PROFILE_CONTRACTS.kaseki_output_review_v1;
    const v2 = JEV_PROFILE_CONTRACTS.kaseki_output_review_v2;
    const v1AnswerIds = Object.keys(v1.answers).sort();
    const v2AnswerIds = Object.keys(v2.answers).sort();

    expect(v1.version).toBe("1");
    expect(v2.version).toBe("2");
    expect(v1AnswerIds).toEqual([
      "evidence_strength",
      "outcome_alignment",
      "summary_specificity",
    ]);
    expect(v2AnswerIds).toEqual([
      ...v1AnswerIds,
      "recorded_outcome",
    ].sort());
    for (const questionId of ["summary_specificity", "outcome_alignment", "evidence_strength"] as const) {
      expect(v2.answers[questionId]).toEqual(v1.answers[questionId]);
    }
    expect(v2.answers.recorded_outcome).toMatchObject({
      type: "score",
      legend: [
        "Outcome unclear or unsuccessful",
        "Partial or limited outcome evidence",
        "Successful and clearly reported outcome",
      ],
    });
  });
});

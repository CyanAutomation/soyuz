import { describe, expect, it } from "vitest";
import { suggestedJevProfile } from "../dashboard/analysis/jev-selection";
import { JEV_PROFILES } from "../src/jev/profiles";

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

  it("[JEV-SELECT-01] preserves the v1 questions and adds recorded outcome scoring only in v2", () => {
    const v1Questions = JEV_PROFILES.kaseki_output_review_v1.questions;
    const v2Questions = JEV_PROFILES.kaseki_output_review_v2.questions;
    const v1QuestionIds = Object.keys(v1Questions).sort();
    const v2QuestionIds = Object.keys(v2Questions).sort();

    expect(v1QuestionIds).toEqual([
      "evidence_strength",
      "outcome_alignment",
      "summary_specificity",
    ]);
    expect(v2QuestionIds).toEqual([
      ...v1QuestionIds,
      "recorded_outcome",
    ].sort());
    for (const questionId of ["summary_specificity", "outcome_alignment", "evidence_strength"] as const) {
      expect(v2Questions[questionId]).toEqual(v1Questions[questionId]);
    }
    expect(v2Questions.recorded_outcome).toMatchObject({
      type: "score",
      criteria: [
        "Outcome unclear or unsuccessful",
        "Partial or limited outcome evidence",
        "Successful and clearly reported outcome",
      ],
    });
  });
});

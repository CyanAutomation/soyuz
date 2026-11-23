import { describe, expect, it } from "vitest";
import { suggestedJevProfile } from "../dashboard/jev-selection";
import { JEV_PROFILE_CONTRACTS } from "../src/jev/profiles";

describe("JEV profile suggestion", () => {
  it("[JEV-SELECT-01] suggests outcome review for completed runs with a summary", () => {
    expect(suggestedJevProfile({ status: "completed", outcomeSummary: "Checks passed." })).toBe("kaseki_output_review_v2");
  });
  it("[JEV-RETRY-REVIEW-01] suggests retry review for terminal runs with retry lineage", () => {
    for (const status of ["completed", "failed", "cancelled", "admission_failed"]) {
      expect(suggestedJevProfile({ status, retryOf: "00000000-0000-4000-8000-000000000001" })).toBe("run_retry_review_v1");
    }
  });
  it("[JEV-RETRY-REVIEW-01] leaves active retries to operational triage", () => {
    expect(suggestedJevProfile({ status: "running", retryOf: "00000000-0000-4000-8000-000000000001", operationalHealth: "suspect_stalled" })).toBe("run_operations_triage_v1");
    expect(suggestedJevProfile({ status: "running", retryOf: "00000000-0000-4000-8000-000000000001", operationalHealth: "healthy" })).toBeNull();
  });
  it("[JEV-SELECT-01] does not suggest output review when a completed run has no summary", () => {
    expect(suggestedJevProfile({ status: "completed", outcomeSummary: null })).toBeNull();
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

  it("[JEV-RETRY-REVIEW-01] exposes a versioned bounded retry comparison answer contract", () => {
    expect(JEV_PROFILE_CONTRACTS.run_retry_review_v1).toMatchObject({
      version: "1",
      answers: {
        recovery: { type: "choice", choices: ["recovered", "partial", "not_recovered", "unclear"] },
        evidence_strength: { type: "score" },
        needs_followup: { type: "noul" },
      },
    });
  });
});

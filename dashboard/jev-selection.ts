export type JEV_PROFILE_ID = "run_operations_triage_v1" | "kaseki_output_review_v1" | "kaseki_output_review_v2" | "run_retry_review_v1";

/** Pick the most useful advisory profile for a run the user selected. */
export function suggestedJevProfile(run: {
  status?: unknown;
  operationalHealth?: unknown;
  outcomeSummary?: unknown;
  retryOf?: unknown;
}): JEV_PROFILE_ID | null {
  if (typeof run.status === "string"
    && ["completed", "failed", "cancelled", "admission_failed"].includes(run.status)
    && typeof run.retryOf === "string" && run.retryOf.length > 0) {
    return "run_retry_review_v1";
  }
  if (run.status === "completed" && typeof run.outcomeSummary === "string" && run.outcomeSummary.trim().length > 0) {
    return "kaseki_output_review_v2";
  }
  if (run.status === "failed" || run.status === "admission_failed" || run.operationalHealth === "suspect_stalled") {
    return "run_operations_triage_v1";
  }
  return null;
}

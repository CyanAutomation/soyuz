export type JEV_PROFILE_ID = "run_operations_triage_v1" | "kaseki_output_review_v1" | "kaseki_output_review_v2";

/** Pick the most useful advisory profile for a run the user selected. */
export function suggestedJevProfile(run: {
  status?: unknown;
  operationalHealth?: unknown;
}): JEV_PROFILE_ID | null {
  if (run.status === "completed") return "kaseki_output_review_v2";
  if (run.status === "failed" || run.status === "admission_failed" || run.operationalHealth === "suspect_stalled") {
    return "run_operations_triage_v1";
  }
  return null;
}

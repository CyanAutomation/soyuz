import { JevProfileIdSchema, type JevProfileId } from "./profile-ids";

export { JEV_PROFILE_IDS, JevProfileIdSchema } from "./profile-ids";
export type { JevProfileId } from "./profile-ids";

export type AnswerContract =
  | { type: "noul" }
  | { type: "choice"; choices: readonly string[] }
  | { type: "score"; legend: readonly string[] };

export interface JevProfileContract {
  version: "1" | "2";
  answers: Readonly<Record<string, AnswerContract>>;
}

// These are response contracts only. Senku owns the question wording and criteria.
export const JEV_PROFILE_CONTRACTS: Readonly<Record<JevProfileId, JevProfileContract>> = {
  run_operations_triage_v1: {
    version: "1",
    answers: {
      needs_followup: { type: "noul" },
      likely_area: { type: "choice", choices: ["execution", "control_plane", "unknown"] },
      severity: { type: "score", legend: ["Routine", "Needs review", "Urgent"] },
    },
  },
  kaseki_output_review_v1: {
    version: "1",
    answers: {
      summary_specificity: { type: "noul" },
      outcome_alignment: { type: "choice", choices: ["consistent", "unclear", "inconsistent"] },
      evidence_strength: { type: "score", legend: ["Insufficient", "Some concrete detail", "Clear and specific"] },
    },
  },
  kaseki_output_review_v2: {
    version: "2",
    answers: {
      summary_specificity: { type: "noul" },
      outcome_alignment: { type: "choice", choices: ["consistent", "unclear", "inconsistent"] },
      evidence_strength: { type: "score", legend: ["Insufficient", "Some concrete detail", "Clear and specific"] },
      recorded_outcome: {
        type: "score",
        legend: ["Outcome unclear or unsuccessful", "Partial or limited outcome evidence", "Successful and clearly reported outcome"],
      },
    },
  },
};

export type { JevProfileId as SoyuzJevProfileId };
export { JevProfileIdSchema as SoyuzJevProfileIdSchema };

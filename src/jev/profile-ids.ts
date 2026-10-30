import { z } from "zod";

export const JEV_PROFILE_IDS = ["run_operations_triage_v1", "kaseki_output_review_v1", "kaseki_output_review_v2"] as const;
export const JevProfileIdSchema = z.enum(JEV_PROFILE_IDS);
export type JevProfileId = typeof JEV_PROFILE_IDS[number];

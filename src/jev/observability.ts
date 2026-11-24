import type { SenkuUsage } from "./senku-client";
import type { JevProfileId } from "./profiles";

export interface JevDecisionLogFields {
  requestId: string;
  profileId: JevProfileId;
  durationMs: number;
  outcome: string;
  providerAttemptCount: number;
  model?: string;
  errorCode?: string;
  senkuRequestId?: string;
  usage?: SenkuUsage;
}

/** Builds the bounded operational event shared by JEV decision handlers. */
export function createJevDecisionLogEvent(fields: JevDecisionLogFields) {
  return {
    event: "soyuz_jev_decision" as const,
    backend: "senku" as const,
    requestId: fields.requestId,
    profileId: fields.profileId,
    ...(fields.model ? { model: fields.model } : {}),
    durationMs: fields.durationMs,
    outcome: fields.outcome,
    ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
    providerAttemptCount: fields.providerAttemptCount,
    ...(fields.senkuRequestId ? { senkuRequestId: fields.senkuRequestId } : {}),
    ...(fields.usage ? { usage: fields.usage } : {}),
  };
}

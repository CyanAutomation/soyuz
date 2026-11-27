import type { JevProfileId } from "./profile-ids";
import { JEV_PROFILE_IDS } from "./profile-ids";
import pinnedProfiles from "./senku-profiles.v1.json";

export { JevProfileIdSchema } from "./profile-ids";
export type { JevProfileId } from "./profile-ids";

export type AnswerContract =
  | { type: "noul" }
  | { type: "choice"; choices: readonly string[] }
  | { type: "score"; legend: readonly string[] };

export interface JevProfileContract {
  version: "1" | "2";
  answers: Readonly<Record<string, AnswerContract>>;
}

export function validatePinnedProfileVersion(profileId: JevProfileId, version: unknown): "1" | "2" {
  if (version !== "1" && version !== "2") {
    throw new Error(`The pinned Senku contract for ${profileId} has an unsupported version: ${String(version)}.`);
  }
  return version;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function answerContract(value: unknown): AnswerContract {
  const answerSchema = record(value);
  const properties = record(answerSchema.properties);
  const answerType = record(properties.type).const;
  if (answerType === "noul") return { type: "noul" };
  if (answerType === "choice") {
    const choices = record(properties.choice).enum;
    if (!Array.isArray(choices) || !choices.every((choice) => typeof choice === "string")) {
      throw new Error("The pinned Senku choice contract is invalid.");
    }
    return { type: "choice", choices };
  }
  if (answerType === "score") {
    const legendProperties = record(record(properties.legend).properties);
    const legend = Object.keys(legendProperties).sort((left, right) => Number(left) - Number(right))
      .map((key) => record(legendProperties[key]).const);
    if (!legend.every((entry) => typeof entry === "string")) {
      throw new Error("The pinned Senku score contract is invalid.");
    }
    return { type: "score", legend };
  }
  throw new Error("The pinned Senku answer contract has an unsupported answer type.");
}

function pinnedContract(profileId: JevProfileId): JevProfileContract {
  const profile = pinnedProfiles.profiles.find((item) => item.id === profileId && item.allowedClients.includes("soyuz"));
  if (!profile) throw new Error(`The pinned Senku contract does not allow Soyuz to use ${profileId}.`);
  const properties = record(record(profile.outputSchema).properties);
  return {
    version: validatePinnedProfileVersion(profileId, profile.version),
    answers: Object.fromEntries(Object.entries(properties).map(([answerId, schema]) => [answerId, answerContract(schema)])),
  };
}

// The pinned artifact is response-only. Question wording and criteria remain private to Senku.
export const JEV_PROFILE_CONTRACTS: Readonly<Record<JevProfileId, JevProfileContract>> = Object.fromEntries(
  JEV_PROFILE_IDS.map((profileId) => [profileId, pinnedContract(profileId)]),
) as Record<JevProfileId, JevProfileContract>;

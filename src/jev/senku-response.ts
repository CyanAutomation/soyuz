import { JEV_PROFILE_CONTRACTS, type AnswerContract, type JevProfileId } from "./profiles";
import type { SenkuDecisionResult, SenkuUsage } from "./senku-client";

export type SenkuResponseValidation =
  | { valid: true; result: SenkuDecisionResult }
  | { valid: false; requestId?: string };
export function parseSenkuResponse(value: unknown, profileId: JevProfileId): SenkuResponseValidation {
  const requestId = isRecord(value) ? safeSenkuRequestId(value.requestId) : undefined;
  const contract = JEV_PROFILE_CONTRACTS[profileId];
  if (!isValidResponse(value, profileId, contract)) {
    return { valid: false, ...(requestId ? { requestId } : {}) };
  }

  return {
    valid: true,
    result: {
      model: value.model,
      answers: value.answers,
      requestId: value.requestId,
      durationMs: value.durationMs,
      attemptCount: 1,
      ...(Object.hasOwn(value, "usage") ? { usage: value.usage as SenkuUsage } : {}),
    },
  };
}

function isValidResponse(
  value: unknown,
  profileId: JevProfileId,
  contract: (typeof JEV_PROFILE_CONTRACTS)[JevProfileId],
): value is Record<string, unknown> & { model: string; requestId: string; durationMs: number; answers: Record<string, unknown> } {
  if (!isRecord(value)) return false;
  const required = [
    "schemaVersion", "requestId", "status", "profileId", "profileVersion", "provider",
    "model", "answers", "result", "durationMs", "attemptCount",
  ];
  return hasOnlyKeys(value, [...required, "usage"])
    && required.every((key) => Object.hasOwn(value, key))
    && hasValidResponseMetadata(value, profileId, contract.version)
    && hasValidResponseAnswers(value, profileId)
    && (!Object.hasOwn(value, "usage") || validateUsage(value.usage));
}

function hasValidResponseMetadata(
  value: Record<string, unknown>,
  profileId: JevProfileId,
  profileVersion: string,
): value is Record<string, unknown> & { model: string; requestId: string; durationMs: number } {
  return hasValidEnvelopeIdentity(value)
    && value.profileId === profileId
    && value.profileVersion === profileVersion
    && isValidModelName(value.model)
    && isValidDuration(value.durationMs);
}

function hasValidEnvelopeIdentity(value: Record<string, unknown>): boolean {
  return value.schemaVersion === "1"
    && safeSenkuRequestId(value.requestId) !== undefined
    && value.status === "completed"
    && value.provider === "jev"
    && value.attemptCount === 1;
}

function isValidModelName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

function isValidDuration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasValidResponseAnswers(value: Record<string, unknown>, profileId: JevProfileId): boolean {
  return validateAnswerSet(profileId, value.answers)
    && validateAnswerSet(profileId, value.result)
    && jsonValueEqual(value.answers, value.result);
}

function validateAnswerSet(profileId: JevProfileId, value: unknown): value is Record<string, unknown> {
  const contracts = JEV_PROFILE_CONTRACTS[profileId].answers;
  if (!isRecord(value) || !hasExactKeys(value, Object.keys(contracts))) return false;
  return Object.entries(contracts).every(([key, contract]) => validateAnswer(value[key], contract));
}

function validateAnswer(value: unknown, contract: AnswerContract): boolean {
  if (!isRecord(value)) return false;
  if (contract.type === "noul") return validateNoulAnswer(value);
  if (contract.type === "choice") return validateChoiceAnswer(value, contract);
  return validateScoreAnswer(value, contract);
}

function validateNoulAnswer(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ["type", "noul", "probabilities", "confidence"]) || value.type !== "noul") return false;
  if (!isProbability(value.noul) || !isProbabilityMap(value.probabilities, ["false", "true"])) return false;
  return Math.abs((value.probabilities as Record<string, number>).true - value.noul) <= 0.000001
    && value.confidence === null;
}

function validateChoiceAnswer(
  value: Record<string, unknown>,
  contract: Extract<AnswerContract, { type: "choice" }>,
): boolean {
  return hasExactKeys(value, ["type", "choice", "probabilities", "confidence"])
    && value.type === "choice"
    && typeof value.choice === "string"
    && contract.choices.includes(value.choice)
    && isProbabilityMap(value.probabilities, contract.choices)
    && isConfidence(value.confidence);
}

function validateScoreAnswer(
  value: Record<string, unknown>,
  contract: Extract<AnswerContract, { type: "score" }>,
): boolean {
  const legendKeys = contract.legend.map((_label, index) => String(index));
  return hasExactKeys(value, ["type", "score", "legend", "probabilities", "confidence"])
    && value.type === "score"
    && isValidScore(value.score, contract.legend.length)
    && hasMatchingLegend(value.legend, legendKeys, contract.legend)
    && isProbabilityMap(value.probabilities, legendKeys)
    && isConfidence(value.confidence);
}

function isValidScore(value: unknown, legendLength: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= legendLength - 1;
}

function hasMatchingLegend(
  value: unknown,
  keys: readonly string[],
  labels: readonly string[],
): boolean {
  return isRecord(value)
    && hasExactKeys(value, keys)
    && keys.every((key, index) => value[key] === labels[index]);
}

function isProbabilityMap(value: unknown, keys: readonly string[]): value is Record<string, number> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) return false;
  let sum = 0;
  for (const key of keys) {
    if (!isProbability(value[key])) return false;
    sum += value[key];
  }
  return Math.abs(sum - 1) <= 0.03;
}

function validateUsage(value: unknown): value is SenkuUsage {
  if (!isRecord(value) || !hasOnlyKeys(value, ["input_tokens", "output_tokens", "total_tokens", "cost"])) return false;
  return isNonnegativeSafeIntegerOrUndefined(value.input_tokens)
    && isNonnegativeSafeIntegerOrUndefined(value.output_tokens)
    && isNonnegativeSafeIntegerOrUndefined(value.total_tokens)
    && (value.cost === undefined || (typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0));
}

function isNonnegativeSafeIntegerOrUndefined(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isConfidence(value: unknown): value is number | null {
  return value === null || isProbability(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function safeSenkuRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^dec-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = expected.toSorted();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJsonKeys(left)) === JSON.stringify(sortJsonKeys(right));
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonKeys(value[key])]));
}

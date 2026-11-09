import type { Env } from "../env";
import { JEV_PROFILE_CONTRACTS, type AnswerContract, type JevProfileId } from "./profiles";

export const SENKU_REQUEST_TIMEOUT_MS = 35_000;
const MAX_SENKU_RESPONSE_BYTES = 64 * 1024;
const SENKU_INTERNAL_ORIGIN = "https://senku.internal";

export type SenkuDecisionErrorCode =
  | "NOT_CONFIGURED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "INVALID_REQUEST";

export class SenkuDecisionError extends Error {
  constructor(
    readonly code: SenkuDecisionErrorCode,
    readonly senkuRequestId?: string,
  ) {
    super(code);
    this.name = "SenkuDecisionError";
  }
}

export interface SenkuUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export interface SenkuDecisionResult {
  model: string;
  answers: Record<string, unknown>;
  requestId: string;
  durationMs: number;
  attemptCount: 1;
  usage?: SenkuUsage;
}

type SenkuBinding = Pick<Fetcher, "fetch">;
type SenkuEnvironment = Pick<Env, "SENKU" | "SENKU_SOYUZ_API_TOKEN">;

export async function requestSenkuDecision(
  env: SenkuEnvironment,
  profileId: JevProfileId,
  input: Record<string, unknown>,
  binding: SenkuBinding | undefined = env.SENKU,
  timeoutMs = SENKU_REQUEST_TIMEOUT_MS,
): Promise<SenkuDecisionResult> {
  const token = env.SENKU_SOYUZ_API_TOKEN?.trim();
  if (!token) throw new SenkuDecisionError("NOT_CONFIGURED");
  if (!binding || typeof binding.fetch !== "function") {
    throw new SenkuDecisionError("PROVIDER_UNAVAILABLE");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new SenkuDecisionError("INVALID_REQUEST");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const request = new Request(
    SENKU_INTERNAL_ORIGIN + "/v1/profiles/" + profileId + "/evaluate",
    {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ schemaVersion: "1", input }),
    },
  );

  try {
    let response: Response;
    try {
      response = await binding.fetch(request);
    } catch {
      throw new SenkuDecisionError(controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(response, controller.signal);
    } catch (error) {
      if (response.ok) throw error;
      throw errorForSenkuResponse(response.status, undefined);
    }
    if (!response.ok) throw errorForSenkuResponse(response.status, payload);

    return validateSenkuResponse(payload, profileId);
  } finally {
    clearTimeout(timeout);
  }
}

function errorForSenkuResponse(status: number, payload: unknown): SenkuDecisionError {
  const remoteCode = isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string"
    ? payload.error.code
    : undefined;
  const requestId = isRecord(payload) && isRecord(payload.error) && typeof payload.error.requestId === "string"
    ? safeRequestId(payload.error.requestId)
    : undefined;

  switch (remoteCode) {
    case "NOT_CONFIGURED":
      return new SenkuDecisionError("NOT_CONFIGURED", requestId);
    case "PROVIDER_TIMEOUT":
      return new SenkuDecisionError("PROVIDER_TIMEOUT", requestId);
    case "PROVIDER_UNAVAILABLE":
      return new SenkuDecisionError("PROVIDER_UNAVAILABLE", requestId);
    case "INVALID_PROVIDER_RESPONSE":
      return new SenkuDecisionError("INVALID_RESPONSE", requestId);
    case "INVALID_REQUEST":
    case "UNSUPPORTED_SCHEMA_VERSION":
    case "PAYLOAD_TOO_LARGE":
      return new SenkuDecisionError("INVALID_REQUEST", requestId);
    default:
      if (status === 408 || status === 504) return new SenkuDecisionError("PROVIDER_TIMEOUT", requestId);
      if (status === 400 || status === 413) return new SenkuDecisionError("INVALID_REQUEST", requestId);
      return new SenkuDecisionError("PROVIDER_UNAVAILABLE", requestId);
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^\s*application\/json(?:\s*;[^\r\n]*)?\s*$/i.test(contentType) || !response.body) {
    throw new SenkuDecisionError("INVALID_RESPONSE");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SENKU_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SenkuDecisionError("INVALID_RESPONSE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SenkuDecisionError) throw error;
    if (signal.aborted) throw new SenkuDecisionError("PROVIDER_TIMEOUT");
    throw new SenkuDecisionError("INVALID_RESPONSE");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new SenkuDecisionError("INVALID_RESPONSE");
  }
}

function validateSenkuResponse(value: unknown, profileId: JevProfileId): SenkuDecisionResult {
  const contract = JEV_PROFILE_CONTRACTS[profileId];
  const required = [
    "schemaVersion", "requestId", "status", "profileId", "profileVersion", "provider",
    "model", "answers", "result", "durationMs", "attemptCount",
  ];
  if (!isRecord(value)
    || !hasOnlyKeys(value, [...required, "usage"])
    || required.some((key) => !Object.hasOwn(value, key))
    || value.schemaVersion !== "1"
    || safeRequestId(value.requestId) === undefined
    || value.status !== "completed"
    || value.profileId !== profileId
    || value.profileVersion !== contract.version
    || value.provider !== "jev"
    || typeof value.model !== "string"
    || value.model.trim().length === 0
    || value.model.length > 200
    || !Number.isSafeInteger(value.durationMs)
    || (value.durationMs as number) < 0
    || value.attemptCount !== 1
    || !validateAnswerSet(profileId, value.answers)
    || !validateAnswerSet(profileId, value.result)
    || !jsonValueEqual(value.answers, value.result)
    || (Object.hasOwn(value, "usage") && !validateUsage(value.usage))) {
    throw new SenkuDecisionError("INVALID_RESPONSE", isRecord(value) ? safeRequestId(value.requestId) : undefined);
  }

  return {
    model: value.model,
    answers: value.answers,
    requestId: value.requestId as string,
    durationMs: value.durationMs as number,
    attemptCount: 1,
    ...(Object.hasOwn(value, "usage") ? { usage: value.usage as SenkuUsage } : {}),
  };
}

function validateAnswerSet(profileId: JevProfileId, value: unknown): value is Record<string, unknown> {
  const contracts = JEV_PROFILE_CONTRACTS[profileId].answers;
  if (!isRecord(value) || !hasExactKeys(value, Object.keys(contracts))) return false;
  return Object.entries(contracts).every(([key, contract]) => validateAnswer(value[key], contract));
}

function validateAnswer(value: unknown, contract: AnswerContract): boolean {
  if (!isRecord(value)) return false;

  if (contract.type === "noul") {
    return hasExactKeys(value, ["type", "noul", "probabilities", "confidence"])
      && value.type === "noul"
      && isProbability(value.noul)
      && isProbabilityMap(value.probabilities, ["false", "true"])
      && Math.abs((value.probabilities as Record<string, number>).true - (value.noul as number)) <= 0.000001
      && value.confidence === null;
  }

  if (contract.type === "choice") {
    return hasExactKeys(value, ["type", "choice", "probabilities", "confidence"])
      && value.type === "choice"
      && typeof value.choice === "string"
      && contract.choices.includes(value.choice)
      && isProbabilityMap(value.probabilities, contract.choices)
      && isConfidence(value.confidence);
  }

  const legendKeys = contract.legend.map((_label, index) => String(index));
  const legend = value.legend;
  return hasExactKeys(value, ["type", "score", "legend", "probabilities", "confidence"])
    && value.type === "score"
    && typeof value.score === "number"
    && Number.isFinite(value.score)
    && value.score >= 0
    && value.score <= contract.legend.length - 1
    && isRecord(legend)
    && hasExactKeys(legend, legendKeys)
    && legendKeys.every((key, index) => legend[key] === contract.legend[index])
    && isProbabilityMap(value.probabilities, legendKeys)
    && isConfidence(value.confidence);
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
  for (const key of ["input_tokens", "output_tokens", "total_tokens"] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) return false;
  }
  return value.cost === undefined || (typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0);
}

function isConfidence(value: unknown): value is number | null {
  return value === null || isProbability(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function safeRequestId(value: unknown): string | undefined {
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
  const keys = [...expected].sort();
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

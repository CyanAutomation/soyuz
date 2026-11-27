import type { Env } from "../env";
import type { JevProfileId } from "./profiles";
import { parseSenkuResponse, safeSenkuRequestId } from "./senku-response";

export const SENKU_REQUEST_TIMEOUT_MS = 35_000;
const MAX_SENKU_RESPONSE_BYTES = 64 * 1024;
const SENKU_INTERNAL_ORIGIN = "https://service.example.invalid";

export type SenkuDecisionErrorCode =
  | "NOT_CONFIGURED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RATE_LIMITED"
  | "INVALID_RESPONSE"
  | "INVALID_REQUEST";

export class SenkuDecisionError extends Error {
  constructor(
    readonly code: SenkuDecisionErrorCode,
    readonly senkuRequestId?: string,
    readonly correlationId?: string,
    readonly retryAfterSeconds?: number,
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
  attemptCount: number;
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
  correlationId: string = crypto.randomUUID(),
): Promise<SenkuDecisionResult> {
  const token = env.SENKU_SOYUZ_API_TOKEN?.trim();
  if (!token) throw new SenkuDecisionError("NOT_CONFIGURED", undefined, correlationId);
  if (!binding || typeof binding.fetch !== "function") {
    throw new SenkuDecisionError("PROVIDER_UNAVAILABLE", undefined, correlationId);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new SenkuDecisionError("INVALID_REQUEST", undefined, correlationId);
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const marginMs = Math.min(1_000, Math.max(1, Math.floor(timeoutMs / 10)));
  const providerBudgetMs = Math.max(1, Math.min(30_000, timeoutMs - marginMs));
  const deadlineAtMs = Date.now() + providerBudgetMs;
  const request = new Request(
    SENKU_INTERNAL_ORIGIN + "/v1/profiles/" + profileId + "/evaluate",
    {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json",
        "x-correlation-id": correlationId,
        "x-senku-deadline-ms": String(deadlineAtMs),
      },
      body: JSON.stringify({ schemaVersion: "1", input }),
    },
  );

  let response: Response;
  try {
    response = await binding.fetch(request);
  } catch {
    throw new SenkuDecisionError(signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE", undefined, correlationId);
  }

  let payload: unknown;
  try {
    payload = await readBoundedJson(response, signal, correlationId);
  } catch (error) {
    if (response.ok) throw error;
    throw errorForSenkuResponse(response.status, undefined, response.headers, correlationId);
  }
  if (!response.ok) throw errorForSenkuResponse(response.status, payload, response.headers, correlationId);

  const validation = parseSenkuResponse(payload, profileId);
  if (!validation.valid) throw new SenkuDecisionError("INVALID_RESPONSE", validation.requestId, correlationId);
  return validation.result;
}

function errorForSenkuResponse(status: number, payload: unknown, headers: Headers, correlationId: string): SenkuDecisionError {
  const remoteCode = isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string"
    ? payload.error.code
    : undefined;
  const requestId = isRecord(payload) && isRecord(payload.error) && typeof payload.error.requestId === "string"
    ? safeSenkuRequestId(payload.error.requestId)
    : undefined;
  const retryAfter = headers.get("retry-after");
  const retryAfterSeconds = retryAfter && /^\d{1,5}$/.test(retryAfter) && Number(retryAfter) <= 86_400
    ? Number(retryAfter)
    : undefined;

  switch (remoteCode) {
    case "NOT_CONFIGURED":
      return new SenkuDecisionError("NOT_CONFIGURED", requestId, correlationId);
    case "PROVIDER_TIMEOUT":
      return new SenkuDecisionError("PROVIDER_TIMEOUT", requestId, correlationId);
    case "PROVIDER_UNAVAILABLE":
      return new SenkuDecisionError("PROVIDER_UNAVAILABLE", requestId, correlationId);
    case "PROVIDER_RATE_LIMITED":
      return new SenkuDecisionError("PROVIDER_RATE_LIMITED", requestId, correlationId, retryAfterSeconds);
    case "INVALID_PROVIDER_RESPONSE":
      return new SenkuDecisionError("INVALID_RESPONSE", requestId, correlationId);
    case "INVALID_REQUEST":
    case "UNSUPPORTED_SCHEMA_VERSION":
    case "PAYLOAD_TOO_LARGE":
      return new SenkuDecisionError("INVALID_REQUEST", requestId, correlationId);
    default:
      if (status === 408 || status === 504) return new SenkuDecisionError("PROVIDER_TIMEOUT", requestId, correlationId);
      if (status === 429) return new SenkuDecisionError("PROVIDER_RATE_LIMITED", requestId, correlationId, retryAfterSeconds);
      if (status === 400 || status === 413) return new SenkuDecisionError("INVALID_REQUEST", requestId, correlationId);
      return new SenkuDecisionError("PROVIDER_UNAVAILABLE", requestId, correlationId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readBoundedJson(response: Response, signal: AbortSignal, correlationId: string): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^\s*application\/json(?:\s*;[^\r\n]*)?\s*$/i.test(contentType) || !response.body) {
    throw new SenkuDecisionError("INVALID_RESPONSE", undefined, correlationId);
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
        throw new SenkuDecisionError("INVALID_RESPONSE", undefined, correlationId);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SenkuDecisionError) throw error;
    if (signal.aborted) throw new SenkuDecisionError("PROVIDER_TIMEOUT", undefined, correlationId);
    throw new SenkuDecisionError("INVALID_RESPONSE", undefined, correlationId);
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
    throw new SenkuDecisionError("INVALID_RESPONSE", undefined, correlationId);
  }
}

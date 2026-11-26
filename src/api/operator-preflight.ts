import { hasBearerToken, isBearerTokenConfigured } from "../auth/bearer";
import { errorResponse, jsonResponse } from "./http";
import type { Env } from "../env";

const PREFLIGHT_PATH = "/v1/operator/kirisame/preflight";
const CALLER_ID = "soyuz";

/** Runs Kirisame's fixed Somatic read-only authorization check using Soyuz's own RPC binding and key. */
export async function handleKirisameOperatorPreflight(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== PREFLIGHT_PATH || request.method !== "POST") return null;
  const authError = await authorizeOperatorRequest(request, env, requestId);
  if (authError) return authError;
  if (env.KIRISAME_CALLER_ID !== CALLER_ID || !isBearerTokenConfigured(env.KIRISAME_API_KEY)
    || !env.KIRISAME?.verifyCanaryAuthorization) {
    return preflightResponse(503, { status: "unavailable", code: "PREFLIGHT_CONFIGURATION_UNAVAILABLE", requestId });
  }

  let result: unknown;
  try {
    result = await env.KIRISAME.verifyCanaryAuthorization(CALLER_ID, env.KIRISAME_API_KEY);
  } catch {
    return preflightResponse(503, { status: "unavailable", code: "KIRISAME_PREFLIGHT_FAILED", requestId });
  }

  return projectPreflightResult(result, requestId);
}

async function authorizeOperatorRequest(request: Request, env: Env, requestId: string): Promise<Response | null> {
  if (!isBearerTokenConfigured(env.SOYUZ_OPERATOR_API_TOKEN)) {
    return errorResponse(requestId, 503, "OPERATOR_AUTHENTICATION_UNAVAILABLE", "Operator preflight authentication is not configured.");
  }
  if (operatorTokenIsShared(env)) {
    return errorResponse(requestId, 503, "OPERATOR_AUTHENTICATION_UNAVAILABLE", "Operator preflight authentication must use a separate credential.");
  }
  return (await hasBearerToken(request, env.SOYUZ_OPERATOR_API_TOKEN))
    ? null
    : errorResponse(requestId, 401, "UNAUTHORIZED", "Operator authorization is missing or invalid.");
}

function operatorTokenIsShared(env: Env): boolean {
  const otherCredentials = [env.CLIENT_API_TOKEN, env.CLIENT_API_TOKEN_PREVIOUS, env.WORKER_API_TOKEN,
    env.WORKER_API_TOKEN_PREVIOUS, env.KASEKI_SUBMISSION_API_TOKEN, env.KASEKI_SUBMISSION_API_TOKEN_PREVIOUS,
    env.KIRISAME_API_KEY, env.SENKU_SOYUZ_API_TOKEN];
  return otherCredentials.includes(env.SOYUZ_OPERATOR_API_TOKEN ?? "");
}

function projectPreflightResult(result: unknown, requestId: string): Response {
  if (!isRecord(result)) return preflightResponse(503, { status: "unavailable", code: "PREFLIGHT_RESPONSE_INVALID", requestId });
  if (result.status === "verified" && result.repository === "CyanAutomation/somatic") {
    return preflightResponse(200, { status: "verified", repository: result.repository, requestId });
  }
  if (result.status !== "rejected") {
    return preflightResponse(503, { status: "unavailable", code: "PREFLIGHT_RESPONSE_INVALID", requestId });
  }
  const code = safeCode(result.code) ?? "KIRISAME_PREFLIGHT_REJECTED";
  const failureStage = safeCode(result.failureStage);
  const diagnostic = isRecord(result.diagnostic) ? {
    ...(safeCode(result.diagnostic.step) ? { step: safeCode(result.diagnostic.step) } : {}),
    ...(Number.isInteger(result.diagnostic.httpStatus) ? { httpStatus: result.diagnostic.httpStatus } : {}),
  } : undefined;
  return preflightResponse(503, {
    status: "rejected", code, ...(failureStage ? { failureStage } : {}),
    ...(diagnostic ? { diagnostic } : {}), requestId,
  });
}

function preflightResponse(status: number, value: Record<string, unknown>): Response {
  const response = jsonResponse(status, value);
  response.headers.set("cache-control", "no-store");
  return response;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

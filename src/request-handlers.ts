import { hasBearerToken, isBearerTokenConfigured } from "./auth/bearer";
import { getSoyuzOAuthProvider } from "./auth/oauth";
import { handleAgentRuns } from "./api/agent-runs";
import { handleClientRuns } from "./api/runs";
import { handleRunOutcomes } from "./api/run-outcomes";
import { handleStorageUsage } from "./api/storage-usage";
import { handleClientArtifacts } from "./api/artifacts";
import { handleWorkerArtifacts } from "./api/worker-artifacts";
import { handleWorkerPublication, handleClientPublicationStatus } from "./api/publications";
import { errorResponse, rateLimitedResponse } from "./api/http";
import { handleWorkerCallbacks } from "./api/workers";
import { handleKirisameOperatorPreflight } from "./api/operator-preflight";
import type { Env } from "./env";
import { DEFAULT_RUN_ORIGIN, type RunOrigin } from "./application/runs";

export async function handleAgentRequest(request: Request, env: Env, url: URL, requestId: string): Promise<Response> {
  const credentialCollision = (isBearerTokenConfigured(env.WORKER_API_TOKEN)
    && env.WORKER_API_TOKEN === env.CLIENT_API_TOKEN)
    || (isBearerTokenConfigured(env.KASEKI_SUBMISSION_API_TOKEN)
      && env.KASEKI_SUBMISSION_API_TOKEN === env.CLIENT_API_TOKEN);
  if (credentialCollision) {
    return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Client, worker, and Kaseki submission authentication must use distinct credentials.");
  }
  if (!isBearerTokenConfigured(env.CLIENT_API_TOKEN)) {
    return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Client API-key authentication is not configured. Contact the service administrator.");
  }

  const [isClientToken, isWorkerToken, isKasekiToken] = await Promise.all([
    hasBearerToken(request, env.CLIENT_API_TOKEN, {
      previousToken: env.CLIENT_API_TOKEN_PREVIOUS,
      previousTokenExpiresAt: env.CLIENT_API_TOKEN_PREVIOUS_EXPIRES_AT,
    }),
    hasBearerToken(request, env.WORKER_API_TOKEN, {
      previousToken: env.WORKER_API_TOKEN_PREVIOUS,
      previousTokenExpiresAt: env.WORKER_API_TOKEN_PREVIOUS_EXPIRES_AT,
    }),
    hasBearerToken(request, env.KASEKI_SUBMISSION_API_TOKEN, {
      previousToken: env.KASEKI_SUBMISSION_API_TOKEN_PREVIOUS,
      previousTokenExpiresAt: env.KASEKI_SUBMISSION_API_TOKEN_PREVIOUS_EXPIRES_AT,
    }),
  ]);
  if (!isClientToken || isWorkerToken || isKasekiToken) {
    return errorResponse(requestId, 401, "UNAUTHORIZED", "Client API key is missing or invalid. Check that you are using the current client key.");
  }
  return await handleAgentRuns(request, env, url, requestId)
    ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

export async function handleDashboardApi(
  request: Request,
  env: Env,
  requestId: string,
  context: ExecutionContext,
): Promise<Response> {
  const provider = getSoyuzOAuthProvider(env);
  if (!provider) return errorResponse(requestId, 503, "OAUTH_UNAVAILABLE", "OAuth dashboard access is not configured.");
  return provider.fetch(request, env, context);
}

export async function handleOAuthRequest(
  request: Request,
  env: Env,
  requestId: string,
  context: ExecutionContext,
): Promise<Response> {
  const provider = getSoyuzOAuthProvider(env);
  if (!provider) return errorResponse(requestId, 503, "OAUTH_UNAVAILABLE", "OAuth is not configured.");
  const url = new URL(request.url);
  if (url.pathname === "/oauth/register" && request.method === "POST") {
    const clientIp = request.headers.get("cf-connecting-ip")?.trim();
    if (!clientIp) {
      return errorResponse(
        requestId,
        503,
        "CLIENT_IP_UNAVAILABLE",
        "OAuth registration is temporarily unavailable because a connecting IP could not be determined.",
      );
    }
    let outcome: RateLimitOutcome;
    try {
      outcome = await env.OAUTH_REGISTRATION_LIMITER.limit({ key: clientIp });
    } catch {
      return errorResponse(requestId, 503, "RATE_LIMITER_UNAVAILABLE", "OAuth registration is temporarily unavailable. Retry shortly.");
    }
    if (!outcome.success) return rateLimitedResponse(requestId);
  }
  return provider.fetch(request, env, context);
}

export async function handleWorkerRequest(request: Request, env: Env, url: URL, requestId: string): Promise<Response> {
  if (!isBearerTokenConfigured(env.WORKER_API_TOKEN)) {
    return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Worker API-key authentication is not configured. Contact the service administrator.");
  }
  if (!(await hasBearerToken(request, env.WORKER_API_TOKEN, {
    previousToken: env.WORKER_API_TOKEN_PREVIOUS,
    previousTokenExpiresAt: env.WORKER_API_TOKEN_PREVIOUS_EXPIRES_AT,
  }))) {
    return errorResponse(requestId, 401, "UNAUTHORIZED", "Worker API key is missing or invalid. Check that you are using the current worker key.");
  }
  const artifactResponse = await handleWorkerArtifacts(request, env, url, requestId);
  if (artifactResponse) return artifactResponse;
  const publicationResponse = await handleWorkerPublication(request, env, url, requestId);
  if (publicationResponse) return publicationResponse;
  const response = await handleWorkerCallbacks(request, env, url, requestId);
  return response ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

export async function handleOperatorRequest(request: Request, env: Env, requestId: string): Promise<Response> {
  return await handleKirisameOperatorPreflight(request, env, requestId)
    ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

type ClientAuthorization = { origin: RunOrigin } | { response: Response };

export async function handleClientRequest(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
  context: ExecutionContext,
): Promise<Response> {
  const authorization = await authorizeClientRequest(request, env, requestId);
  if ("response" in authorization) return authorization.response;
  return dispatchClientRequest(request, env, url, requestId, context, authorization.origin);
}

async function authorizeClientRequest(request: Request, env: Env, requestId: string): Promise<ClientAuthorization> {
  const kasekiConfigured = isBearerTokenConfigured(env.KASEKI_SUBMISSION_API_TOKEN);
  if (kasekiConfigured && env.KASEKI_SUBMISSION_API_TOKEN === env.CLIENT_API_TOKEN) {
    return { response: errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Kaseki submission authentication must use a credential distinct from the general client API key.") };
  }
  if (!isBearerTokenConfigured(env.CLIENT_API_TOKEN) && !kasekiConfigured) {
    return { response: errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Client API-key authentication is not configured. Contact the service administrator.") };
  }
  const kaseki = await authenticateKasekiRequest(request, env, requestId, kasekiConfigured);
  if (kaseki) return kaseki;
  const clientToken = await hasBearerToken(request, env.CLIENT_API_TOKEN, {
    previousToken: env.CLIENT_API_TOKEN_PREVIOUS,
    previousTokenExpiresAt: env.CLIENT_API_TOKEN_PREVIOUS_EXPIRES_AT,
  });
  return clientToken
    ? { origin: DEFAULT_RUN_ORIGIN }
    : { response: errorResponse(requestId, 401, "UNAUTHORIZED", "Client API key is missing or invalid. Check that you are using the current client key.") };
}

async function authenticateKasekiRequest(
  request: Request,
  env: Env,
  requestId: string,
  configured: boolean,
): Promise<ClientAuthorization | null> {
  if (!configured || !(await hasBearerToken(request, env.KASEKI_SUBMISSION_API_TOKEN, {
    previousToken: env.KASEKI_SUBMISSION_API_TOKEN_PREVIOUS,
    previousTokenExpiresAt: env.KASEKI_SUBMISSION_API_TOKEN_PREVIOUS_EXPIRES_AT,
  }))) return null;
  if (!isKasekiSubmissionRoute(new URL(request.url).pathname, request.method)) {
    return { response: errorResponse(requestId, 403, "INSUFFICIENT_SCOPE", "Kaseki submission credentials are limited to run creation, retry, and cancellation.") };
  }
  const identity = env.KASEKI_SUBMISSION_IDENTITY?.trim() || "kaseki";
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(identity)) {
    return { response: errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Kaseki submission identity configuration is invalid.") };
  }
  return { origin: { type: "kaseki", id: identity } };
}

async function dispatchClientRequest(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
  context: ExecutionContext,
  origin: RunOrigin,
): Promise<Response> {
  const artifactResponse = await handleClientArtifacts(request, env, url, requestId, context);
  if (artifactResponse) return artifactResponse;
  const publicationResponse = await handleClientPublicationStatus(request, env, url, requestId);
  if (publicationResponse) return publicationResponse;
  const outcomeResponse = await handleRunOutcomes(request, env, requestId);
  if (outcomeResponse) return outcomeResponse;
  const storageResponse = await handleStorageUsage(request, env, requestId);
  if (storageResponse) return storageResponse;
  return await handleClientRuns(request, env, url, requestId, origin)
    ?? errorResponse(requestId, 404, "NOT_FOUND", "Route was not found");
}

function isKasekiSubmissionRoute(path: string, method: string): boolean {
  if (method === "POST" && path === "/v1/runs") return true;
  return method === "POST" && /^\/v1\/runs\/[0-9a-f-]{36}\/(retry|cancel)$/i.test(path);
}

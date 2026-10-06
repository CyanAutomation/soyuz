import { errorResponse } from "../api/http";
import type { Env } from "../env";
import { hasBearerToken, isBearerTokenConfigured } from "./bearer";

/** MCP uses the client trust boundary and never accepts the worker credential. */
export async function authorizeMcpClient(request: Request, env: Env, requestId: string): Promise<Response | null> {
  if (!isBearerTokenConfigured(env.CLIENT_API_TOKEN)) {
    return errorResponse(requestId, 503, "AUTHENTICATION_UNAVAILABLE", "Client API-key authentication is not configured. Contact the service administrator.");
  }
  const [isClientToken, isWorkerToken] = await Promise.all([
    hasBearerToken(request, env.CLIENT_API_TOKEN),
    hasBearerToken(request, env.WORKER_API_TOKEN),
  ]);
  if (isClientToken && !isWorkerToken) return null;
  return errorResponse(requestId, 401, "UNAUTHORIZED", "Client API key is missing or invalid. Check that you are using the current client key.");
}

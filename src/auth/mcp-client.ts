import { errorResponse } from "../api/http";
import type { Env } from "../env";
import { hasBearerToken } from "./bearer";

/** MCP uses the client trust boundary and never accepts the worker credential. */
export async function authorizeMcpClient(request: Request, env: Env, requestId: string): Promise<Response | null> {
  const [isClientToken, isWorkerToken] = await Promise.all([
    hasBearerToken(request, env.CLIENT_API_TOKEN),
    hasBearerToken(request, env.WORKER_API_TOKEN),
  ]);
  if (isClientToken && !isWorkerToken) return null;
  return errorResponse(requestId, 401, "UNAUTHORIZED", "Client bearer token is missing or invalid");
}

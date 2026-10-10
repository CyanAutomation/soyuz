import { isUuid } from "../lib/uuid";

const MAX_JSON_BODY_BYTES = 96 * 1024;

export interface ApiErrorOptions {
  details?: unknown;
}

export function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export function successResponse(requestId: string, data: unknown, status = 200): Response {
  return jsonResponse(status, { data, requestId });
}

export function errorResponse(
  requestId: string,
  status: number,
  code: string,
  message: string,
  options: ApiErrorOptions = {},
): Response {
  const error: Record<string, unknown> = { code, message, requestId };
  if (options.details !== undefined) error.details = options.details;
  return jsonResponse(status, { error });
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly details?: unknown,
  ) {
    super(publicMessage);
  }

  toResponse(requestId: string): Response {
    return errorResponse(requestId, this.status, this.code, this.publicMessage, { details: this.details });
  }
}

export async function parseJsonBody(request: Request, requestId: string): Promise<unknown> {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_JSON_BODY_BYTES) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "Request body exceeds the 96 KB limit");
  }
  const text = new TextDecoder().decode(buffer);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

export function validationDetails(issues: Array<{ path: PropertyKey[]; message: string }>): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

export function requestIdFor(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  return supplied && isUuid(supplied)
    ? supplied
    : crypto.randomUUID();
}

import { isUuid } from "../lib/uuid";

export const MAX_JSON_BODY_BYTES = 96 * 1024;

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

export function rateLimitedResponse(requestId: string): Response {
  return jsonResponse(429, {
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Try again later.",
      requestId,
    },
  }, { "retry-after": "60" });
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

export async function readRequestBodyBytes(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    const oversizedReader = request.body?.getReader();
    if (oversizedReader) {
      try {
        await oversizedReader.cancel().catch(() => undefined);
      } finally {
        oversizedReader.releaseLock();
      }
    }
    throw requestTooLargeError(maxBytes);
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw requestTooLargeError(maxBytes);
        }
        chunks.push(value);
        size += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function requestTooLargeError(maxBytes: number): ApiError {
  const message = maxBytes === MAX_JSON_BODY_BYTES
    ? "Request body exceeds the 96 KB limit"
    : `Request body exceeds the ${maxBytes} byte limit`;
  return new ApiError(413, "REQUEST_TOO_LARGE", message);
}

export async function requestWithBoundedBody(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<Request> {
  if (request.method !== "POST" || request.body === null) return request;
  const bytes = await readRequestBodyBytes(request, maxBytes);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Request(request, { headers, body });
}

export async function parseJsonBody(request: Request, requestId: string): Promise<unknown> {
  const bytes = await readRequestBodyBytes(request);
  const text = new TextDecoder().decode(bytes);
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

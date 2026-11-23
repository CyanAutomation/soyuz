export interface DashboardResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type DashboardFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<DashboardResponse>;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function fetchJson<T = unknown>(
  path: string,
  init: RequestInit = {},
  fetcher: DashboardFetcher = fetch,
): Promise<T> {
  const response = await fetcher(path, init);
  if (!response.ok) {
    const details = await readErrorDetails(response);
    throw new HttpError("request failed", response.status, details.code, details.requestId);
  }

  const body: unknown = await response.json();
  if (body !== null && typeof body === "object" && "data" in body) {
    const data = (body as { data?: unknown }).data;
    if (data !== null && data !== undefined) return data as T;
  }
  return body as T;
}

interface SafeErrorDetails {
  code?: string;
  requestId?: string;
}

async function readErrorDetails(response: DashboardResponse): Promise<SafeErrorDetails> {
  try {
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object" || !("error" in body)) return {};
    const error = (body as { error?: unknown }).error;
    if (error === null || typeof error !== "object") return {};
    const { code, requestId } = error as { code?: unknown; requestId?: unknown };
    return {
      ...(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { code } : {}),
      ...(typeof requestId === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(requestId) ? { requestId } : {}),
    };
  } catch {
    return {};
  }
}

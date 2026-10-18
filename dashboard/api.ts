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
  constructor(message: string, readonly status: number) {
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
  if (!response.ok) throw new HttpError("request failed", response.status);

  const body: unknown = await response.json();
  if (body !== null && typeof body === "object" && "data" in body) {
    const data = (body as { data?: unknown }).data;
    if (data !== null && data !== undefined) return data as T;
  }
  return body as T;
}

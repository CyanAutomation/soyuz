import { getRunStatusPresentation } from "./presentation.js";

export const RUN_LIST_LIMIT = 50;

export interface RunListQuery {
  status?: string | null;
  cursor?: string | null;
}

export function buildRunListPath(query: RunListQuery = {}): string {
  const params = new URLSearchParams({ limit: String(RUN_LIST_LIMIT) });
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  return `/dashboard/api/runs?${params.toString()}`;
}

export function isActiveRunStatus(status: string): boolean {
  return getRunStatusPresentation(status).active;
}

import { getRunStatusPresentation } from "./presentation.js";

export const RUN_LIST_LIMIT = 30;

export interface RunListQuery {
  status?: string | null;
  cursor?: string | null;
}

export interface SearchableRun {
  displayId: string;
  runId: string;
  repoUrl: string;
  ref: string;
  status: string;
  createdAt: string;
}

export type RunSortOrder = "newest" | "oldest" | "repository" | "status";

export function buildRunListPath(query: RunListQuery = {}): string {
  const params = new URLSearchParams({ limit: String(RUN_LIST_LIMIT) });
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  return `/dashboard/api/runs?${params.toString()}`;
}

export function isActiveRunStatus(status: string): boolean {
  return getRunStatusPresentation(status).active;
}

/** Filter runs by their human and technical identifiers, then return a sorted copy. */
export function filterAndSortRuns<T extends SearchableRun>(
  runs: readonly T[],
  query: string,
  order: RunSortOrder,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? runs.filter((run) => [
      run.displayId,
      run.runId,
      run.repoUrl,
      run.ref,
      run.status.replaceAll("_", " "),
      getRunStatusPresentation(run.status).label,
    ].join(" ").toLocaleLowerCase().includes(normalizedQuery))
    : [...runs];

  return filtered.sort((left, right) => {
    if (order === "repository") {
      return left.repoUrl.localeCompare(right.repoUrl, undefined, { sensitivity: "base" })
        || newestFirst(left, right);
    }
    if (order === "status") {
      return getRunStatusPresentation(left.status).label.localeCompare(
        getRunStatusPresentation(right.status).label,
        undefined,
        { sensitivity: "base" },
      ) || newestFirst(left, right);
    }
    return order === "oldest" ? oldestFirst(left, right) : newestFirst(left, right);
  });
}

function newestFirst(left: SearchableRun, right: SearchableRun): number {
  return right.createdAt.localeCompare(left.createdAt) || left.displayId.localeCompare(right.displayId);
}

function oldestFirst(left: SearchableRun, right: SearchableRun): number {
  return left.createdAt.localeCompare(right.createdAt) || left.displayId.localeCompare(right.displayId);
}

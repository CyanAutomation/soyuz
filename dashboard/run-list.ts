import { getRunStatusPresentation } from "./presentation.js";
import { DASHBOARD_RECENT_RUN_LIMIT } from "../src/contracts/dashboard.js";

export interface SearchableRun {
  displayId: string;
  runId: string;
  repoUrl: string;
  ref: string;
  status: string;
  createdAt: string;
}

export type RunSortOrder = "newest" | "oldest" | "repository" | "status";

export function buildRunListPath(): string {
  return `/dashboard/api/runs?limit=${DASHBOARD_RECENT_RUN_LIMIT}`;
}

export function isActiveRunStatus(status: string): boolean {
  return getRunStatusPresentation(status).active;
}

/** Filter runs by their human and technical identifiers, then return a sorted copy. */
export function filterAndSortRuns<T extends SearchableRun>(
  runs: readonly T[],
  query: string,
  order: RunSortOrder,
  status?: string | null,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = runs.filter((run) => {
    if (status && run.status !== status) return false;
    if (!normalizedQuery) return true;
    return [
      run.displayId,
      run.runId,
      run.repoUrl,
      run.ref,
      run.status.replaceAll("_", " "),
      getRunStatusPresentation(run.status).label,
    ].join(" ").toLocaleLowerCase().includes(normalizedQuery);
  });

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

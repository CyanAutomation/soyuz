import { DASHBOARD_RECENT_RUN_LIMIT } from "../src/contracts/dashboard.js";

export interface RunListRecord {
  runId: string;
  createdAt: string;
}

/** Merge recent rows by stable ID and enforce the dashboard's display window. */
export function mergeRecentRunList<T extends RunListRecord>(
  current: ReadonlyMap<string, T>,
  page: readonly T[],
  replace: boolean,
): Map<string, T> {
  const merged = replace ? new Map<string, T>() : new Map(current);
  for (const run of page) merged.set(run.runId, run);
  const recent = [...merged.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId))
    .slice(0, DASHBOARD_RECENT_RUN_LIMIT);
  return new Map(recent.map((run) => [run.runId, run]));
}

export function shouldRenderRunList(refreshFirstPage: boolean, expandedRunCount: number): boolean {
  return !refreshFirstPage || expandedRunCount === 0;
}

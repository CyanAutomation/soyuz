export interface RunListRecord {
  runId: string;
}

/** Merge a server page by stable run ID, replacing the map for a reset request. */
export function mergeRunListPage<T extends RunListRecord>(
  current: ReadonlyMap<string, T>,
  page: readonly T[],
  replace: boolean,
): Map<string, T> {
  const merged = replace ? new Map<string, T>() : new Map(current);
  for (const run of page) merged.set(run.runId, run);
  return merged;
}

export function shouldRenderRunList(refreshFirstPage: boolean, expandedRunCount: number): boolean {
  return !refreshFirstPage || expandedRunCount === 0;
}

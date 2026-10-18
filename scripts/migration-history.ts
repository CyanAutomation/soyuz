/** Compare the repository's ordered migration files with D1's applied history. */
export interface MigrationHistoryComparison {
  consistent: boolean;
  missing: string[];
  unexpected: string[];
  outOfOrder: boolean;
}

export function compareMigrationHistory(
  expected: readonly string[],
  applied: readonly string[],
): MigrationHistoryComparison {
  const expectedSet = new Set(expected);
  const appliedSet = new Set(applied);
  const missing = expected.filter((name) => !appliedSet.has(name));
  const unexpected = applied.filter((name) => !expectedSet.has(name));
  const outOfOrder = expected.some((name, index) => applied[index] !== name)
    && missing.length === 0
    && unexpected.length === 0;

  return {
    consistent: missing.length === 0 && unexpected.length === 0 && !outOfOrder,
    missing,
    unexpected,
    outOfOrder,
  };
}

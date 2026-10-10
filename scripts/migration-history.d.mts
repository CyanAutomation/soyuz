export interface MigrationHistoryComparison {
  consistent: boolean;
  missing: string[];
  unexpected: string[];
  outOfOrder: boolean;
}

export function compareMigrationHistory(
  expected: readonly string[],
  applied: readonly string[],
): MigrationHistoryComparison;

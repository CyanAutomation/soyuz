const numberedMigrationPath = /^migrations\/\d+_[a-z0-9_-]+\.sql$/i;

export function changedMigrationFiles(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => numberedMigrationPath.test(path)))].sort();
}

export function findImmutableMigrationChanges(
  changedPaths: readonly string[],
  addedPaths: readonly string[],
): string[] {
  const added = new Set(changedMigrationFiles(addedPaths));
  return changedMigrationFiles(changedPaths).filter((path) => !added.has(path));
}

export function formatMigrationImpactSummary(
  paths: readonly string[],
  immutableChanges: readonly string[] = [],
): string {
  const migrations = changedMigrationFiles(paths);
  const immutable = new Set(changedMigrationFiles(immutableChanges));
  const newMigrations = migrations.filter((migration) => !immutable.has(migration));
  const preflight = "Production D1 migration preflight";
  const deploymentGuide = "[docs/DEPLOYMENT.md](https://github.com/CyanAutomation/soyuz/blob/main/docs/DEPLOYMENT.md)";

  if (migrations.length === 0) {
    return [
      "# D1 migration impact",
      "",
      "No numbered SQL migrations changed in this pull request.",
      "",
      `The ${preflight} job still verifies production D1 migration history before a main-branch Worker deployment.`,
    ].join("\n");
  }

  return [
    "# D1 migration impact",
    "",
    "This pull request changes numbered D1 migration files:",
    "",
    ...migrations.map((migration) => `- \`${migration}\``),
    "",
    ...(newMigrations.length > 0
      ? [`The automatic main-branch Worker deployment will stop at the ${preflight} job until production D1 history includes the new migrations. Coordinate the separately authorized migration before merging, or expect deployment to remain blocked until it is applied.`]
      : ["No new migrations were added. The production preflight cannot detect edits to existing SQL files, so this pull request must be corrected before merge."]),
    "",
    `This PR check does not query production or apply migrations. Follow the production migration procedure in ${deploymentGuide}; the preflight uses read-only access and blocks deployment when database identity or migration history does not match.`,
    ...(immutableChanges.length > 0
      ? [
          "",
          "Existing numbered migrations are immutable. This pull request edits or deletes migration files that already exist on the base branch:",
          "",
          ...changedMigrationFiles(immutableChanges).map((migration) => `- \`${migration}\``),
          "",
          "Restore these files and add a new numbered migration instead. The production preflight compares migration names and does not detect changed SQL contents.",
        ]
      : []),
  ].join("\n");
}

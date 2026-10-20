const numberedMigrationPath = /^migrations\/\d+_[a-z0-9_-]+\.sql$/i;

export function changedMigrationFiles(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => numberedMigrationPath.test(path)))].sort();
}

export function formatMigrationImpactSummary(paths: readonly string[]): string {
  const migrations = changedMigrationFiles(paths);
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
    `The automatic main-branch Worker deployment will stop at the ${preflight} job until production D1 history includes these migrations. Coordinate the separately authorized migration before merging, or expect deployment to remain blocked until it is applied.`,
    "",
    `This PR check does not query production or apply migrations. Follow the production migration procedure in ${deploymentGuide}; the preflight uses read-only access and blocks deployment when database identity or migration history does not match.`,
  ].join("\n");
}

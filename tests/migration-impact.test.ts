import { describe, expect, it } from "vitest";
import {
  changedMigrationFiles,
  findImmutableMigrationChanges,
  formatMigrationImpactSummary,
} from "../scripts/migration-impact.ts";

describe("D1 migration impact reporting", () => {
  it("[DEPLOY-MIGRATION-IMPACT-01] lists only unique numbered SQL files in the migrations directory", () => {
    expect(changedMigrationFiles([
      "migrations/0005_request_payload_retention.sql",
      "src/db.ts",
      "migrations/0004_run_origin_retry.sql",
      "migrations/0005_request_payload_retention.sql",
      "migrations/notes.md",
      "migrations/archive/0006_old.sql",
    ])).toEqual([
      "migrations/0004_run_origin_retry.sql",
      "migrations/0005_request_payload_retention.sql",
    ]);
  });

  it("[DEPLOY-MIGRATION-IMPACT-01] explains the production impact when migrations change", () => {
    const summary = formatMigrationImpactSummary([
      "migrations/0004_run_origin_retry.sql",
      "migrations/0005_request_payload_retention.sql",
    ]);

    expect(summary).toContain("migrations/0004_run_origin_retry.sql");
    expect(summary).toContain("migrations/0005_request_payload_retention.sql");
    expect(summary).toContain("does not query production or apply migrations");
    expect(summary).toContain("Production D1 migration preflight");
    expect(summary).toContain("docs/DEPLOYMENT.md");
  });

  it("[DEPLOY-MIGRATION-IMPACT-01] reports clearly when no numbered SQL migrations changed", () => {
    expect(formatMigrationImpactSummary(["src/db.ts", "migrations/notes.md"])).toContain(
      "No numbered SQL migrations changed in this pull request.",
    );
  });

  it("[DEPLOY-MIGRATION-IMPACT-01] identifies edits and deletions while allowing new migration files", () => {
    expect(findImmutableMigrationChanges(
      [
        "migrations/0002_run_liveness.sql",
        "migrations/0005_request_payload_retention.sql",
        "migrations/0006_new_feature.sql",
      ],
      ["migrations/0006_new_feature.sql"],
    )).toEqual([
      "migrations/0002_run_liveness.sql",
      "migrations/0005_request_payload_retention.sql",
    ]);
  });

  it("[DEPLOY-MIGRATION-IMPACT-01] explains that edits and deletions of existing migrations block the PR", () => {
    const summary = formatMigrationImpactSummary(
      ["migrations/0002_run_liveness.sql", "migrations/0006_new_feature.sql"],
      ["migrations/0002_run_liveness.sql"],
    );

    expect(summary).toContain("Existing numbered migrations are immutable");
    expect(summary).toContain("migrations/0002_run_liveness.sql");
    expect(summary).toContain("add a new numbered migration");
    expect(summary).toContain("until production D1 history includes the new migrations");
  });

  it("[DEPLOY-MIGRATION-IMPACT-01] does not promise a migration preflight for existing-file-only changes", () => {
    const summary = formatMigrationImpactSummary(
      ["migrations/0002_run_liveness.sql"],
      ["migrations/0002_run_liveness.sql"],
    );

    expect(summary).toContain("No new migrations were added");
    expect(summary).toContain("must be corrected before merge");
    expect(summary).not.toContain("will stop at the Production D1 migration preflight");
  });
});

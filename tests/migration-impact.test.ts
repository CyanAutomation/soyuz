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

  it("[DEPLOY-MIGRATION-IMPACT-01] distinguishes no numbered migration changes from a migration update", () => {
    const summary = formatMigrationImpactSummary(["src/db.ts", "migrations/notes.md"]);

    expect(summary).toContain("# D1 migration impact");
    expect(summary).toMatch(/no numbered SQL migrations changed/i);
    expect(summary).toMatch(/preflight.*migration history/i);
    expect(summary).not.toContain("migrations/notes.md");
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

  it("[DEPLOY-MIGRATION-IMPACT-01] identifies immutable-file edits and tells the author how to resolve them", () => {
    const summary = formatMigrationImpactSummary(
      ["migrations/0002_run_liveness.sql", "migrations/0006_new_feature.sql"],
      ["migrations/0002_run_liveness.sql"],
    );

    expect(summary).toMatch(/existing numbered migrations are immutable/i);
    expect(summary).toContain("migrations/0002_run_liveness.sql");
    expect(summary).toMatch(/restore these files and add a new numbered migration/i);
  });

  it("[DEPLOY-MIGRATION-IMPACT-01] explains that existing-file-only changes require correction before merge", () => {
    const summary = formatMigrationImpactSummary(
      ["migrations/0002_run_liveness.sql"],
      ["migrations/0002_run_liveness.sql"],
    );

    expect(summary).toMatch(/no new migrations were added/i);
    expect(summary).toMatch(/existing SQL files/i);
    expect(summary).toMatch(/must be corrected before merge/i);
    expect(summary).not.toMatch(/will stop at the production D1 migration preflight/i);
  });
});

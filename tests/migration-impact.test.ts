import { describe, expect, it } from "vitest";
import {
  changedMigrationFiles,
  formatMigrationImpactSummary,
} from "../scripts/migration-impact.ts";

describe("D1 migration impact reporting", () => {
  it("lists only unique numbered SQL files in the migrations directory", () => {
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

  it("explains the production impact when migrations change", () => {
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

  it("reports clearly when no numbered SQL migrations changed", () => {
    expect(formatMigrationImpactSummary(["src/db.ts", "migrations/notes.md"])).toContain(
      "No numbered SQL migrations changed in this pull request.",
    );
  });
});

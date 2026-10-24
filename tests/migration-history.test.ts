import { describe, expect, it } from "vitest";
import { compareMigrationHistory } from "../scripts/migration-history.ts";

describe("production migration compatibility", () => {
  it("[DEPLOY-MIGRATION-HISTORY-01] accepts the complete ordered migration history", () => {
    expect(compareMigrationHistory(
      ["0001_initial.sql", "0002_run_liveness.sql", "0003_run_artifacts.sql"],
      ["0001_initial.sql", "0002_run_liveness.sql", "0003_run_artifacts.sql"],
    )).toEqual({ consistent: true, missing: [], unexpected: [], outOfOrder: false });
  });

  it("[DEPLOY-MIGRATION-HISTORY-01] blocks deployment when a required migration is missing", () => {
    expect(compareMigrationHistory(
      ["0001_initial.sql", "0002_run_liveness.sql", "0003_run_artifacts.sql"],
      ["0001_initial.sql", "0002_run_liveness.sql"],
    )).toEqual({ consistent: false, missing: ["0003_run_artifacts.sql"], unexpected: [], outOfOrder: false });
  });

  it("[DEPLOY-MIGRATION-HISTORY-01] blocks deployment when production has an unknown migration", () => {
    expect(compareMigrationHistory(
      ["0001_initial.sql", "0002_run_liveness.sql", "0003_run_artifacts.sql"],
      ["0001_initial.sql", "0002_run_liveness.sql", "0003_untracked.sql"],
    )).toEqual({ consistent: false, missing: ["0003_run_artifacts.sql"], unexpected: ["0003_untracked.sql"], outOfOrder: false });
  });

  it("[DEPLOY-MIGRATION-HISTORY-01] blocks deployment when applied migrations are out of order", () => {
    expect(compareMigrationHistory(
      ["0001_initial.sql", "0002_run_liveness.sql", "0003_run_artifacts.sql"],
      ["0002_run_liveness.sql", "0001_initial.sql", "0003_run_artifacts.sql"],
    )).toEqual({ consistent: false, missing: [], unexpected: [], outOfOrder: true });
  });
});

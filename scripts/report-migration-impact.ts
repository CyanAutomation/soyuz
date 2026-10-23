import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  findImmutableMigrationChanges,
  formatMigrationImpactSummary,
} from "./migration-impact.ts";

function requireCommitSha(name: string): string {
  const value = process.env[name];
  if (!value || !/^[a-f0-9]{40,64}$/i.test(value)) {
    throw new Error(`${name} must contain a 40- or 64-character commit SHA.`);
  }
  return value;
}

const baseSha = requireCommitSha("BASE_SHA");
const headSha = requireCommitSha("HEAD_SHA");
const diffRange = `${baseSha}...${headSha}`;
function readChangedPaths(extraArgs: string[] = []): string[] {
  return execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", ...extraArgs, diffRange, "--", "migrations"],
    { encoding: "utf8" },
  ).split("\0").filter(Boolean);
}

const changedFiles = readChangedPaths();
const addedFiles = readChangedPaths(["--diff-filter=A"]);
const immutableChanges = findImmutableMigrationChanges(changedFiles, addedFiles);
const summary = formatMigrationImpactSummary(changedFiles, immutableChanges);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

if (summaryPath) {
  appendFileSync(summaryPath, `${summary}\n`);
} else {
  console.log(summary);
}

if (immutableChanges.length > 0) {
  console.error("Existing numbered D1 migrations cannot be modified or deleted; add a new numbered migration.");
  process.exitCode = 1;
}

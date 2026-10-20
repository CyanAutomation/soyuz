import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { formatMigrationImpactSummary } from "./migration-impact.ts";

function requireCommitSha(name: string): string {
  const value = process.env[name];
  if (!value || !/^[a-f0-9]{40,64}$/i.test(value)) {
    throw new Error(`${name} must contain a 40- or 64-character commit SHA.`);
  }
  return value;
}

const baseSha = requireCommitSha("BASE_SHA");
const headSha = requireCommitSha("HEAD_SHA");
const changedFiles = execFileSync(
  "git",
  ["diff", "--no-renames", "--name-only", "-z", `${baseSha}...${headSha}`, "--", "migrations"],
  { encoding: "utf8" },
).split("\0").filter(Boolean);
const summary = formatMigrationImpactSummary(changedFiles);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

if (summaryPath) {
  appendFileSync(summaryPath, `${summary}\n`);
} else {
  console.log(summary);
}

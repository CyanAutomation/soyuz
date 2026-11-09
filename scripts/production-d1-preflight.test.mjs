import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow
  .split(/(?=^  [\w-]+:\s*$)/m)
  .find((section) => section.startsWith("  production-d1-preflight:"));

test("production D1 preflight runs on main after PR-only jobs are skipped", () => {
  assert.ok(job, "production-d1-preflight job must exist");
  const condition = job.match(/^    if:\s*(.+)$/m)?.[1] ?? "";
  assert.match(condition, /\$\{\{\s*!cancelled\(\)/);
  assert.match(condition, /github\.event_name\s*==\s*'push'/);
  assert.match(condition, /github\.ref\s*==\s*'refs\/heads\/main'/);
  assert.match(condition, /needs\.validate\.result\s*==\s*'success'/);
});

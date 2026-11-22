import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectSkillPathReferences, validateSkillReferences } from "./validate-skill-references.mjs";

test("collects repository paths from inline code and ignores commands and external paths", () => {
  const markdown = [
    "Read `docs/ARCHITECTURE.md`, `src/index.ts`, and `.github/workflows/`.",
    "Run `npm test`; use `SENKU_WRANGLER_CONFIG=/absolute/path/to/senku/wrangler.jsonc`.",
    "The root config is `wrangler.jsonc`.",
  ].join("\n");

  assert.deepEqual(collectSkillPathReferences(markdown), [
    { path: "docs/ARCHITECTURE.md", line: 1 },
    { path: "src/index.ts", line: 1 },
    { path: ".github/workflows/", line: 1 },
    { path: "wrangler.jsonc", line: 3 },
  ]);
});

test("reports missing references with skill path and line number", () => {
  const root = mkdtempSync(path.join(tmpdir(), "soyuz-skill-refs-"));
  try {
    mkdirSync(path.join(root, ".github/skills/demo"), { recursive: true });
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs/EXISTS.md"), "# Exists\n");
    writeFileSync(
      path.join(root, ".github/skills/demo/SKILL.md"),
      "Read `docs/EXISTS.md`.\nAlso read `docs/MISSING.md`.\n",
    );

    const result = validateSkillReferences(root);
    assert.equal(result.skillFiles, 1);
    assert.deepEqual(result.problems, [
      {
        file: ".github/skills/demo/SKILL.md",
        line: 2,
        path: "docs/MISSING.md",
        reason: "missing",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects repository references that resolve outside the repository", () => {
  const root = mkdtempSync(path.join(tmpdir(), "soyuz-skill-refs-"));
  try {
    mkdirSync(path.join(root, ".github/skills/demo"), { recursive: true });
    writeFileSync(
      path.join(root, ".github/skills/demo/SKILL.md"),
      "Do not resolve `src/../../outside.md`.\n",
    );

    const result = validateSkillReferences(root);
    assert.deepEqual(result.problems, [
      {
        file: ".github/skills/demo/SKILL.md",
        line: 1,
        path: "src/../../outside.md",
        reason: "outside repository",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

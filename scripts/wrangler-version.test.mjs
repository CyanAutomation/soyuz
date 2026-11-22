import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getLockedWranglerVersion } from "./wrangler-version.mjs";

const packageLock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("reads the installed Wrangler version from the root lockfile entry", () => {
  assert.equal(
    getLockedWranglerVersion({
      packages: { "node_modules/wrangler": { version: "4.162.0" } },
    }),
    "4.162.0",
  );
});

test("rejects lockfiles without an exact root Wrangler version", () => {
  assert.throws(
    () => getLockedWranglerVersion({ packages: {} }),
    /root node_modules\/wrangler entry with a version/,
  );
});

test("rejects invalid versions that could corrupt GitHub Actions output", () => {
  assert.throws(
    () =>
      getLockedWranglerVersion({
        packages: { "node_modules/wrangler": { version: "4.162.0\nother=value" } },
      }),
    /valid semantic version/,
  );
});

test("CLI emits the lockfile version as a GitHub Actions output", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./wrangler-version.mjs", import.meta.url))],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `version=${getLockedWranglerVersion(packageLock)}\n`);
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function getLockedWranglerVersion(lockfile) {
  const version = lockfile?.packages?.["node_modules/wrangler"]?.version;

  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package-lock.json must contain a root node_modules/wrangler entry with a version");
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("package-lock.json must contain a valid semantic version for Wrangler");
  }

  return version;
}

async function main() {
  const lockfile = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );

  process.stdout.write(`version=${getLockedWranglerVersion(lockfile)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

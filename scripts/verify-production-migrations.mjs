import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareMigrationHistory } from "./migration-history.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_D1_READ_API_TOKEN;

function fail(message) {
  console.error(`Production D1 compatibility check failed: ${message}`);
  process.exit(1);
}

if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) {
  fail("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
}
if (!apiToken) fail("CLOUDFLARE_D1_READ_API_TOKEN is not configured.");

let config;
try {
  config = JSON.parse(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
} catch {
  fail("wrangler.jsonc must be valid JSON for the migration check.");
}

const database = config.d1_databases?.find((binding) => binding.binding === "DB");
if (!database?.database_id) fail("wrangler.jsonc has no DB binding with a database_id.");

const expected = readdirSync(path.join(root, "migrations"))
  .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
  .sort();
if (expected.length === 0) fail("no numbered SQL migrations were found.");

let response;
try {
  response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${database.database_id}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: "SELECT name FROM d1_migrations ORDER BY id" }),
      signal: AbortSignal.timeout(15_000),
    },
  );
} catch {
  fail("the read-only D1 migration-history request could not reach Cloudflare.");
}

if (!response.ok) fail(`Cloudflare returned HTTP ${response.status} for the migration-history query.`);

let payload;
try {
  payload = await response.json();
} catch {
  fail("Cloudflare returned invalid JSON for the migration-history query.");
}
if (payload.success !== true) fail("Cloudflare did not return a successful migration-history query.");

const applied = payload.result?.flatMap((query) => query.results ?? []).map((row) => row.name);
if (!Array.isArray(applied) || applied.some((name) => typeof name !== "string")) {
  fail("the D1 migration-history query returned an unexpected result shape.");
}

const comparison = compareMigrationHistory(expected, applied);
if (!comparison.consistent) {
  const details = [
    comparison.missing.length ? `missing: ${comparison.missing.join(", ")}` : "",
    comparison.unexpected.length ? `unexpected: ${comparison.unexpected.join(", ")}` : "",
    comparison.outOfOrder ? "applied migrations are out of order" : "",
  ].filter(Boolean).join("; ");
  fail(`production D1 history does not match the repository (${details}). Apply or reconcile migrations before deploying the Worker.`);
}

console.log(`Production D1 migration history is compatible (${applied.length} migrations).`);

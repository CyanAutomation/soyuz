import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareMigrationHistory } from "./migration-history.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message: string): never {
  console.error(`Production D1 compatibility check failed: ${message}`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_D1_READ_API_TOKEN;

  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) {
    fail("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
  }
  if (!apiToken) fail("CLOUDFLARE_D1_READ_API_TOKEN is not configured.");

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
  } catch {
    fail("wrangler.jsonc must be valid JSON for the migration check.");
  }

  const databases = isRecord(config) && Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const database = databases.find((binding) => isRecord(binding) && binding.binding === "DB");
  if (!isRecord(database) || typeof database.database_id !== "string" || !database.database_id) {
    fail("wrangler.jsonc has no DB binding with a database_id.");
  }

  const expected = readdirSync(path.join(root, "migrations"))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
  if (expected.length === 0) fail("no numbered SQL migrations were found.");

  let response: Response;
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

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    fail("Cloudflare returned invalid JSON for the migration-history query.");
  }
  if (!isRecord(payload) || payload.success !== true) {
    fail("Cloudflare did not return a successful migration-history query.");
  }

  const results = Array.isArray(payload.result)
    ? payload.result.flatMap((query) => isRecord(query) && Array.isArray(query.results) ? query.results : [])
    : [];
  if (results.some((row) => !isRecord(row) || typeof row.name !== "string")) {
    fail("the D1 migration-history query returned an unexpected result shape.");
  }
  const applied = results.map((row) => (row as { name: string }).name);
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
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) await main();

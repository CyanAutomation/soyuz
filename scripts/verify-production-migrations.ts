import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareMigrationHistory } from "./migration-history.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface VerificationOptions {
  configText: string;
  expectedMigrations: readonly string[];
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function configuredDatabaseId(configText: string): string {
  let config: unknown;
  try {
    config = JSON.parse(configText);
  } catch {
    throw new Error("wrangler.jsonc must be valid JSON for the migration check.");
  }

  const databases = isRecord(config) && Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const database = databases.find((binding) => isRecord(binding) && binding.binding === "DB");
  if (!isRecord(database) || typeof database.database_id !== "string" || !database.database_id) {
    throw new Error("wrangler.jsonc has no DB binding with a database_id.");
  }
  return database.database_id;
}

function appliedMigrationNames(payload: unknown): string[] {
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.result)) {
    throw new Error("Cloudflare did not return a successful migration-history query.");
  }

  const results = payload.result.flatMap((query) => {
    if (!isRecord(query) || !Array.isArray(query.results)) {
      throw new Error("the D1 migration-history query returned an unexpected result shape.");
    }
    return query.results;
  });
  if (results.some((row) => !isRecord(row) || typeof row.name !== "string")) {
    throw new Error("the D1 migration-history query returned an unexpected result shape.");
  }
  return results.map((row) => (row as { name: string }).name);
}

function migrationMismatchMessage(missing: readonly string[], unexpected: readonly string[], outOfOrder: boolean): string {
  const details = [
    missing.length ? `missing: ${missing.join(", ")}` : "",
    unexpected.length ? `unexpected: ${unexpected.join(", ")}` : "",
    outOfOrder ? "applied migrations are out of order" : "",
  ].filter(Boolean).join("; ");
  return `production D1 history does not match the repository (${details}). Apply or reconcile migrations before deploying the Worker.`;
}

export async function verifyProductionMigrations({
  configText,
  expectedMigrations,
  accountId,
  apiToken,
  fetchImpl = fetch,
}: VerificationOptions): Promise<number> {
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
  }
  if (!apiToken) throw new Error("CLOUDFLARE_D1_READ_API_TOKEN is not configured.");
  if (expectedMigrations.length === 0) throw new Error("no numbered SQL migrations were found.");

  const databaseId = configuredDatabaseId(configText);
  const applied = await readAppliedMigrations(accountId, databaseId, apiToken, fetchImpl);
  const comparison = compareMigrationHistory(expectedMigrations, applied);
  if (!comparison.consistent) {
    throw new Error(migrationMismatchMessage(comparison.missing, comparison.unexpected, comparison.outOfOrder));
  }
  return applied.length;
}

async function readAppliedMigrations(
  accountId: string,
  databaseId: string,
  apiToken: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
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
    throw new Error("the read-only D1 migration-history request could not reach Cloudflare.");
  }

  if (!response.ok) throw new Error(`Cloudflare returned HTTP ${response.status} for the migration-history query.`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Cloudflare returned invalid JSON for the migration-history query.");
  }
  return appliedMigrationNames(payload);
}

async function main(): Promise<void> {
  try {
    const expectedMigrations = readdirSync(path.join(root, "migrations"))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
      .sort();
    const count = await verifyProductionMigrations({
      configText: readFileSync(path.join(root, "wrangler.jsonc"), "utf8"),
      expectedMigrations,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_D1_READ_API_TOKEN ?? "",
    });
    console.log(`Production D1 migration history is compatible (${count} migrations).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unexpected migration compatibility failure.");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) await main();

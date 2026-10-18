import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface VerificationOptions {
  configText: string;
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
    throw new Error("wrangler.jsonc must be valid JSON for the production database check.");
  }

  const databases = isRecord(config) && Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const database = databases.find((binding) => isRecord(binding) && binding.binding === "DB");
  if (!isRecord(database) || typeof database.database_id !== "string" || !database.database_id) {
    throw new Error("wrangler.jsonc has no DB binding with a database_id.");
  }
  return database.database_id;
}

export function assertDatabaseIdentity(payload: unknown, expectedId: string): void {
  const result = isRecord(payload) ? payload.result : undefined;
  if (
    !isRecord(payload)
    || payload.success !== true
    || !isRecord(result)
    || result.uuid !== expectedId
    || result.name !== "soyuz-runs"
  ) {
    throw new Error("Cloudflare D1 identity check failed for soyuz-runs.");
  }
}

export async function verifyProductionDatabase({
  configText,
  accountId,
  apiToken,
  fetchImpl = fetch,
}: VerificationOptions): Promise<void> {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
  }
  if (!apiToken) throw new Error("CLOUDFLARE_D1_READ_API_TOKEN is not configured.");

  const databaseId = configuredDatabaseId(configText);
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`,
      {
        headers: { authorization: `Bearer ${apiToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error("The read-only Cloudflare D1 identity request could not reach Cloudflare.");
  }
  if (!response.ok) throw new Error(`Cloudflare returned HTTP ${response.status} for the D1 identity query.`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Cloudflare returned invalid JSON for the D1 identity query.");
  }
  assertDatabaseIdentity(payload, databaseId);
}

async function main(): Promise<void> {
  try {
    await verifyProductionDatabase({
      configText: readFileSync(path.join(root, "wrangler.jsonc"), "utf8"),
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_D1_READ_API_TOKEN ?? "",
    });
    console.log("Production D1 database identity verified for soyuz-runs.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected database verification failure.";
    console.error(message);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) await main();

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serializeRunOutcomeSummary } from "../src/contracts/run-outcome.ts";
import { configuredDatabaseId } from "./verify-production-database.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PAGE_SIZE = 100;
const UPDATE_BATCH_SIZE = 20;

type Cursor = { createdAt: string; id: string };
type BackfillCandidate = Cursor & { result_json: string | null };
type D1ApiStatementResult = { results?: unknown[]; meta?: unknown };

export interface BackfillOutcomeOptions {
  configText: string;
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  pageSize?: number;
  asOf?: string;
}

export interface BackfillOutcomeResult {
  scanned: number;
  backfilled: number;
  skippedInvalid: number;
}

type ExtractedSummary =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; json: string };

export function serializeBackfillOutcomeSummary(resultJson: unknown): string | null {
  const extracted = extractBackfillOutcomeSummary(resultJson);
  return extracted.kind === "valid" ? extracted.json : null;
}

export async function backfillOutcomeSummaries({
  configText,
  accountId,
  apiToken,
  fetchImpl = fetch,
  pageSize = DEFAULT_PAGE_SIZE,
  asOf = new Date().toISOString(),
}: BackfillOutcomeOptions): Promise<BackfillOutcomeResult> {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
  }
  if (!apiToken) throw new Error("CLOUDFLARE_D1_EDIT_API_TOKEN is not configured.");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
    throw new Error(`pageSize must be an integer from 1 to ${DEFAULT_PAGE_SIZE}.`);
  }

  const databaseId = configuredDatabaseId(configText);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const stats: BackfillOutcomeResult = { scanned: 0, backfilled: 0, skippedInvalid: 0 };
  const highWater = await readHighWater(endpoint, apiToken, asOf, fetchImpl);
  if (!highWater) return stats;

  let cursor: Cursor | null = null;
  while (true) {
    const candidates = await readCandidatePage(endpoint, apiToken, asOf, highWater, cursor, pageSize, fetchImpl);
    if (candidates.length === 0) break;
    stats.scanned += candidates.length;
    const valid = candidates.flatMap((candidate) => {
      const summary = extractBackfillOutcomeSummary(candidate.result_json);
      if (summary.kind === "invalid") stats.skippedInvalid += 1;
      return summary.kind === "valid" ? [{ id: candidate.id, json: summary.json }] : [];
    });
    for (let offset = 0; offset < valid.length; offset += UPDATE_BATCH_SIZE) {
      const batch = valid.slice(offset, offset + UPDATE_BATCH_SIZE);
      stats.backfilled += await writeCandidateBatch(endpoint, apiToken, asOf, batch, fetchImpl);
    }

    const last = candidates[candidates.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (candidates.length < pageSize) break;
  }
  return stats;
}

function extractBackfillOutcomeSummary(resultJson: unknown): ExtractedSummary {
  if (typeof resultJson !== "string") return { kind: "missing" };
  let result: unknown;
  try {
    result = JSON.parse(resultJson) as unknown;
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(result)) return { kind: "invalid" };
  if (result.outcomeSummary === undefined || result.outcomeSummary === null) return { kind: "missing" };
  const json = serializeRunOutcomeSummary(result.outcomeSummary);
  return json ? { kind: "valid", json } : { kind: "invalid" };
}

async function readHighWater(
  endpoint: string,
  apiToken: string,
  asOf: string,
  fetchImpl: typeof fetch,
): Promise<Cursor | null> {
  const result = await queryD1(endpoint, apiToken, `
    SELECT created_at, id FROM runs
    WHERE expires_at > ? AND outcome_summary_json IS NULL AND result_json IS NOT NULL
    ORDER BY created_at DESC, id DESC LIMIT 1
  `, [asOf], fetchImpl);
  const row = result.results?.[0];
  if (row === undefined) return null;
  return readCursor(row);
}

async function readCandidatePage(
  endpoint: string,
  apiToken: string,
  asOf: string,
  highWater: Cursor,
  cursor: Cursor | null,
  pageSize: number,
  fetchImpl: typeof fetch,
): Promise<BackfillCandidate[]> {
  const cursorFilter = cursor ? "AND (created_at, id) > (?, ?)" : "";
  const params: unknown[] = [asOf, highWater.createdAt, highWater.id];
  if (cursor) params.push(cursor.createdAt, cursor.id);
  params.push(pageSize);
  const result = await queryD1(endpoint, apiToken, `
    SELECT created_at, id, result_json FROM runs
    WHERE expires_at > ?
      AND outcome_summary_json IS NULL
      AND result_json IS NOT NULL
      AND (created_at, id) <= (?, ?)
      ${cursorFilter}
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `, params, fetchImpl);
  return (result.results ?? []).map(readCandidate);
}

async function writeCandidateBatch(
  endpoint: string,
  apiToken: string,
  asOf: string,
  candidates: Array<{ id: string; json: string }>,
  fetchImpl: typeof fetch,
): Promise<number> {
  if (candidates.length === 0) return 0;
  const values = candidates.map(() => "(?, ?)").join(", ");
  const params = candidates.flatMap(({ id, json }) => [id, json]);
  params.push(asOf);
  const result = await queryD1(endpoint, apiToken, `
    WITH incoming(id, summary_json) AS (VALUES ${values})
    UPDATE runs
    SET outcome_summary_json = (SELECT summary_json FROM incoming WHERE incoming.id = runs.id)
    WHERE id IN (SELECT id FROM incoming)
      AND outcome_summary_json IS NULL
      AND expires_at > ?
  `, params, fetchImpl);
  if (!isRecord(result.meta) || typeof result.meta.changes !== "number") {
    throw new Error("Cloudflare D1 did not return the outcome summary update count.");
  }
  return result.meta.changes;
}

async function queryD1(
  endpoint: string,
  apiToken: string,
  sql: string,
  params: unknown[],
  fetchImpl: typeof fetch,
): Promise<D1ApiStatementResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("The Cloudflare D1 outcome summary request could not reach Cloudflare.");
  }
  if (!response.ok) throw new Error(`Cloudflare returned HTTP ${response.status} for the D1 outcome summary request.`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Cloudflare returned invalid JSON for the D1 outcome summary request.");
  }
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.result)) {
    throw new Error("Cloudflare did not return a successful D1 outcome summary result.");
  }
  const statement = payload.result[0];
  if (!isRecord(statement) || statement.success !== true) {
    throw new Error("Cloudflare did not return a successful D1 outcome summary statement.");
  }
  return statement as D1ApiStatementResult;
}

function readCursor(value: unknown): Cursor {
  if (!isRecord(value) || typeof value.created_at !== "string" || typeof value.id !== "string") {
    throw new Error("Cloudflare returned an invalid D1 outcome summary cursor.");
  }
  return { createdAt: value.created_at, id: value.id };
}

function readCandidate(value: unknown): BackfillCandidate {
  const cursor = readCursor(value);
  if (!isRecord(value) || (value.result_json !== null && typeof value.result_json !== "string")) {
    throw new Error("Cloudflare returned an invalid D1 outcome summary row.");
  }
  return { ...cursor, result_json: value.result_json };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main(): Promise<void> {
  try {
    const result = await backfillOutcomeSummaries({
      configText: readFileSync(path.join(root, "wrangler.jsonc"), "utf8"),
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_D1_EDIT_API_TOKEN ?? "",
    });
    console.log(`Outcome summary backfill complete: scanned ${result.scanned}, backfilled ${result.backfilled}, skipped invalid ${result.skippedInvalid}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unexpected outcome summary backfill failure.");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) await main();

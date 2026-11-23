import { describe, expect, it, vi } from "vitest";
import { verifyProductionMigrations } from "../scripts/verify-production-migrations.ts";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const CONFIG = JSON.stringify({
  d1_databases: [
    { binding: "OTHER", database_id: "other-database" },
    { binding: "DB", database_id: DATABASE_ID },
  ],
});
const EXPECTED = ["0001_initial.sql", "0002_run_liveness.sql", "0003_run_artifacts.sql"];

function migrationHistory(names: string[]) {
  return {
    success: true,
    result: [{ results: names.map((name) => ({ name })) }],
  };
}

function verifyOptions(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return {
    configText: CONFIG,
    expectedMigrations: EXPECTED,
    accountId: ACCOUNT_ID,
    apiToken: "read-only-token",
    fetchImpl,
    ...overrides,
  };
}

describe("production D1 migration verification", () => {
  it("queries the configured DB binding and returns the applied migration count", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(migrationHistory(EXPECTED)));

    await expect(verifyProductionMigrations(verifyOptions(fetchImpl))).resolves.toBe(EXPECTED.length);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`);
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer read-only-token",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({ sql: "SELECT name FROM d1_migrations ORDER BY id" });
  });

  it.each([
    ["malformed account ID", { accountId: "not-an-account" }, "32-character hexadecimal account ID"],
    ["missing API token", { apiToken: "" }, "CLOUDFLARE_D1_READ_API_TOKEN is not configured"],
    ["invalid Wrangler config", { configText: "not json" }, "wrangler.jsonc must be valid JSON"],
    ["missing DB binding", { configText: JSON.stringify({ d1_databases: [] }) }, "no DB binding"],
    ["empty migration directory", { expectedMigrations: [] }, "no numbered SQL migrations"],
  ])("rejects %s before making a request", async (_case, overrides, message) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(verifyProductionMigrations(verifyOptions(fetchImpl, overrides))).rejects.toThrow(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["an unavailable response", async () => new Response(null, { status: 403 }), "HTTP 403"],
    ["invalid JSON", async () => new Response("not json"), "invalid JSON"],
    ["an unsuccessful query", async () => Response.json({ success: false }), "did not return a successful"],
    ["an unexpected row", async () => Response.json({ success: true, result: [{ results: [{ name: 42 }] }] }), "unexpected result shape"],
  ])("rejects %s", async (_case, response, message) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(await response());
    await expect(verifyProductionMigrations(verifyOptions(fetchImpl))).rejects.toThrow(message);
  });

  it.each([
    ["missing", ["0001_initial.sql", "0002_run_liveness.sql"], "missing: 0003_run_artifacts.sql"],
    ["unexpected", [...EXPECTED, "0004_local_only.sql"], "unexpected: 0004_local_only.sql"],
    ["out of order", [EXPECTED[1], EXPECTED[0], EXPECTED[2]], "applied migrations are out of order"],
  ])("blocks deployment when production history is %s", async (_case, applied, message) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(migrationHistory(applied)));
    await expect(verifyProductionMigrations(verifyOptions(fetchImpl))).rejects.toThrow(message);
  });
});

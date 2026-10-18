import { describe, expect, it, vi } from "vitest";
import {
  assertDatabaseIdentity,
  configuredDatabaseId,
  verifyProductionDatabase,
} from "../scripts/verify-production-database.ts";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const CONFIG = JSON.stringify({
  d1_databases: [{ binding: "DB", database_id: DATABASE_ID, database_name: "soyuz-runs" }],
});

describe("production D1 identity verification", () => {
  it("[DEPLOY-D1-IDENTITY-01] reads the configured DB binding", () => {
    expect(configuredDatabaseId(CONFIG)).toBe(DATABASE_ID);
  });

  it("[DEPLOY-D1-IDENTITY-01] rejects missing or malformed DB configuration", () => {
    expect(() => configuredDatabaseId("not json")).toThrow("valid JSON");
    expect(() => configuredDatabaseId(JSON.stringify({ d1_databases: [] }))).toThrow("no DB binding");
  });

  it("[DEPLOY-D1-IDENTITY-01] accepts only the expected database ID and name", () => {
    assertDatabaseIdentity({
      success: true,
      result: { uuid: DATABASE_ID, name: "soyuz-runs" },
    }, DATABASE_ID);

    expect(() => assertDatabaseIdentity({
      success: true,
      result: { uuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "soyuz-runs" },
    }, DATABASE_ID)).toThrow("identity check failed");
    expect(() => assertDatabaseIdentity({
      success: true,
      result: { uuid: DATABASE_ID, name: "other-database" },
    }, DATABASE_ID)).toThrow("identity check failed");
  });

  it("[DEPLOY-D1-IDENTITY-01] makes a read-only request for the configured database", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: { uuid: DATABASE_ID, name: "soyuz-runs" },
    })));

    await verifyProductionDatabase({
      configText: CONFIG,
      accountId: ACCOUNT_ID,
      apiToken: "read-only-token",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`,
      expect.objectContaining({
        headers: { authorization: "Bearer read-only-token" },
        redirect: "error",
      }),
    );
  });
});

import { describe, expect, it } from "vitest";
import { parseJsonBody } from "../src/api/http";
import { hasBearerToken } from "../src/auth/bearer";

describe("HTTP helpers", () => {
  it("accepts configured bearer tokens that meet the 16-character minimum", async () => {
    const token = "sixteen-char-key!";
    const request = new Request("https://soyuz.test", {
      headers: { authorization: `Bearer ${token}` },
    });

    await expect(hasBearerToken(request, token)).resolves.toBe(true);
    await expect(hasBearerToken(request, undefined)).resolves.toBe(false);
  });

  it("parses multibyte JSON and enforces the body limit in bytes", async () => {
    const parsed = await parseJsonBody(
      new Request("https://soyuz.test", { method: "POST", body: JSON.stringify({ value: "é" }) }),
      "request-id",
    );
    expect(parsed).toEqual({ value: "é" });

    const oversized = new Request("https://soyuz.test", { method: "POST", body: `"${"é".repeat(49_152)}"` });
    await expect(parseJsonBody(oversized, "request-id")).rejects.toMatchObject({
      status: 413,
      code: "REQUEST_TOO_LARGE",
    });
  });
});

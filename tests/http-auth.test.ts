import { describe, expect, it } from "vitest";
import { parseJsonBody } from "../src/api/http";
import { hasBearerToken } from "../src/auth/bearer";

describe("HTTP helpers", () => {
  it("[AUTH-MINIMUM-01] accepts 16-character configured bearer tokens and rejects shorter keys", async () => {
    const token = "0123456789abcdef";
    const request = new Request("https://soyuz.test", {
      headers: { authorization: `Bearer ${token}` },
    });

    await expect(hasBearerToken(request, token)).resolves.toBe(true);
    await expect(hasBearerToken(request, undefined)).resolves.toBe(false);

    const shortToken = token.slice(0, 15);
    const shortRequest = new Request("https://soyuz.test", {
      headers: { authorization: `Bearer ${shortToken}` },
    });
    await expect(hasBearerToken(shortRequest, shortToken)).resolves.toBe(false);
  });

  it("[HTTP-BODY-01] parses multibyte JSON and enforces the body limit in bytes", async () => {
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

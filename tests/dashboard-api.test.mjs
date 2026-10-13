import { describe, expect, it, vi } from "vitest";
import { fetchJson } from "../public/dashboard/api.js";

describe("dashboard API responses", () => {
  it("reports an HTTP error without trying to parse a non-JSON body", async () => {
    const response = {
      ok: false,
      json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token '<'")),
    };
    const fetcher = vi.fn().mockResolvedValue(response);

    await expect(fetchJson("/api", {}, fetcher)).rejects.toThrow("request failed");
    expect(response.json).not.toHaveBeenCalled();
  });

  it("unwraps successful API data", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { ready: true } }),
    });

    await expect(fetchJson("/api", {}, fetcher)).resolves.toEqual({ ready: true });
  });
});

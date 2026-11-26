import { describe, expect, it, vi } from "vitest";
import { handleRequest, testEnv } from "../support/api-test-helpers";
import type { Env } from "../support/api-test-helpers";

describe("public API documentation assets", () => {
  it("redirects /docs to the canonical trailing-slash URL", async () => {
    const { bindings } = testEnv();

    const response = await handleRequest(new Request("https://soyuz.test/docs"), bindings);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://soyuz.test/docs/");
  });

  it("serves the docs page and OpenAPI document through hardened public assets", async () => {
    const { bindings } = testEnv();
    const assetFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      return new Response(path === "/openapi.json" ? "{}" : "docs", {
        headers: { "content-type": path === "/openapi.json" ? "application/json" : "text/html; charset=utf-8" },
      });
    });
    bindings.ASSETS = { fetch: assetFetch } as unknown as Env["ASSETS"];

    const page = await handleRequest(new Request("https://soyuz.test/docs/"), bindings);
    const spec = await handleRequest(new Request("https://soyuz.test/openapi.json"), bindings);

    expect(assetFetch).toHaveBeenCalledTimes(2);
    expect(new URL(assetFetch.mock.calls[0]![0].url).pathname).toBe("/docs/");
    expect(new URL(assetFetch.mock.calls[1]![0].url).pathname).toBe("/openapi.json");
    for (const response of [page, spec]) {
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(spec.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    expect(spec.headers.get("content-type")).toContain("application/json");
  });
});

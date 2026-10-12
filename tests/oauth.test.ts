import { describe, expect, it } from "vitest";
import {
  allowedGithubUserIds,
  canonicalPublicOrigin,
  isAllowedGithubUser,
  requestNeedsWriteScope,
  renderConsentPage,
} from "../src/auth/oauth";

describe("Soyuz OAuth policy", () => {
  it("requires an explicit numeric GitHub user ID allowlist", () => {
    expect([...allowedGithubUserIds("123, 456")]).toEqual(["123", "456"]);
    expect([...allowedGithubUserIds(undefined)]).toEqual([]);
    expect([...allowedGithubUserIds("123,not-an-id")]).toEqual([]);
    expect(isAllowedGithubUser(123, "123, 456")).toBe(true);
    expect(isAllowedGithubUser("123x", "123")).toBe(false);
    expect(isAllowedGithubUser(789, "123, 456")).toBe(false);
  });

  it("accepts only a canonical HTTPS origin for OAuth callbacks", () => {
    expect(canonicalPublicOrigin("https://soyuz.example.test")).toBe("https://soyuz.example.test");
    expect(canonicalPublicOrigin("https://soyuz.example.test/")).toBe("https://soyuz.example.test");
    expect(canonicalPublicOrigin("http://soyuz.example.test")).toBeNull();
    expect(canonicalPublicOrigin("https://soyuz.example.test/path")).toBeNull();
    expect(canonicalPublicOrigin("https://user:pass@soyuz.example.test")).toBeNull();
  });

  it("identifies MCP tool requests that require write scope, including batches", async () => {
    const write = new Request("https://soyuz.example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "create_run" } }),
    });
    expect(await requestNeedsWriteScope(write)).toBe(true);
    const batch = new Request("https://soyuz.example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "tools/call", params: { name: "list_runs" } },
        { jsonrpc: "2.0", method: "tools/call", params: { name: "cancel_run" } },
      ]),
    });
    expect(await requestNeedsWriteScope(batch)).toBe(true);
    const read = new Request("https://soyuz.example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "get_run" } }),
    });
    expect(await requestNeedsWriteScope(read)).toBe(false);
    expect(await requestNeedsWriteScope(new Request("https://soyuz.example.test/mcp"))).toBe(false);
  });

  it("escapes all dynamic consent page content", () => {
    const html = renderConsentPage({
      clientId: "client-id",
      clientName: '<img src=x onerror="alert(1)">',
      clientDomain: "client.example.test&evil",
      redirectUri: "https://localhost:9000/callback",
      redirectHost: "localhost:9000<>",
      redirectIsLoopback: true,
      scope: ["soyuz:read", "<script>"],
    }, "handle<&");
    expect(html).toContain("&lt;img src=x onerror=&#34;alert(1)&#34;&gt;");
    expect(html).toContain("client.example.test&amp;evil");
    expect(html).toContain("localhost:9000&lt;&gt;");
    expect(html).toContain('value="handle&lt;&amp;"');
    expect(html).not.toContain("<script>");
  });
});

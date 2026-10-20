import { describe, expect, it } from "vitest";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import {
  allowedGithubUserIds,
  authorizationErrorResponse,
  bindConsentToSameOriginRequest,
  canonicalPublicOrigin,
  isAllowedGithubUser,
  oauthProviderOptions,
  requestNeedsWriteScope,
  renderConsentPage,
} from "../src/auth/oauth";
import { vi } from "vitest";

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
    expect(html).toContain('<link rel="stylesheet" href="/dashboard/style.css">');
    expect(html).toContain('class="consent-card"');
    expect(html).toContain('class="button button--primary consent-allow"');
    expect(html).not.toContain("<script>");
  });

  it("explains dashboard access in plain language", () => {
    const html = renderConsentPage({
      clientId: "dashboard-client",
      clientName: "Soyuz Run Dashboard",
      clientDomain: undefined,
      redirectUri: "https://soyuz.example.test/dashboard/",
      redirectHost: "soyuz.example.test",
      redirectIsLoopback: false,
      scope: ["soyuz:read"],
    }, "consent-handle");

    expect(html).toContain("This app provided its own name. Check that you trust it before continuing.");
    expect(html).toContain("View run status, history, and files");
    expect(html).not.toContain(">soyuz:read</span>");
  });

  it("reports OAuth failures with a support reference while keeping the public error generic", async () => {
    const requestId = "00000000-0000-4000-8000-000000000123";
    const request = new Request("https://soyuz.example.test/oauth/callback?code=private-code&state=private-state", {
      headers: { "x-request-id": requestId, cookie: "session=private-cookie" },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = authorizationErrorResponse(new Error("private access token"), request, "github_callback");
      const body = await response.text();

      expect(response.status).toBe(502);
      expect(response.headers.get("x-request-id")).toBe(requestId);
      expect(body).toContain(requestId);
      expect(body).toContain("GitHub sign-in could not be completed. Retry shortly.");
      expect(body).not.toContain("private access token");
      expect(body).not.toContain("private-code");

      expect(log).toHaveBeenCalledOnce();
      const record = JSON.parse(String(log.mock.calls[0][0]));
      expect(record).toMatchObject({
        event: "soyuz.oauth.failure",
        requestId,
        stage: "github_callback",
        errorType: "unexpected_error",
      });
      expect(JSON.stringify(record)).not.toContain("private access token");
      expect(JSON.stringify(record)).not.toContain("private-code");
      expect(JSON.stringify(record)).not.toContain("private-state");
      expect(JSON.stringify(record)).not.toContain("private-cookie");
    } finally {
      log.mockRestore();
    }
  });

  it("maps known consent transaction failures to safe diagnostic reasons", async () => {
    const request = new Request("https://soyuz.example.test/oauth/authorize", {
      headers: { "x-request-id": "00000000-0000-4000-8000-000000000125" },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const error = new AuthorizationError("invalid_request", {
        description: "This authorization was not started in this browser; start again",
      });
      const response = authorizationErrorResponse(error, request, "authorize");
      const record = JSON.parse(String(log.mock.calls[0][0]));

      expect(response.status).toBe(400);
      expect(record).toMatchObject({
        errorType: "authorization_error",
        errorCode: "invalid_request",
        failureReason: "consent_binding_cookie_missing",
      });
      expect(JSON.stringify(record)).not.toContain("This authorization was not started in this browser");
    } finally {
      log.mockRestore();
    }
  });

  it("logs the OAuth provider's stable error reason and adds a request reference without logging details", () => {
    const requestId = "00000000-0000-4000-8000-000000000124";
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const options = oauthProviderOptions("https://soyuz.example.test");
    const responseHeaders: Record<string, string> = { "content-type": "application/json" };

    try {
      const result = options.onError?.({
        code: "invalid_client",
        description: "private diagnostic description",
        status: 400,
        headers: responseHeaders,
        internal: {
          category: "client-id-metadata-document",
          reason: "metadata_resolution_failed",
          detail: { secret: "private diagnostic detail" },
        },
        request: new Request("https://soyuz.example.test/oauth/token?client_secret=private-secret", {
          headers: { "x-request-id": requestId, authorization: "Bearer private-token" },
        }),
      });

      expect(result).toBeUndefined();
      expect(responseHeaders["x-request-id"]).toBe(requestId);
      expect(log).toHaveBeenCalledOnce();
      const record = JSON.parse(String(log.mock.calls[0][0]));
      expect(record).toMatchObject({
        event: "soyuz.oauth.provider_error",
        requestId,
        category: "client-id-metadata-document",
        reason: "metadata_resolution_failed",
        oauthCode: "invalid_client",
        status: 400,
      });
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain("private diagnostic description");
      expect(serialized).not.toContain("private diagnostic detail");
      expect(serialized).not.toContain("private-secret");
      expect(serialized).not.toContain("private-token");
    } finally {
      log.mockRestore();
    }
  });

  it("restores the hashed consent binding only for same-origin form posts", async () => {
    const handle = "opaque-private-consent-handle";
    const env = { SOYUZ_PUBLIC_URL: "https://soyuz.example.test" };
    const request = new Request("https://soyuz.example.test/oauth/authorize", {
      method: "POST",
      headers: { origin: "null", "sec-fetch-site": "same-origin" },
    });
    const bound = await bindConsentToSameOriginRequest(request, handle, env);
    const cookie = bound.headers.get("cookie") ?? "";

    expect(bound).not.toBe(request);
    expect(cookie).toMatch(/^__Host-oauth-consent-[a-f0-9]{16}=[a-f0-9]{64}$/);
    expect(cookie).not.toContain(handle);

    const crossSite = new Request(request.url, {
      method: "POST",
      headers: { origin: "https://attacker.example.test", "sec-fetch-site": "cross-site" },
    });
    expect(await bindConsentToSameOriginRequest(crossSite, handle, env)).toBe(crossSite);
  });

  it("[OAUTH-CONSENT-COOKIE-01] does not duplicate a malformed cookie entry that names the consent binding", async () => {
    const handle = "opaque-private-consent-handle";
    const env = { SOYUZ_PUBLIC_URL: "https://soyuz.example.test" };
    const headers = { origin: "null", "sec-fetch-site": "same-origin" };
    const initial = await bindConsentToSameOriginRequest(
      new Request("https://soyuz.example.test/oauth/authorize", { method: "POST", headers }),
      handle,
      env,
    );
    const bindingCookieName = initial.headers.get("cookie")!.split("=")[0];
    const existing = new Request("https://soyuz.example.test/oauth/authorize", {
      method: "POST",
      headers: { ...headers, cookie: `flag; ${bindingCookieName}` },
    });

    const result = await bindConsentToSameOriginRequest(existing, handle, env);

    expect(result).toBe(existing);
    expect(result.headers.get("cookie")).toBe(`flag; ${bindingCookieName}`);
  });
});

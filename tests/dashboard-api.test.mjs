import { describe, expect, it, vi } from "vitest";
import { fetchJson } from "../public/dashboard/api.js";
import { renderAuthUi } from "../public/dashboard/auth-ui.js";
import { revokeAccessToken } from "../public/dashboard/auth-api.js";

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

  it("[DASHBOARD-AUTH-STATUS-01] preserves HTTP status so the dashboard can clear an expired or rejected sign-in", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    await expect(fetchJson("/api", {}, fetcher)).rejects.toMatchObject({ status: 401 });
  });

  it("unwraps successful API data", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { ready: true } }),
    });

    await expect(fetchJson("/api", {}, fetcher)).resolves.toEqual({ ready: true });
  });

  it("[DASHBOARD-AUTH-UI-01] renders authenticated and busy states in the dashboard header", () => {
    const button = { textContent: "", disabled: false, dataset: {} };
    const account = { hidden: false, textContent: "" };

    renderAuthUi(button, account, "signed-out");
    expect(button).toMatchObject({ textContent: "Sign in with GitHub", disabled: false });
    expect(account).toMatchObject({ hidden: true, textContent: "" });

    renderAuthUi(button, account, "signing-in");
    expect(button.disabled).toBe(true);

    renderAuthUi(button, account, "signed-in", "allowed-test-user");
    expect(button).toMatchObject({ textContent: "Sign out", disabled: false });
    expect(account).toMatchObject({ hidden: false, textContent: "Signed in as @allowed-test-user" });

    renderAuthUi(button, account, "signing-out");
    expect(button.disabled).toBe(true);
  });

  it("[OAUTH-REVOKE-FORM-01] sends the public-client RFC 7009 request to Soyuz's token endpoint", async () => {
    const response = { ok: true };
    const fetcher = vi.fn().mockResolvedValue(response);

    await revokeAccessToken("access-token", "dashboard-client", fetcher);

    expect(fetcher).toHaveBeenCalledOnce();
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/oauth/token");
    expect(init).toMatchObject({ method: "POST", cache: "no-store" });
    expect(String(init.body)).toBe(new URLSearchParams({
      token: "access-token",
      token_type_hint: "access_token",
      client_id: "dashboard-client",
    }).toString());
  });
});

describe("dashboard authentication flow", () => {
  it("[DASHBOARD-AUTH-FLOW-01] shows the signed-in identity and clears local state if revocation cannot be confirmed", async () => {
    const nodes = new Map([
      ["#notice", createNode()],
      ["#runs", createNode()],
      ["#connect", createNode()],
      ["#account", createNode()],
    ]);
    const sessionValues = new Map([
      ["soyuz.dashboard.state", "state-value"],
      ["soyuz.dashboard.verifier", "verifier-value"],
      ["soyuz.dashboard.clientId", "dashboard-client"],
      ["soyuz.dashboard.redirectUri", "https://soyuz.test/dashboard/"],
    ]);
    const storage = {
      getItem: (key) => sessionValues.get(key) ?? null,
      removeItem: (key) => sessionValues.delete(key),
      setItem: (key, value) => sessionValues.set(key, value),
    };
    const requests = [];
    let resolveRuns;
    const fetcher = vi.fn(async (path, init = {}) => {
      requests.push({ path, init });
      if (path === "/oauth/token" && new URLSearchParams(init.body).has("grant_type")) {
        return jsonResponse({ access_token: "dashboard-access-token" });
      }
      if (path === "/dashboard/api/me") return jsonResponse({ githubLogin: "current-user" });
      if (path === "/dashboard/api/runs?limit=50") {
        return new Promise((resolve) => { resolveRuns = resolve; });
      }
      if (path === "/oauth/token") return { ok: false, status: 503 };
      throw new Error(`Unexpected request: ${path}`);
    });

    vi.stubGlobal("document", { querySelector: (selector) => nodes.get(selector) });
    vi.stubGlobal("location", {
      href: "https://soyuz.test/dashboard/?code=auth-code&state=state-value",
      origin: "https://soyuz.test",
      assign: vi.fn(),
    });
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("fetch", fetcher);
    vi.resetModules();

    try {
      await import("../public/dashboard/app.js");
      await vi.waitFor(() => expect(nodes.get("#connect").textContent).toBe("Sign out"));
      await vi.waitFor(() => expect(requests.some(({ path }) => path === "/dashboard/api/runs?limit=50")).toBe(true));
      expect(nodes.get("#account")).toMatchObject({ hidden: false, textContent: "Signed in as @current-user" });
      expect(nodes.get("#notice").textContent).toBe("Loading recent runs…");

      nodes.get("#connect").listeners.click();
      await vi.waitFor(() => expect(nodes.get("#notice").textContent).toContain("could not confirm token revocation"));
      resolveRuns(jsonResponse({ runs: [] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(nodes.get("#notice").textContent).toContain("could not confirm token revocation");
      expect(nodes.get("#connect")).toMatchObject({ textContent: "Sign in with GitHub", disabled: false });
      expect(nodes.get("#account")).toMatchObject({ hidden: true, textContent: "" });
      expect(nodes.get("#runs").children).toEqual([]);
      expect(requests.at(-1).path).toBe("/oauth/token");
      expect(String(requests.at(-1).init.body)).toContain("token=dashboard-access-token");
      expect(String(requests.at(-1).init.body)).toContain("client_id=dashboard-client");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

function createNode() {
  return {
    textContent: "",
    hidden: false,
    disabled: false,
    dataset: {},
    children: [],
    listeners: {},
    addEventListener(event, callback) { this.listeners[event] = callback; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
  };
}

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

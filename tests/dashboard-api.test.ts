import { describe, expect, it, vi } from "vitest";
import { fetchJson } from "../dashboard/api.ts";
import { renderAuthUi } from "../dashboard/auth-ui.ts";
import { revokeAccessToken } from "../dashboard/auth-api.ts";

interface FakeNode {
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  dataset: DOMStringMap;
  children: unknown[];
  listeners: Record<string, (event?: Event) => void>;
  addEventListener(event: string, callback: (event?: Event) => void): void;
  append(...children: unknown[]): void;
  replaceChildren(...children: unknown[]): void;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

interface RecordedRequest {
  path: string;
  init: RequestInit;
}

describe("dashboard API responses", () => {
  it("reports an HTTP error without trying to parse a non-JSON body", async () => {
    const response = {
      ok: false,
      status: 500,
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
    const button: Pick<FakeNode, "textContent" | "disabled" | "dataset"> = {
      textContent: "",
      disabled: false,
      dataset: {} as DOMStringMap,
    };
    const account: Pick<FakeNode, "hidden" | "textContent"> = { hidden: false, textContent: "" };

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
    const storage: Pick<Storage, "getItem" | "removeItem" | "setItem"> = {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      removeItem: (key: string) => { sessionValues.delete(key); },
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
    };
    const requests: RecordedRequest[] = [];
    let resolveRuns!: (response: FakeResponse) => void;
    const fetcher = vi.fn(async (path: string, init: RequestInit = {}): Promise<FakeResponse> => {
      requests.push({ path, init });
      const requestBody = init.body instanceof URLSearchParams
        ? init.body
        : new URLSearchParams(typeof init.body === "string" ? init.body : "");
      if (path === "/oauth/token" && requestBody.has("grant_type")) {
        return jsonResponse({ access_token: "dashboard-access-token" });
      }
      if (path === "/dashboard/api/me") return jsonResponse({ githubLogin: "current-user" });
      if (path === "/dashboard/api/runs?limit=50") {
        return new Promise<FakeResponse>((resolve) => { resolveRuns = resolve; });
      }
      if (path === "/oauth/token") return { ok: false, status: 503, json: async () => ({}) };
      throw new Error(`Unexpected request: ${path}`);
    });

    vi.stubGlobal("document", { querySelector: (selector: string) => nodes.get(selector) });
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
      await import("../dashboard/app.ts");
      await vi.waitFor(() => expect(nodeAt(nodes, "#connect").textContent).toBe("Sign out"));
      await vi.waitFor(() => expect(requests.some(({ path }) => path === "/dashboard/api/runs?limit=50")).toBe(true));
      expect(nodeAt(nodes, "#account")).toMatchObject({ hidden: false, textContent: "Signed in as @current-user" });
      expect(nodeAt(nodes, "#notice").textContent).toBe("Loading recent runs…");

      nodeAt(nodes, "#connect").listeners.click?.();
      await vi.waitFor(() => expect(nodeAt(nodes, "#notice").textContent).toContain("could not confirm token revocation"));
      resolveRuns(jsonResponse({ runs: [] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(nodeAt(nodes, "#notice").textContent).toContain("could not confirm token revocation");
      expect(nodeAt(nodes, "#connect")).toMatchObject({ textContent: "Sign in with GitHub", disabled: false });
      expect(nodeAt(nodes, "#account")).toMatchObject({ hidden: true, textContent: "" });
      expect(nodeAt(nodes, "#runs").children).toEqual([]);
      const lastRequest = requests.at(-1);
      if (!lastRequest) throw new Error("Expected an OAuth revocation request");
      expect(lastRequest.path).toBe("/oauth/token");
      expect(String(lastRequest.init.body)).toContain("token=dashboard-access-token");
      expect(String(lastRequest.init.body)).toContain("client_id=dashboard-client");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

function createNode(): FakeNode {
  return {
    textContent: "",
    hidden: false,
    disabled: false,
    dataset: {} as DOMStringMap,
    children: [],
    listeners: {},
    addEventListener(event: string, callback: (event?: Event) => void) { this.listeners[event] = callback; },
    append(...children: unknown[]) { this.children.push(...children); },
    replaceChildren(...children: unknown[]) { this.children = [...children]; },
  };
}

function nodeAt(nodes: Map<string, FakeNode>, selector: string): FakeNode {
  const node = nodes.get(selector);
  if (!node) throw new Error(`Missing test node ${selector}`);
  return node;
}

function jsonResponse(data: unknown): FakeResponse {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

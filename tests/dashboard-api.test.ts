import { describe, expect, it, vi } from "vitest";
import { fetchJson } from "../dashboard/api.ts";
import { renderAuthUi } from "../dashboard/auth-ui.ts";
import { revokeAccessToken } from "../dashboard/auth-api.ts";
import { buildRunListPath, isActiveRunStatus } from "../dashboard/run-list.ts";
import {
  formatEventLabel,
  formatEventPayloadValue,
  formatMachineLabel,
  formatRepositoryName,
  getRunStatusPresentation,
  RUN_STATUS_OPTIONS,
} from "../dashboard/presentation.ts";

interface FakeNode {
  tagName: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  className: string;
  type: string;
  open: boolean;
  dataset: DOMStringMap;
  children: unknown[];
  listeners: Record<string, (event?: Event) => void>;
  addEventListener(event: string, callback: (event?: Event) => void): void;
  append(...children: unknown[]): void;
  replaceChildren(...children: unknown[]): void;
  click(): void;
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
  it("[DASHBOARD-RUN-LIST-01] encodes status and pagination cursors in run-list requests", () => {
    expect(buildRunListPath()).toBe("/dashboard/api/runs?limit=30");
    expect(buildRunListPath({ status: "running" })).toBe("/dashboard/api/runs?limit=30&status=running");
    expect(buildRunListPath({ status: "failed", cursor: "a+/=" })).toBe("/dashboard/api/runs?limit=30&status=failed&cursor=a%2B%2F%3D");
  });

  it("[DASHBOARD-RUN-LIST-02] classifies active run states", () => {
    expect(isActiveRunStatus("queued")).toBe(true);
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("completed")).toBe(false);
    expect(isActiveRunStatus("failed")).toBe(false);
  });

  it("[DASHBOARD-PRESENTATION-01] uses one readable status catalog for filters and run cards", () => {
    expect(RUN_STATUS_OPTIONS.map(({ value, label }) => [value, label])).toEqual([
      ["admitting", "Admitting"],
      ["queued", "Queued"],
      ["claimed", "Claimed"],
      ["running", "Running"],
      ["cancel_requested", "Cancellation requested"],
      ["cancelled", "Cancelled"],
      ["completed", "Completed"],
      ["failed", "Failed"],
      ["admission_failed", "Admission failed"],
    ]);
    expect(getRunStatusPresentation("cancel_requested")).toMatchObject({ label: "Cancellation requested", tone: "warning", active: true });
    expect(getRunStatusPresentation("completed")).toMatchObject({ label: "Completed", tone: "success", active: false });
    expect(getRunStatusPresentation("admission_failed")).toMatchObject({ label: "Admission failed", tone: "danger", active: false });
    expect(getRunStatusPresentation("new_internal_state")).toMatchObject({ label: "New internal state", tone: "neutral", active: false });
  });

  it("[DASHBOARD-PRESENTATION-02] turns machine values into sentence-case labels", () => {
    expect(formatMachineLabel("review_and_publish")).toBe("Review and publish");
    expect(formatEventLabel("run.started")).toBe("Run started");
    expect(formatEventLabel("run.progress.validation")).toBe("Progress update");
    expect(formatEventLabel("artifacts.uploaded")).toBe("Artifact upload report");
    expect(formatEventLabel("constructor")).toBe("Constructor");
    expect(formatEventLabel("toString")).toBe("To String");
    expect(formatEventPayloadValue("status", "cancel_requested")).toBe("Cancellation requested");
    expect(formatEventPayloadValue("publishMode", "none")).toBe("None");
    expect(formatEventPayloadValue("enabled", false)).toBe("No");
    expect(formatRepositoryName("https://github.com/example/project.git")).toBe("example/project");
    expect(formatRepositoryName("not a url")).toBe("not a url");
  });

  it("[DASHBOARD-API-ERROR-01] preserves HTTP failures without decoding a non-JSON error body", async () => {
    const response = {
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token '<'")),
    };
    const fetcher = vi.fn().mockResolvedValue(response);

    await expect(fetchJson("/api", {}, fetcher)).rejects.toMatchObject({
      name: "HttpError",
      message: "request failed",
      status: 500,
    });
    expect(response.json).not.toHaveBeenCalled();
  });

  it("[DASHBOARD-AUTH-STATUS-01] preserves HTTP status so the dashboard can clear an expired or rejected sign-in", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    await expect(fetchJson("/api", {}, fetcher)).rejects.toMatchObject({ status: 401 });
  });

  it("[DASHBOARD-API-ENVELOPE-01] unwraps the data field from successful API responses", async () => {
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
      ["#run-controls", createNode()],
      ["#connect", createNode()],
      ["#account", createNode()],
      ["#refresh", createNode()],
      ["#status-filter", createNode()],
      ["#load-more", createNode()],
      ["#updated", createNode()],
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
    const intervalCallbacks: Array<() => void> = [];
    const runId = "00000000-0000-4000-8000-000000000101";
    const initialEvents = Array.from({ length: 100 }, (_, index) => ({
      sequence: index + 1,
      type: index === 0 ? "run.started" : index === 1 ? "artifacts.uploaded" : `run.progress.${index + 1}`,
      stage: "validation",
      step: "checks",
      timestamp: "2026-10-18T12:01:00.000Z",
      payload: index === 1
        ? { status: "partial", uploadedCount: 2, failedCount: 1, skippedCount: 0 }
        : { completed: index + 1 },
    }));
    const run = {
      runId,
      status: "running",
      repoUrl: "https://github.com/example/project",
      ref: "main",
      createdAt: "2026-10-18T12:00:00.000Z",
      queuedAt: "2026-10-18T12:00:30.000Z",
      startedAt: "2026-10-18T12:01:00.000Z",
      completedAt: null,
      stage: "validation",
      origin: { type: "kaseki", id: "kaseki-prod" },
      retryOf: null,
      operationalHealth: "healthy",
      lastHeartbeatAt: "2026-10-18T12:01:00.000Z",
    };
    const fetcher = vi.fn(async (path: string, init: RequestInit = {}): Promise<FakeResponse> => {
      requests.push({ path, init });
      const requestBody = init.body instanceof URLSearchParams
        ? init.body
        : new URLSearchParams(typeof init.body === "string" ? init.body : "");
      if (path === "/oauth/token" && requestBody.has("grant_type")) {
        return jsonResponse({ access_token: "dashboard-access-token" });
      }
      if (path === "/dashboard/api/me") return jsonResponse({ githubLogin: "current-user" });
      if (path === "/dashboard/api/runs?limit=30") return jsonResponse({ runs: [run], nextCursor: "cursor+/1" });
      if (path === `/dashboard/api/runs/${runId}`) return jsonResponse({
        ...run,
        outcomeSummary: "Validation passed",
        taskMode: "inspect",
        publishMode: "pr",
        publishedUrl: "https://github.com/example/project/pull/7",
        changedFileCount: 2,
        failureClass: null,
        exitCode: 0,
      });
      if (path === `/dashboard/api/runs/${runId}/artifacts`) return jsonResponse({ artifacts: [] });
      if (path === `/dashboard/api/runs/${runId}/events?limit=100`) return jsonResponse({ events: initialEvents, nextAfter: 100, hasMore: true });
      if (path === `/dashboard/api/runs/${runId}/events?after=100&limit=100`) return jsonResponse({ events: [{ sequence: 101, type: "run.completed", stage: "validation", step: "checks", timestamp: "2026-10-18T12:02:00.000Z", payload: { status: "completed" } }], nextAfter: 101, hasMore: false });
      if (path === "/dashboard/api/runs?limit=30&cursor=cursor%2B%2F1") {
        return jsonResponse({ runs: [{ ...run, runId: "00000000-0000-4000-8000-000000000102", status: "completed" }], nextCursor: null });
      }
      if (path === "/dashboard/api/runs?limit=30&status=running") return jsonResponse({ runs: [run], nextCursor: null });
      if (path === "/oauth/token") return { ok: false, status: 503, json: async () => ({}) };
      throw new Error(`Unexpected request: ${path}`);
    });

    const documentStub = {
      visibilityState: "visible",
      querySelector: (selector: string) => nodes.get(selector),
      createElement: (tagName: string) => createNode(tagName),
      addEventListener: vi.fn(),
    };
    vi.stubGlobal("document", documentStub);
    vi.stubGlobal("location", {
      href: "https://soyuz.test/dashboard/?code=auth-code&state=state-value",
      origin: "https://soyuz.test",
      assign: vi.fn(),
    });
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("setInterval", (callback: () => void) => { intervalCallbacks.push(callback); return 1; });
    vi.stubGlobal("clearInterval", vi.fn());
    vi.resetModules();

    try {
      await import("../dashboard/app.ts");
      await vi.waitFor(() => expect(nodeAt(nodes, "#connect").textContent).toBe("Sign out"));
      await vi.waitFor(() => expect(requests.some(({ path }) => path === "/dashboard/api/runs?limit=30")).toBe(true));
      expect(nodeAt(nodes, "#run-controls").hidden).toBe(false);
      expect(nodeAt(nodes, "#runs").hidden).toBe(false);
      expect(nodeAt(nodes, "#account")).toMatchObject({ hidden: false, textContent: "Signed in as @current-user" });
      await vi.waitFor(() => expect(nodeAt(nodes, "#notice").textContent).toContain("1 run"));
      expect(nodeAt(nodes, "#runs").children).toHaveLength(1);
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain("example/project");
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Status: Running");
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain(`Created ${new Date(run.createdAt).toLocaleString()}`);
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain(`Started ${new Date(run.startedAt).toLocaleString()}`);
      expect(flattenText(nodeAt(nodes, "#status-filter"))).toContain("Cancellation requested");
      expect(intervalCallbacks).toHaveLength(1);
      documentStub.visibilityState = "hidden";
      intervalCallbacks[0]!();
      await Promise.resolve();
      expect(requests.filter(({ path }) => path === "/dashboard/api/runs?limit=30")).toHaveLength(1);
      documentStub.visibilityState = "visible";
      intervalCallbacks[0]!();
      await vi.waitFor(() => expect(requests.filter(({ path }) => path === "/dashboard/api/runs?limit=30")).toHaveLength(2));

      const details = findNode(nodeAt(nodes, "#runs"), "DETAILS");
      details.open = true;
      details.listeners.toggle?.();
      await vi.waitFor(() => expect(requests.some(({ path }) => path === `/dashboard/api/runs/${runId}/events?limit=100`)).toBe(true));
      await vi.waitFor(() => expect(flattenText(nodeAt(nodes, "#runs"))).toContain("https://github.com/example/project/pull/7"));
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Changed files 2");
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Exit code 0");
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Origin Kaseki (kaseki-prod)");
      await vi.waitFor(() => expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Run started"));
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Artifact upload report");
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Uploaded Count 2");
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Failed Count 1");
      expect(flattenText(nodeAt(nodes, "#runs"))).toContain("No artifacts are available in Soyuz for this run.");
      findNode(nodeAt(nodes, "#runs"), "BUTTON").click();
      await vi.waitFor(() => expect(requests.some(({ path }) => path === `/dashboard/api/runs/${runId}/events?after=100&limit=100`)).toBe(true));
      await vi.waitFor(() => expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Run completed"));

      nodeAt(nodes, "#load-more").listeners.click?.();
      await vi.waitFor(() => expect(requests.some(({ path }) => path === "/dashboard/api/runs?limit=30&cursor=cursor%2B%2F1")).toBe(true));
      await vi.waitFor(() => expect(nodeAt(nodes, "#runs").children).toHaveLength(2));

      nodeAt(nodes, "#status-filter").value = "running";
      nodeAt(nodes, "#status-filter").listeners.change?.();
      await vi.waitFor(() => expect(requests.some(({ path }) => path === "/dashboard/api/runs?limit=30&status=running")).toBe(true));
      await vi.waitFor(() => expect(nodeAt(nodes, "#runs").children).toHaveLength(1));

      nodeAt(nodes, "#connect").listeners.click?.();
      await vi.waitFor(() => expect(nodeAt(nodes, "#notice").textContent).toContain("couldn't confirm that your token was revoked"));
      expect(nodeAt(nodes, "#notice").textContent).toContain("couldn't confirm that your token was revoked");
      expect(nodeAt(nodes, "#connect")).toMatchObject({ textContent: "Sign in with GitHub", disabled: false });
      expect(nodeAt(nodes, "#account")).toMatchObject({ hidden: true, textContent: "" });
      expect(nodeAt(nodes, "#run-controls").hidden).toBe(true);
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

function createNode(tagName = "DIV"): FakeNode {
  const node: FakeNode = {
    tagName: tagName.toUpperCase(),
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    className: "",
    type: "",
    open: false,
    dataset: {} as DOMStringMap,
    children: [] as unknown[],
    listeners: {} as Record<string, (event?: Event) => void>,
    addEventListener(event: string, callback: (event?: Event) => void) { this.listeners[event] = callback; },
    append(...children: unknown[]) { this.children.push(...children); },
    replaceChildren(...children: unknown[]) { this.children = [...children]; },
    click() { this.listeners.click?.(); },
  };
  return node;
}

function nodeAt(nodes: Map<string, FakeNode>, selector: string): FakeNode {
  const node = nodes.get(selector);
  if (!node) throw new Error(`Missing test node ${selector}`);
  return node;
}

function jsonResponse(data: unknown): FakeResponse {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

function findNode(root: FakeNode, tagName: string): FakeNode {
  for (const child of root.children) {
    if (!child || typeof child !== "object") continue;
    const candidate = child as FakeNode & { tagName?: string };
    if (candidate.tagName === tagName) return candidate;
    try {
      return findNode(candidate, tagName);
    } catch {
      // Continue through sibling nodes.
    }
  }
  throw new Error(`Missing ${tagName} node`);
}

function flattenText(root: FakeNode): string {
  return [root.textContent, ...root.children.filter((child): child is FakeNode => Boolean(child && typeof child === "object")).map(flattenText)].join(" ");
}

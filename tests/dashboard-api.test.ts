import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, HttpError } from "../dashboard/api.ts";
import { jevAssessmentErrorMessage } from "../dashboard/jev-errors.ts";
import { renderAuthUi } from "../dashboard/auth-ui.ts";
import { revokeAccessToken } from "../dashboard/auth-api.ts";
import { buildRunListPath, isActiveRunStatus } from "../dashboard/run-list.ts";
import { safeHttpUrlForDisplay } from "../dashboard/ui/safe-url.ts";
import { mergeRunListPage, shouldRenderRunList } from "../dashboard/run-list-state.ts";

vi.mock("../dashboard/a2ui-renderer.js", () => ({
  A2uiDomRenderer: class {
    constructor(
      private readonly target: { replaceChildren(...children: unknown[]): void },
      private readonly onAction: (action: { name: string; context: Record<string, unknown> }) => void,
    ) {}
    render(messages: unknown[], hostData: Record<string, unknown> = {}) {
      const rendered: FakeNode[] = [];
      for (const value of flattenValues(hostData)) {
        const text = createNode("P");
        text.textContent = value;
        rendered.push(text);
      }
      const surface = (messages[0] as { createSurface?: { components?: Array<Record<string, any>> } })?.createSurface;
      const components = surface?.components ?? [];
      for (const component of components) {
        if (component.component !== "Button" || !component.action?.event) continue;
        const label = components.find((item) => item.id === component.child)?.text;
        const button = createNode("BUTTON");
        button.textContent = typeof label === "string" ? label : "Action";
        if (component.action.event.name === "load_more_events") button.className = "load-older-events";
        button.addEventListener("click", () => {
          const context: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(component.action.event.context ?? {})) {
            const path = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["@path"] : null;
            if (typeof path === "string") context[key] = getPathValue(hostData, path);
          }
          this.onAction({ name: component.action.event.name, context });
        });
        rendered.push(button);
      }
      this.target.replaceChildren(...rendered);
    }
    clear() { this.target.replaceChildren(); }
    dispose() { this.clear(); }
  },
}));

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
  href: string;
  target: string;
  rel: string;
  open: boolean;
  dataset: DOMStringMap;
  attributes: Record<string, string>;
  classList: { toggle(name: string, force?: boolean): boolean };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): FakeNode | null;
  querySelectorAll(selector: string): FakeNode[];
  children: unknown[];
  listeners: Record<string, Array<(event?: Event) => void>>;
  addEventListener(event: string, callback: (event?: Event) => void): void;
  dispatch(event: string, detail?: Event): void;
  append(...children: unknown[]): void;
  appendChild(child: unknown): unknown;
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
  it("[DASHBOARD-URL-PRIMITIVE-01] allows only sanitized HTTP(S) links", () => {
    expect(safeHttpUrlForDisplay("https://user:secret@example.com/path?token=secret#section"))
      .toBe("https://example.com/path");
    expect(safeHttpUrlForDisplay("javascript:alert(1)")).toBeNull();
  });

  it("[DASHBOARD-RUN-LIST-01] encodes status and pagination cursors in run-list requests", () => {
    expect(buildRunListPath()).toBe("/dashboard/api/runs?limit=30");
    expect(buildRunListPath({ status: "running" })).toBe("/dashboard/api/runs?limit=30&status=running");
    expect(buildRunListPath({ status: "failed", cursor: "a+/=" })).toBe("/dashboard/api/runs?limit=30&status=failed&cursor=a%2B%2F%3D");
  });

  it("[DASHBOARD-RUN-LIST-02] classifies every known run state as active or terminal", () => {
    for (const status of ["admitting", "queued", "claimed", "running", "cancel_requested"]) {
      expect(isActiveRunStatus(status), status).toBe(true);
    }
    for (const status of ["cancelled", "completed", "failed", "admission_failed", "unknown"]) {
      expect(isActiveRunStatus(status), status).toBe(false);
    }
  });

  it("[DASHBOARD-RUN-LIST-STATE-01] merges pages by run ID and replaces stale pages on reset", () => {
    const initial = mergeRunListPage(new Map(), [
      { runId: "run-a", status: "running" },
      { runId: "run-b", status: "queued" },
    ], true);
    const appended = mergeRunListPage(initial, [
      { runId: "run-b", status: "completed" },
      { runId: "run-c", status: "running" },
    ], false);

    expect([...appended.values()]).toEqual([
      { runId: "run-a", status: "running" },
      { runId: "run-b", status: "completed" },
      { runId: "run-c", status: "running" },
    ]);
    expect([...mergeRunListPage(appended, [{ runId: "run-d", status: "failed" }], true).keys()]).toEqual(["run-d"]);
  });

  it("[DASHBOARD-RUN-LIST-STATE-02] preserves expanded details during a quiet first-page refresh", () => {
    expect(shouldRenderRunList(true, 1)).toBe(false);
    expect(shouldRenderRunList(true, 0)).toBe(true);
    expect(shouldRenderRunList(false, 1)).toBe(true);
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

  it("[DASHBOARD-API-ERROR-01] extracts safe error identifiers without exposing server messages", async () => {
    const response = {
      ok: false,
      status: 502,
      json: vi.fn().mockResolvedValue({
        error: {
          code: "JEV_PROVIDER_UNAVAILABLE",
          message: "upstream private diagnostic",
          requestId: "dec-00000000-0000-4000-8000-000000000123",
        },
      }),
    };
    const fetcher = vi.fn().mockResolvedValue(response);

    await expect(fetchJson("/api", {}, fetcher)).rejects.toMatchObject({
      name: "HttpError",
      message: "request failed",
      status: 502,
      code: "JEV_PROVIDER_UNAVAILABLE",
      requestId: "dec-00000000-0000-4000-8000-000000000123",
    });
    expect(response.json).toHaveBeenCalledOnce();
  });

  it("[DASHBOARD-API-ERROR-02] preserves HTTP failures when an error body is not JSON", async () => {
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
      code: undefined,
      requestId: undefined,
    });
    expect(response.json).toHaveBeenCalledOnce();
  });

  it("[DASHBOARD-JEV-ERROR-01] turns known provider failures into actionable safe messages", () => {
    const unavailable = new HttpError("request failed", 502, "JEV_PROVIDER_UNAVAILABLE", "dec-00000000-0000-4000-8000-000000000123");
    expect(jevAssessmentErrorMessage(unavailable)).toBe(
      "JEV could not reach its decision service. Retry shortly. No action was taken. Reference: dec-00000000-0000-4000-8000-000000000123.",
    );
    expect(jevAssessmentErrorMessage(new HttpError("request failed", 504, "JEV_PROVIDER_TIMEOUT")))
      .toBe("JEV analysis timed out. Retry shortly. No action was taken.");
    expect(jevAssessmentErrorMessage(new HttpError("request failed", 502, "UNRECOGNIZED_CODE")))
      .toBe("JEV could not validate a response for this run. No action was taken.");
    expect(jevAssessmentErrorMessage(new HttpError("request failed", 502, "JEV_PROVIDER_UNAVAILABLE", "<script>")))
      .toBe("JEV could not reach its decision service. Retry shortly. No action was taken.");
    expect(jevAssessmentErrorMessage(new HttpError("request failed", 429)))
      .toBe("The JEV request limit was reached. Wait a minute before trying again.");
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

describe("dashboard application flows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("[DASHBOARD-AUTH-FLOW-01] identifies the signed-in user and clears dashboard data after sign-out", async () => {
    const { nodes, requests } = await mountDashboard();

    expect(nodeAt(nodes, "#account")).toMatchObject({ hidden: false, textContent: "Signed in as @current-user" });
    expect(nodeAt(nodes, "#runs").children).toHaveLength(1);
    await vi.waitFor(() => expect(requests.some(({ path }) => path === "/dashboard/api/outcomes")).toBe(true));
    expect(nodeAt(nodes, "#outcome-overview").children.length).toBeGreaterThan(0);
    expect(nodeAt(nodes, "#outcome-overview").hidden).toBe(false);
    nodeAt(nodes, "#connect").dispatch("click");

    await vi.waitFor(() => expect(nodeAt(nodes, "#notice").textContent).toContain("couldn't confirm that your token was revoked"));
    expect(nodeAt(nodes, "#connect")).toMatchObject({ textContent: "Sign in with GitHub", disabled: false });
    expect(nodeAt(nodes, "#account")).toMatchObject({ hidden: true, textContent: "" });
    expect(nodeAt(nodes, "#run-controls").hidden).toBe(true);
    expect(nodeAt(nodes, "#runs").children).toEqual([]);
    expect(nodeAt(nodes, "#outcome-overview").hidden).toBe(true);
    expect(nodeAt(nodes, "#outcome-overview").children).toEqual([]);
    expect(nodeAt(nodes, "#jev-feedback-overview").hidden).toBe(true);
    expect(nodeAt(nodes, "#jev-feedback-overview").children).toEqual([]);

    const revocation = requests.at(-1);
    expect(revocation?.path).toBe("/oauth/token");
    const form = new URLSearchParams(String(revocation?.init.body));
    expect(form.get("token")).toBe("dashboard-access-token");
    expect(form.get("client_id")).toBe("dashboard-client");
  });

  it("[DASHBOARD-OUTCOME-OVERVIEW-01] presents retained outcome aggregates after the signed-in dashboard loads them", async () => {
    const { nodes } = await mountDashboard();
    const overview = nodeAt(nodes, "#outcome-overview");

    await vi.waitFor(() => expect(flattenText(overview)).toContain("87.0 / 100"));

    expect(overview.hidden).toBe(false);
    expect(flattenText(overview)).toContain("1 of 1 runs with outcome data");
    expect(flattenText(overview)).toContain("Based on the newest 30 retained runs");
    expect(flattenText(overview)).toContain("Good · 1");
    expect(flattenText(nodeAt(nodes, "#jev-feedback-overview"))).toContain("No JEV ratings have been recorded");
  });

  it("[DASHBOARD-RUN-DISPLAY-01] shows a readable run ID and copies the canonical UUID", async () => {
    const { nodes, run, runId, writeClipboard } = await mountDashboard();

    expect(nodeAt(nodes, "#runs").children).toHaveLength(1);
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("example/project");
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Soyuz run · soyuz-213");
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Status: Running");
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Current stage ·");
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Last check-in ·");
    const card = findNodeByClass(nodeAt(nodes, "#runs"), "run-card");
    const metadata = findNodeByClass(card, "run-card__metadata");
    expect(metadata.open).toBe(false);
    expect(flattenText(metadata)).toContain("Technical ID");
    expect(flattenText(metadata)).toContain(runId);
    expect(flattenText(metadata)).toContain(`Created ${new Date(run.createdAt).toLocaleString()}`);
    expect(flattenText(metadata)).toContain(`Started ${new Date(run.startedAt).toLocaleString()}`);

    const copyIdButton = findNodeByClass(nodeAt(nodes, "#runs"), "run-card__copy-id");
    expect(copyIdButton.textContent).toBe("Copy ID");
    copyIdButton.click();
    await vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(runId));
    await vi.waitFor(() => expect(nodeAt(nodes, "#snackbar")).toMatchObject({
      hidden: false,
      textContent: "Technical run ID copied.",
      className: "snackbar snackbar--success",
    }));
    expect(copyIdButton.textContent).toBe("Copy ID");
  });

  it("[DASHBOARD-RUN-EVENTS-01] loads run details and older event pages when expanded", async () => {
    const { nodes, runId, requests } = await mountDashboard();
    const details = findNodeBySummary(nodeAt(nodes, "#runs"), "View outcome, activity, and files");
    details.open = true;
    details.dispatch("toggle");

    await vi.waitFor(() => expect(requests.some(({ path }) => path === `/dashboard/api/runs/${runId}/events?limit=100`)).toBe(true));
    await vi.waitFor(() => expect(findNodes(nodeAt(nodes, "#runs"), "A")).toHaveLength(1));
    expect(findNodes(nodeAt(nodes, "#runs"), "A").find((link) => link.textContent === "Open published URL"))
      .toMatchObject({ href: "https://github.com/example/project/pull/7", target: "_blank", rel: "noopener noreferrer" });
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Changed files 2");
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Exit code 0");
    expect(flattenText(nodeAt(nodes, "#runs"))).not.toContain("Origin Kaseki (kaseki-prod)");
    await vi.waitFor(() => expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Run started"));
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Artifact upload report");
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Uploaded Count 2");
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Failed Count 1");
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("No artifacts are available for this run.");

    findNodeByClass(nodeAt(nodes, "#runs"), "load-older-events").click();
    await vi.waitFor(() => expect(requests.some(({ path }) => path === `/dashboard/api/runs/${runId}/events?after=100&limit=100`)).toBe(true));
    await vi.waitFor(() => expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Run completed"));
  });

  it("[DASHBOARD-PUBLISHED-URL-01] does not create links from active URL schemes", async () => {
    const { nodes } = await mountDashboard("javascript:alert(1)");
    const details = findNodeBySummary(nodeAt(nodes, "#runs"), "View outcome, activity, and files");
    details.open = true;
    details.dispatch("toggle");

    await vi.waitFor(() => expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Validation passed"));
    expect(findNodes(nodeAt(nodes, "#runs"), "A")).toHaveLength(0);
  });

  it("[DASHBOARD-FAILURE-01] shows a failed run's message in the list and details as text", async () => {
    const reason = "Worker image could not start. <img src=x onerror=alert(1)>";
    const { nodes, runId } = await mountDashboard(undefined, {
      status: "failed",
      failureClass: "worker-container-startup",
      failureMessage: reason,
    });

    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Worker container startup");
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain(reason);
    const details = findNodeBySummary(nodeAt(nodes, "#runs"), "View outcome, activity, and files");
    details.open = true;
    details.dispatch("toggle");

    await vi.waitFor(() => expect(flattenText(nodeAt(nodes, "#runs"))).toContain("Failure details"));
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain(reason);
    expect(findNodes(nodeAt(nodes, "#runs"), "IMG")).toHaveLength(0);
    expect(runId).toBeTruthy();
  });

  it("[DASHBOARD-RUN-LIST-FLOW-01] pauses hidden refreshes and supports pagination and status filtering", async () => {
    const { nodes, requests, intervalCallbacks, documentStub } = await mountDashboard();

    expect(flattenText(nodeAt(nodes, "#status-filter"))).toContain("Cancellation requested");
    expect(intervalCallbacks).toHaveLength(1);
    documentStub.visibilityState = "hidden";
    intervalCallbacks[0]!();
    await Promise.resolve();
    expect(requests.filter(({ path }) => path === "/dashboard/api/runs?limit=30")).toHaveLength(1);

    documentStub.visibilityState = "visible";
    intervalCallbacks[0]!();
    await vi.waitFor(() => expect(requests.filter(({ path }) => path === "/dashboard/api/runs?limit=30")).toHaveLength(2));
    await vi.waitFor(() => expect(nodeAt(nodes, "#load-more").disabled).toBe(false));

    nodeAt(nodes, "#load-more").dispatch("click");
    await vi.waitFor(() => expect(requests.some(({ path }) => path === "/dashboard/api/runs?limit=30&cursor=cursor%2B%2F1")).toBe(true));
    await vi.waitFor(() => expect(nodeAt(nodes, "#runs").children).toHaveLength(2));
    await vi.waitFor(() => expect(nodeAt(nodes, "#load-more").hidden).toBe(true));

    nodeAt(nodes, "#run-search").value = "other-project";
    nodeAt(nodes, "#run-search").dispatch("input");
    expect(nodeAt(nodes, "#runs").children).toHaveLength(1);
    expect(flattenText(nodeAt(nodes, "#runs"))).toContain("example/other-project");
    expect(nodeAt(nodes, "#run-count").textContent).toBe("Showing 1 of 2 retained runs");

    nodeAt(nodes, "#run-search").value = "";
    nodeAt(nodes, "#run-search").dispatch("input");

    nodeAt(nodes, "#status-filter").value = "running";
    nodeAt(nodes, "#status-filter").dispatch("change");
    await vi.waitFor(() => expect(requests.some(({ path }) => path === "/dashboard/api/runs?limit=30&status=running")).toBe(true));
    await vi.waitFor(() => expect(nodeAt(nodes, "#runs").children).toHaveLength(1));
  });
});

async function mountDashboard(
  publishedUrl: string | undefined = "https://github.com/example/project/pull/7",
  runOverrides: Record<string, unknown> = {},
) {
  const nodes = new Map([
    ["#notice", createNode()],
    ["#runs", createNode()],
    ["#run-intelligence", createNode()],
    ["#outcome-overview", createNode()],
    ["#jev-feedback-overview", createNode()],
    ["#run-controls", createNode()],
    ["#connect", createNode()],
    ["#account", createNode()],
    ["#refresh", createNode()],
    ["#run-search", createNode("INPUT")],
    ["#run-sort", createNode("SELECT")],
    ["#run-count", createNode("P")],
    ["#status-filter", createNode()],
    ["#load-more", createNode()],
    ["#updated", createNode()],
    ["#snackbar", createNode()],
  ]);
  for (const selector of ["#runs", "#run-intelligence", "#outcome-overview", "#jev-feedback-overview", "#run-controls"]) {
    nodeAt(nodes, selector).hidden = true;
  }
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
  const writeClipboard = vi.fn(async (_value: string) => {});
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
    displayId: "soyuz-213",
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
    failureClass: null,
    failureMessage: null,
    ...runOverrides,
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
    if (path === "/dashboard/api/outcomes") return jsonResponse({
      scope: { retainedRuns: 30, includedRuns: 1, runsWithOutcomeSummary: 1 },
      byAssessment: { good: 1 }, byReviewerConfidence: { high: 1 }, byGrade: { B: 1 }, averageScore: 87,
      improvementCategories: [], phaseDurations: [],
    });
    if (path === "/dashboard/api/analysis/feedback-summary") return jsonResponse({ profiles: [] });
    if (path === "/dashboard/api/runs?limit=30") return jsonResponse({ runs: [run], nextCursor: "cursor+/1" });
    if (path === `/dashboard/api/runs/${runId}`) return jsonResponse({
      ...run,
      outcomeSummary: "Validation passed",
      taskMode: "inspect",
      publishMode: "pr",
      publishedUrl,
      changedFileCount: 2,
      failureClass: run.failureClass ?? null,
      failureMessage: run.failureMessage ?? null,
      exitCode: 0,
    });
    if (path === `/dashboard/api/runs/${runId}/artifacts`) return jsonResponse({ artifacts: [] });
    if (path === `/dashboard/api/runs/${runId}/events?limit=100`) return jsonResponse({ events: initialEvents, nextAfter: 100, hasMore: true });
    if (path === `/dashboard/api/runs/${runId}/events?after=100&limit=100`) return jsonResponse({ events: [{ sequence: 101, type: "run.completed", stage: "validation", step: "checks", timestamp: "2026-10-18T12:02:00.000Z", payload: { status: "completed" } }], nextAfter: 101, hasMore: false });
    if (path === "/dashboard/api/runs?limit=30&cursor=cursor%2B%2F1") {
      return jsonResponse({ runs: [{
        ...run,
        runId: "00000000-0000-4000-8000-000000000102",
        displayId: "soyuz-214",
        repoUrl: "https://github.com/example/other-project",
        ref: "feature/cache-fix",
        createdAt: "2026-10-19T12:00:00.000Z",
        status: "completed",
      }], nextCursor: null });
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

  vi.resetModules();
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("location", {
    href: "https://soyuz.test/dashboard/?code=auth-code&state=state-value",
    origin: "https://soyuz.test",
    assign: vi.fn(),
  });
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("history", { replaceState: vi.fn() });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("navigator", { clipboard: { writeText: writeClipboard } });
  vi.stubGlobal("setInterval", (callback: () => void) => { intervalCallbacks.push(callback); return 1; });
  vi.stubGlobal("clearInterval", vi.fn());
  await import("../dashboard/app.ts");
  await vi.waitFor(() => expect(nodeAt(nodes, "#connect").textContent).toBe("Sign out"));
  await vi.waitFor(() => expect(nodeAt(nodes, "#runs").children).toHaveLength(1));

  return { nodes, requests, intervalCallbacks, writeClipboard, documentStub, run, runId };
}

function createNode(tagName = "DIV"): FakeNode {
  const node: FakeNode = {
    tagName: tagName.toUpperCase(),
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    className: "",
    type: "",
    href: "",
    target: "",
    rel: "",
    open: false,
    dataset: {} as DOMStringMap,
    classList: {
      toggle(name: string, force?: boolean) {
        const classes = new Set(node.className.split(/\s+/).filter(Boolean));
        const shouldAdd = force ?? !classes.has(name);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        node.className = [...classes].join(" ");
        return shouldAdd;
      },
    },
    setAttribute(name: string, value: string) { node.attributes[name] = value; },
    removeAttribute(name: string) { delete node.attributes[name]; },
    querySelector(selector: string) { return findFakeNodes(node, selector)[0] ?? null; },
    querySelectorAll(selector: string) { return findFakeNodes(node, selector); },
    attributes: {} as Record<string, string>,
    children: [] as unknown[],
    listeners: {} as Record<string, Array<(event?: Event) => void>>,
    addEventListener(event: string, callback: (event?: Event) => void) {
      (this.listeners[event] ??= []).push(callback);
    },
    dispatch(event: string, detail?: Event) {
      for (const callback of [...(this.listeners[event] ?? [])]) callback(detail);
    },
    append(...children: unknown[]) { this.children.push(...children); },
    appendChild(child: unknown) { this.children.push(child); return child; },
    replaceChildren(...children: unknown[]) { this.children = [...children]; },
    click() { this.dispatch("click"); },
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

function findNodes(root: FakeNode, tagName: string): FakeNode[] {
  const found: FakeNode[] = [];
  for (const child of root.children) {
    if (!child || typeof child !== "object") continue;
    const candidate = child as FakeNode;
    if (candidate.tagName === tagName) found.push(candidate);
    found.push(...findNodes(candidate, tagName));
  }
  return found;
}

function findFakeNodes(root: FakeNode, selector: string): FakeNode[] {
  const className = selector.startsWith(".") ? selector.slice(1) : null;
  const found: FakeNode[] = [];
  for (const child of root.children) {
    if (!child || typeof child !== "object") continue;
    const candidate = child as FakeNode;
    if (className && candidate.className.split(/\s+/).includes(className)) found.push(candidate);
    found.push(...findFakeNodes(candidate, selector));
  }
  return found;
}

function findNodeBySummary(root: FakeNode, text: string): FakeNode {
  if (root.tagName === "DETAILS" && root.children.some((child) => child && typeof child === "object" && (child as FakeNode).tagName === "SUMMARY" && (child as FakeNode).textContent === text)) return root;
  for (const child of root.children) {
    if (child && typeof child === "object") {
      try { return findNodeBySummary(child as FakeNode, text); }
      catch { /* Keep searching this tree. */ }
    }
  }
  throw new Error(`Could not find details with summary ${text}`);
}

function findNodeByClass(root: FakeNode, className: string): FakeNode {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) {
    if (!child || typeof child !== "object") continue;
    try {
      return findNodeByClass(child as FakeNode, className);
    } catch {
      // Continue through sibling nodes.
    }
  }
  throw new Error(`Missing node with class ${className}`);
}

function flattenText(root: FakeNode): string {
  return [root.textContent, ...root.children.filter((child): child is FakeNode => Boolean(child && typeof child === "object")).map(flattenText)].join(" ");
}

function flattenValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenValues);
  return [];
}

function getPathValue(root: Record<string, unknown>, path: string): unknown {
  return path.split("/").filter(Boolean).reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, root);
}

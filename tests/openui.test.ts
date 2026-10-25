import { afterEach, describe, expect, it, vi } from "vitest";
import { createParser, createStreamingParser, mergeStatements } from "@openuidev/lang-core";
import { parseHTML } from "linkedom";
import { OpenUIDOMRenderer } from "../openui/dom-renderer";
import { generateSoyuzSystemPrompt, soyuzOpenUILibrary, validateSoyuzAction } from "../openui/library";
import { createSoyuzOpenUIRuntime, validateGeneratedProgram } from "../openui/runtime";
import { soyuzComponentRenderers } from "../dashboard/analysis/components";

const validProgram = [
  '$runStatus = "all"',
  '$selectedRunId = ""',
  'runs = Query("list_runs", { limit: 30, status: $runStatus }, { runs: [], nextCursor: null })',
  'root = Stack([Heading("Recent runs"), MetricCard("Runs", @Count(runs.runs)), MetricCard("Success", @SuccessPercentage(runs.runs)), MetricCard("Average duration", @AverageDurationMs(runs.runs)), StatusChart(@StatusDistribution(runs.runs)), RunTable(runs.runs)])',
].join("\n");

describe("Soyuz OpenUI Core integration", () => {
  it("[OPENUI-CORE-01] registers the supported library and generates its prompt from the same component definitions", () => {
    expect(Object.keys(soyuzOpenUILibrary.components)).toEqual([
      "Stack", "Heading", "Text", "MetricCard", "RunTable", "StatusChart", "EventTimeline", "Notice", "ActionButton",
    ]);
    const prompt = generateSoyuzSystemPrompt();
    expect(prompt).toContain("RunTable");
    expect(prompt).toContain("StatusDistribution");
    expect(prompt).toContain("list_runs");
    expect(prompt).toContain("Never fabricate run information");
    expect(prompt).toContain("Do not emit Mutation statements");
  });

  it("[OPENUI-CORE-01] parses streamed OpenUI Lang through the official parser and accepts a complete program", () => {
    const parser = createStreamingParser(soyuzOpenUILibrary.toJSONSchema(), "Stack");
    const partial = parser.set(validProgram.slice(0, 85));
    expect(partial.meta.incomplete).toBe(true);
    const completed = parser.set(validProgram, true);
    expect(completed.root?.typeName).toBe("Stack");
    expect(completed.queryStatements).toHaveLength(1);
    expect(validateGeneratedProgram(validProgram).ok).toBe(true);
  });

  it("[OPENUI-CORE-01] rejects unknown tools, fabricated run data, invalid props, and unresolved references", () => {
    expect(validateGeneratedProgram('root = Stack([RunTable([])])').ok).toBe(false);
    expect(validateGeneratedProgram('root = Stack([RunTable([])])').reason).toContain("read-only query");
    expect(validateGeneratedProgram('root = Stack([MetricCard("Runs", 5000)])').reason).toContain("approved query");
    expect(validateGeneratedProgram('root = Stack([Heading(123)])').ok).toBe(false);
    expect(validateGeneratedProgram('root = Stack([Heading(missingTitle)])').ok).toBe(false);
    expect(validateGeneratedProgram('root = Stack([Notice("Safe", "info")])\nwrite = Mutation("create_run", {}, {})').ok).toBe(false);
    const arbitraryQuery = [
      'runs = Query("arbitrary_http", { url: "https://example.invalid" }, { runs: [], nextCursor: null })',
      'root = Stack([RunTable(runs.runs)])',
    ].join("\n");
    expect(validateGeneratedProgram(arbitraryQuery).reason).toContain("unsupported data query");
  });

  it("[OPENUI-CORE-01] merges incremental edits using OpenUI Core and validates the merged program", () => {
    const original = 'title = Heading("Recent runs")\nroot = Stack([title])';
    const patch = 'title = Heading("Run analysis")\nsummary = Text("Summary of recorded run data")\nroot = Stack([title, summary])';
    const merged = mergeStatements(original, patch, "root");
    expect(merged).toContain('Heading("Run analysis")');
    expect(merged).toContain('Text("Summary of recorded run data")');
    expect(validateGeneratedProgram(merged).ok).toBe(true);
  });

  it("[OPENUI-CORE-01] validates distinct summary, status-distribution, and event-history interfaces", () => {
    const programs = [
      validProgram,
      [
        'runs = Query("list_runs", { limit: 10, status: "all" }, { runs: [], nextCursor: null })',
        'root = Stack([Heading("Success and failure"), StatusChart(@StatusDistribution(runs.runs)), RunTable(runs.runs)])',
      ].join("\n"),
      [
        '$selectedRunId = ""',
        'events = Query("get_run_events", { runId: $selectedRunId, limit: 50 }, { events: [], nextAfter: 0, hasMore: false })',
        'root = Stack([Heading("Selected run events"), EventTimeline(events.events)])',
      ].join("\n"),
    ];
    expect(programs.map((program) => validateGeneratedProgram(program).ok)).toEqual([true, true, true]);
  });

  it("[OPENUI-ACTION-01] validates action names and parameters against the explicit read-only action set", () => {
    expect(validateSoyuzAction({ type: "refresh_runs", params: {} })).toEqual({ type: "refresh_runs", params: {} });
    expect(validateSoyuzAction({ type: "select_run", params: { runId: "not-a-uuid" } })).toBeNull();
    expect(validateSoyuzAction({ type: "create_run", params: { repoUrl: "https://github.com/example/repo" } })).toBeNull();
    expect(validateSoyuzAction({ type: "navigate_dashboard", params: { path: "javascript:alert(1)" } })).toBeNull();
  });

  it("[OPENUI-QUERY-01] runs bounded read-only queries, evaluates expressions, and refetches when a store dependency changes", async () => {
    const requests: string[] = [];
    const run = {
      runId: "00000000-0000-4000-8000-000000000001",
      displayId: "42",
      status: "completed",
      repoUrl: "https://github.com/example/repo",
      ref: "main",
      stage: null,
      operationalHealth: "healthy",
      failureClass: null,
      createdAt: "2026-10-01T10:00:00.000Z",
      queuedAt: "2026-10-01T10:00:00.000Z",
      startedAt: "2026-10-01T10:01:00.000Z",
      completedAt: "2026-10-01T10:02:00.000Z",
    };
    const fetcher: typeof fetch = vi.fn(async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ data: { runs: [run], nextCursor: null } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const parsed = validateGeneratedProgram(validProgram);
    expect(parsed.ok).toBe(true);
    const runtime = createSoyuzOpenUIRuntime("session-token", fetcher);
    runtime.setProgram(parsed.result!);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.waitFor(() => expect(runtime.queryManager.isAnyLoading()).toBe(false));
    expect(requests[0]).toBe("/dashboard/api/runs?limit=30");
    const children = runtime.getRoot()?.props.children as Array<{ typeName: string; props: Record<string, unknown> }>;
    const metrics = children.filter((child) => child.typeName === "MetricCard");
    expect(metrics.map((child) => child.props.value)).toEqual([1, 100, 60_000]);
    expect(children.find((child) => child.typeName === "StatusChart")?.props.items).toEqual([{ status: "completed", count: 1 }]);

    runtime.store.set("$runStatus", "failed");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toBe("/dashboard/api/runs?limit=30&status=failed");

    runtime.refresh();
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    runtime.dispose();
  });

  it("[OPENUI-QUERY-01] rejects invalid query arguments before making a request", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { runs: [], nextCursor: null } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const program = [
      '$runStatus = "all"',
      'runs = Query("list_runs", { limit: 999 }, { runs: [], nextCursor: null })',
      'root = Stack([Notice("Loading", "info")])',
    ].join("\n");
    const parsed = createParser(soyuzOpenUILibrary.toJSONSchema(), "Stack").parse(program);
    const runtime = createSoyuzOpenUIRuntime("test-token", fetcher);
    runtime.setProgram(parsed);
    await vi.waitFor(() => expect(runtime.queryManager.getSnapshot().__openui_errors.length).toBeGreaterThan(0));
    expect(fetcher).not.toHaveBeenCalled();
    runtime.dispose();
  });

});

describe("vanilla OpenUI DOM renderer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("[OPENUI-RENDER-01] renders nested components with textContent and preserves stable instances on updates", () => {
    const { document, window } = parseHTML("<html><body><div id='output'></div></body></html>");
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("AbortController", window.AbortController);
    const container = document.querySelector<HTMLElement>("#output")!;
    const runtime = createSoyuzOpenUIRuntime("test-token", vi.fn() as typeof fetch);
    const renderer = new OpenUIDOMRenderer(container, soyuzOpenUILibrary, soyuzComponentRenderers, { maxDepth: 8, maxComponents: 100 });
    const first = createParser(soyuzOpenUILibrary.toJSONSchema(), "Stack").parse(
      'root = Stack([Heading("Safe heading"), Stack([Text("<img src=x onerror=alert(1)>")])])',
    );
    runtime.setProgram(first);
    renderer.render(runtime.getRoot()!, { store: runtime.store, queryManager: runtime.queryManager, dispatchAction: () => undefined });
    expect(container.querySelector("h2")?.textContent).toBe("Safe heading");
    expect(container.querySelector("img")).toBeNull();
    const text = container.querySelector(".openui-text");
    expect(text?.textContent).toBe("<img src=x onerror=alert(1)>");

    const updated = createParser(soyuzOpenUILibrary.toJSONSchema(), "Stack").parse(
      'root = Stack([Heading("Updated heading"), Stack([Text("Updated text")])])',
    );
    const heading = container.querySelector("h2");
    runtime.setProgram(updated);
    renderer.render(runtime.getRoot()!, { store: runtime.store, queryManager: runtime.queryManager, dispatchAction: () => undefined });
    expect(container.querySelector("h2")).toBe(heading);
    expect(container.querySelector("h2")?.textContent).toBe("Updated heading");
    renderer.dispose();
    runtime.dispose();
  });

  it("[OPENUI-RENDER-01] shows a safe fallback for unsupported nodes and disposes action listeners when removed", () => {
    const { document, window } = parseHTML("<html><body><div id='output'></div></body></html>");
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("AbortController", window.AbortController);
    const container = document.querySelector<HTMLElement>("#output")!;
    const runtime = createSoyuzOpenUIRuntime("test-token", vi.fn() as typeof fetch);
    const dispatch = vi.fn();
    const abortListenerScope = vi.spyOn(window.AbortController.prototype, "abort");
    const renderer = new OpenUIDOMRenderer(container, soyuzOpenUILibrary, soyuzComponentRenderers, { maxDepth: 8, maxComponents: 100 });
    renderer.render({ type: "element", typeName: "Unknown", props: {}, partial: false }, { store: runtime.store, queryManager: runtime.queryManager, dispatchAction: dispatch });
    expect(container.querySelector(".openui-fallback")?.textContent).toContain("Unsupported component");

    const parser = createParser(soyuzOpenUILibrary.toJSONSchema(), "Stack");
    const withButton = parser.parse('root = Stack([ActionButton("Refresh", [{ type: "refresh_runs", params: {} }])])');
    runtime.setProgram(withButton);
    renderer.render(runtime.getRoot()!, { store: runtime.store, queryManager: runtime.queryManager, dispatchAction: dispatch });
    const button = container.querySelector("button");
    button?.dispatchEvent(new window.Event("click"));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const empty = parser.parse("root = Stack([])");
    runtime.setProgram(empty);
    renderer.render(runtime.getRoot()!, { store: runtime.store, queryManager: runtime.queryManager, dispatchAction: dispatch });
    expect(button?.isConnected).toBe(false);
    expect(abortListenerScope).toHaveBeenCalled();
    renderer.dispose();
    runtime.dispose();
  });

  it("[OPENUI-RENDER-01] enforces the rendering depth limit and exposes accessible interactive controls", () => {
    const { document, window } = parseHTML("<html><body><div id='output'></div></body></html>");
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("AbortController", window.AbortController);
    const container = document.querySelector<HTMLElement>("#output")!;
    const runtime = createSoyuzOpenUIRuntime("test-token", vi.fn() as typeof fetch);
    const renderer = new OpenUIDOMRenderer(container, soyuzOpenUILibrary, soyuzComponentRenderers, { maxDepth: 3, maxComponents: 10 });
    const source = `root = ${"Stack([".repeat(6)}Heading("Too deep")${"])".repeat(6)}`;
    const parsed = createParser(soyuzOpenUILibrary.toJSONSchema(), "Stack").parse(source);
    runtime.setProgram(parsed);
    renderer.render(runtime.getRoot()!, { store: runtime.store, queryManager: runtime.queryManager, dispatchAction: () => undefined });
    expect(container.querySelector(".openui-fallback")?.textContent).toContain("Rendering limit reached");

    renderer.dispose();
    const accessibleRenderer = new OpenUIDOMRenderer(container, soyuzOpenUILibrary, soyuzComponentRenderers, { maxDepth: 8, maxComponents: 100 });
    const accessible = createParser(soyuzOpenUILibrary.toJSONSchema(), "Stack").parse(
      'root = Stack([RunTable([], "Recent runs")])',
    );
    runtime.setProgram(accessible);
    accessibleRenderer.render(runtime.getRoot()!, { store: runtime.store, queryManager: runtime.queryManager, dispatchAction: () => undefined });
    expect(container.querySelector("table")?.getAttribute("aria-label")).toBe("Recent runs");
    expect(container.querySelector("th")?.getAttribute("scope")).toBe("col");
    expect(container.querySelector("select")?.getAttribute("aria-label")).toBe("Filter runs by status");
    const select = container.querySelector("select");
    if (select) Object.defineProperty(select, "value", { configurable: true, value: "failed" });
    select?.dispatchEvent(new window.Event("change"));
    expect(runtime.store.get("$runStatus")).toBe("failed");
    container.querySelector("th button")?.dispatchEvent(new window.Event("click"));
    expect(runtime.store.get("$runSort")).toBe("displayId");
    accessibleRenderer.dispose();
    runtime.dispose();
  });
});

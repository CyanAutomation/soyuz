import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { A2UI_CATALOG_ID } from "../a2ui/protocol";
import { A2uiDomRenderer } from "../dashboard/analysis/a2ui-renderer";

describe("A2UI analysis DOM renderer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders validated A2UI bindings as text, expands host-owned list data, and dispatches fixed actions", () => {
    const { document } = parseHTML("<html><body><section id='output'></section></body></html>");
    vi.stubGlobal("document", document);
    const target = document.querySelector("#output") as HTMLElement;
    const onAction = vi.fn();
    const renderer = new A2uiDomRenderer(target, onAction);
    renderer.render([{
      version: "1.0",
      createSurface: {
        surfaceId: "analysis-renderer",
        catalogId: A2UI_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["heading", "runs"] },
          { id: "heading", component: "Text", text: "<img src=x>Recent runs" },
          { id: "runs", component: "List", children: { path: "/runs", componentId: "runCard" } },
          { id: "runCard", component: "Card", child: "runRow" },
          { id: "runRow", component: "Row", children: ["runName", "select"] },
          { id: "runName", component: "Text", text: { "@path": "displayId" } },
          { id: "selectLabel", component: "Text", text: "Inspect" },
          { id: "select", component: "Button", child: "selectLabel", action: { event: { name: "select_run", context: { runId: { "@path": "runId" } } } } },
        ],
      },
    }], {
      runs: [{ runId: "123e4567-e89b-12d3-a456-426614174000", displayId: "run-42" }],
    });

    expect(target.textContent).toContain("<img src=x>Recent runs");
    expect(target.querySelector("img")).toBeNull();
    expect(target.textContent).toContain("run-42");
    (target.querySelector("button") as HTMLButtonElement).click();
    expect(onAction).toHaveBeenCalledWith({
      name: "select_run",
      context: { runId: "123e4567-e89b-12d3-a456-426614174000" },
    });
    renderer.dispose();
  });

  it("refuses malformed protocol messages", () => {
    const { document } = parseHTML("<html><body><section id='output'></section></body></html>");
    vi.stubGlobal("document", document);
    const renderer = new A2uiDomRenderer(document.querySelector("#output") as HTMLElement, vi.fn());
    expect(() => renderer.render([{ version: "0.9", createSurface: {} }], {})).toThrow();
    renderer.dispose();
  });

  it("keeps generated event lists inside a closed native disclosure", () => {
    const { document } = parseHTML("<html><body><section id='output'></section></body></html>");
    vi.stubGlobal("document", document);
    const target = document.querySelector("#output") as HTMLElement;
    const renderer = new A2uiDomRenderer(target, vi.fn());
    renderer.render([{
      version: "1.0",
      createSurface: {
        surfaceId: "analysis-events",
        catalogId: A2UI_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["events"] },
          { id: "events", component: "List", children: { path: "/events", componentId: "eventText" } },
          { id: "eventText", component: "Text", text: { "@path": "type" } },
        ],
      },
    }], { events: [{ type: "run.completed" }] });

    const disclosure = target.querySelector("details");
    const list = disclosure?.querySelector(".a2ui-list");
    expect(disclosure?.hasAttribute("open")).toBe(false);
    expect(disclosure?.textContent).toContain("Recorded event history");
    expect(disclosure?.textContent).toContain("run.completed");
    expect(list?.children.length).toBe(1);
    expect(list?.textContent).toContain("run.completed");
    renderer.dispose();
  });
});

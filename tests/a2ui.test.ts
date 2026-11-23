import { describe, expect, it } from "vitest";
import { A2UI_CATALOG_ID, A2uiStreamValidator, validateA2uiMessages } from "../a2ui/protocol";

const surfaceId = "analysis-123";

function validMessages() {
  return [{
    version: "1.0",
    createSurface: {
      surfaceId,
      catalogId: A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "Column", children: ["heading", "runs"] },
        { id: "heading", component: "Text", text: "Recent runs" },
        { id: "runs", component: "List", children: { path: "/runs", componentId: "runCard" } },
        { id: "runCard", component: "Card", child: "runContent" },
        { id: "runContent", component: "Column", children: ["runId", "selectLabel", "select"] },
        { id: "runId", component: "Text", text: { "@path": "displayId" } },
        { id: "selectLabel", component: "Text", text: "Inspect run" },
        {
          id: "select",
          component: "Button",
          child: "selectLabel",
          action: { event: { name: "select_run", context: { runId: { "@path": "runId" } } } },
        },
      ],
    },
  }];
}

describe("Soyuz A2UI protocol boundary", () => {
  it("accepts a complete A2UI v1.0 surface using the fixed catalog and host-owned data bindings", () => {
    const result = validateA2uiMessages(validMessages(), { expectedSurfaceId: surfaceId });
    expect(result.ok).toBe(true);
    expect(result.surfaceId).toBe(surfaceId);
    expect(result.componentCount).toBe(8);
  });

  it.each([
    ["a mismatched protocol version", (messages: any[]) => { messages[0].version = "0.9"; }],
    ["an unregistered catalog", (messages: any[]) => { messages[0].createSurface.catalogId = "https://evil.example/catalog.json"; }],
    ["model-supplied application data", (messages: any[]) => { messages[0].createSurface.dataModel = { runs: [{ runId: "fabricated" }] }; }],
    ["a non-allowlisted component", (messages: any[]) => { messages[0].createSurface.components[1].component = "Image"; }],
    ["a function call", (messages: any[]) => { messages[0].createSurface.components[1].text = { "@call": "fetch" }; }],
    ["an unsupported action", (messages: any[]) => { messages[0].createSurface.components[7].action.event.name = "cancel_run"; }],
    ["an unexpected surface", (messages: any[]) => { messages[0].createSurface.surfaceId = "another-surface"; }],
  ])("rejects %s", (_description, mutate) => {
    const messages = validMessages() as any[];
    mutate(messages);
    expect(validateA2uiMessages(messages, { expectedSurfaceId: surfaceId }).ok).toBe(false);
  });

  it("rejects protocol messages that would let the model write the renderer's data model", () => {
    const messages = validMessages();
    const update = { version: "1.0", updateDataModel: { surfaceId, path: "/runs", value: [] } };
    expect(validateA2uiMessages([...messages, update], { expectedSurfaceId: surfaceId }).ok).toBe(false);
  });

  it("rejects navigation to an unapproved dashboard route", () => {
    const messages = validMessages() as any[];
    messages[0].createSurface.components[7].action.event.name = "navigate_dashboard";
    messages[0].createSurface.components[7].action.event.context = { path: "/dashboard/analysis/" };
    expect(validateA2uiMessages(messages, { expectedSurfaceId: surfaceId }).ok).toBe(false);
  });

  it("rejects a cyclic or over-limit component graph", () => {
    const cyclic = validMessages() as any[];
    cyclic[0].createSurface.components[0].children = ["root"];
    expect(validateA2uiMessages(cyclic, { expectedSurfaceId: surfaceId }).ok).toBe(false);

    const tooMany = validMessages() as any[];
    tooMany[0].createSurface.components = Array.from({ length: 101 }, (_, index) => ({
      id: index === 0 ? "root" : `text${index}`,
      component: index === 0 ? "Column" : "Text",
      ...(index === 0 ? { children: Array.from({ length: 100 }, (_unused, child) => `text-${child + 1}`) } : { text: "x" }),
    }));
    expect(validateA2uiMessages(tooMany, { expectedSurfaceId: surfaceId }).ok).toBe(false);
  });

  it("requires a single connected root and rejects malformed streamed JSONL", () => {
    const disconnected = validMessages() as any[];
    disconnected[0].createSurface.components.push({ id: "orphan", component: "Text", text: "orphan" });
    expect(validateA2uiMessages(disconnected, { expectedSurfaceId: surfaceId }).ok).toBe(false);

    const stream = new A2uiStreamValidator({ expectedSurfaceId: surfaceId });
    expect(() => stream.pushLine("not json")).toThrow();
    stream.dispose();
  });

  it("allows only fixed renderer actions", () => {
    const allowed = validateA2uiMessages(validMessages(), { expectedSurfaceId: surfaceId });
    expect(allowed.ok).toBe(true);
  });
});

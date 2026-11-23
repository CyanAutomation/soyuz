import { DataModel, type SurfaceModel } from "@a2ui/web_core/state";
import { MessageProcessor } from "@a2ui/web_core/processing";
import { STRICT_VALIDATION } from "@a2ui/web_core/validating";
import { basicCatalog } from "../a2ui/catalog";
import { validateA2uiMessages } from "../a2ui/protocol";

export interface DashboardA2uiAction {
  name: "select_run" | "refresh_runs" | "reset_filters";
  context: Record<string, unknown>;
}

type Component = {
  id: string;
  type: string;
  properties: Record<string, unknown>;
};

/** Small native DOM renderer for Soyuz's approved A2UI Basic Catalog subset. */
export class A2uiDomRenderer {
  private processor: MessageProcessor | null = null;
  private readonly document: Document;

  constructor(
    private readonly target: HTMLElement,
    private readonly onAction: (action: DashboardA2uiAction) => void,
  ) {
    this.document = target.ownerDocument;
  }

  render(messages: unknown[], hostData: Record<string, unknown> = {}): void {
    const validation = validateA2uiMessages(messages);
    if (!validation.ok || !validation.surfaceId) throw new Error(validation.reason ?? "A2UI message stream is invalid.");

    this.processor?.dispose();
    const processor = new MessageProcessor([basicCatalog as never], undefined, {
      version: "1.0",
      validationConfig: STRICT_VALIDATION,
    });
    processor.processMessages(messages as never[]);
    const surface = processor.getSurface(validation.surfaceId);
    if (!surface) {
      processor.dispose();
      throw new Error("A2UI surface could not be created.");
    }
    surface.dataModel.set("/", hostData);
    const root = this.renderComponent(surface, "root", "", new Set());
    this.target.replaceChildren(root);
    this.processor = processor;
  }

  clear(): void {
    this.target.replaceChildren();
    this.processor?.dispose();
    this.processor = null;
  }

  dispose(): void {
    this.clear();
  }

  private renderComponent(
    surface: SurfaceModel,
    componentId: string,
    contextPath: string,
    ancestry: Set<string>,
  ): HTMLElement {
    if (ancestry.has(componentId)) throw new Error("A2UI component cycle detected.");
    const component = surface.componentsModel.get(componentId) as Component | undefined;
    if (!component) throw new Error("A2UI component reference is missing.");
    const nextAncestry = new Set(ancestry).add(componentId);
    switch (component.type) {
      case "Column":
      case "Row": return this.renderLayout(surface, component, contextPath, nextAncestry);
      case "List": return this.renderListComponent(surface, component, contextPath, nextAncestry);
      case "Card": return this.renderCard(surface, component, contextPath, nextAncestry);
      case "Text": return this.renderText(surface, component, contextPath);
      case "Button": return this.renderButton(surface, component, contextPath);
      case "Divider": return this.renderDivider();
      default:
        throw new Error("A2UI component is outside the renderer's approved subset.");
    }
  }

  private renderLayout(surface: SurfaceModel, component: Component, contextPath: string, ancestry: Set<string>): HTMLElement {
    const node = this.document.createElement("div");
    node.className = `a2ui-layout a2ui-layout--${component.type.toLowerCase()}`;
    this.renderChildren(node, surface, component.properties.children, contextPath, ancestry);
    return node;
  }

  private renderListComponent(surface: SurfaceModel, component: Component, contextPath: string, ancestry: Set<string>): HTMLElement {
    const children = component.properties.children;
    const list = this.document.createElement("div");
    list.className = "a2ui-list";
    this.renderChildren(list, surface, children, contextPath, ancestry);
    if (!isRecord(children) || typeof children.path !== "string"
      || DataModel.resolvePath(children.path, contextPath) !== "/events") return list;

    const disclosure = this.document.createElement("details");
    disclosure.className = "a2ui-event-list card card--padded";
    const summary = this.document.createElement("summary");
    summary.textContent = "Recorded event history";
    disclosure.appendChild(summary);
    disclosure.appendChild(list);
    return disclosure;
  }

  private renderChildren(
    target: HTMLElement,
    surface: SurfaceModel,
    children: unknown,
    contextPath: string,
    ancestry: Set<string>,
  ): void {
    if (Array.isArray(children)) {
      for (const childId of children) {
        if (typeof childId === "string") target.appendChild(this.renderComponent(surface, childId, contextPath, ancestry));
      }
      return;
    }
    if (isRecord(children) && typeof children.path === "string" && typeof children.componentId === "string") {
      this.renderList(target, surface, children.path, children.componentId, contextPath, ancestry);
    }
  }

  private renderCard(surface: SurfaceModel, component: Component, contextPath: string, ancestry: Set<string>): HTMLElement {
    const node = this.document.createElement("article");
    node.className = "card card--padded a2ui-card";
    const child = component.properties.child;
    if (typeof child === "string") node.appendChild(this.renderComponent(surface, child, contextPath, ancestry));
    return node;
  }

  private renderText(surface: SurfaceModel, component: Component, contextPath: string): HTMLElement {
    const node = this.document.createElement("p");
    node.className = `a2ui-text${component.properties.variant === "caption" ? " a2ui-text--caption" : ""}`;
    node.textContent = toDisplayText(this.resolveValue(surface, component.properties.text, contextPath)).slice(0, 2_000);
    return node;
  }

  private renderButton(surface: SurfaceModel, component: Component, contextPath: string): HTMLButtonElement {
    const node = this.document.createElement("button");
    node.className = `button ${component.properties.variant === "primary" ? "button--primary" : "button--secondary"}`;
    node.type = "button";
    const child = component.properties.child;
    if (typeof child === "string") node.textContent = this.buttonLabel(surface, child, contextPath);
    this.bindButtonAction(node, surface, component.properties.action, contextPath);
    return node;
  }

  private buttonLabel(surface: SurfaceModel, componentId: string, contextPath: string): string {
    const label = surface.componentsModel.get(componentId);
    if (!label || label.type !== "Text") throw new Error("A2UI Button labels must use Text components.");
    return toDisplayText(this.resolveValue(surface, label.properties.text, contextPath)).slice(0, 160);
  }

  private bindButtonAction(button: HTMLButtonElement, surface: SurfaceModel, value: unknown, contextPath: string): void {
    if (!isRecord(value) || !isRecord(value.event) || typeof value.event.name !== "string") return;
    const event = value.event;
    button.addEventListener("click", () => {
      this.onAction({
        name: event.name as DashboardA2uiAction["name"],
        context: this.resolveActionContext(surface, event.context, contextPath),
      });
    });
  }

  private resolveActionContext(surface: SurfaceModel, value: unknown, contextPath: string): Record<string, unknown> {
    if (!isRecord(value)) return {};
    const context: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) context[key] = this.resolveValue(surface, item, contextPath);
    return context;
  }

  private renderDivider(): HTMLElement {
    const node = this.document.createElement("hr");
    node.className = "a2ui-divider";
    return node;
  }

  private renderList(
    target: HTMLElement,
    surface: SurfaceModel,
    relativePath: string,
    componentId: string,
    contextPath: string,
    ancestry: Set<string>,
  ): void {
    const path = DataModel.resolvePath(relativePath, contextPath);
    const items: unknown = surface.dataModel.get(path);
    if (!Array.isArray(items)) return;
    for (let index = 0; index < Math.min(items.length, 30); index += 1) {
      const itemContext = DataModel.resolvePath(String(index), path);
      target.appendChild(this.renderComponent(surface, componentId, itemContext, ancestry));
    }
  }

  private resolveValue(
    surface: SurfaceModel,
    value: unknown,
    contextPath: string,
  ): unknown {
    if (!isRecord(value)) return value;
    const binding = typeof value["@path"] === "string" ? value["@path"] : value.path;
    if (typeof binding !== "string") return "";
    try {
      return surface.dataModel.get(DataModel.resolvePath(binding, contextPath));
    } catch {
      return "";
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toDisplayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

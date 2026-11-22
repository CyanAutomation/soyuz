import { DataModel, type SurfaceModel } from "@a2ui/web_core/state";
import { MessageProcessor } from "@a2ui/web_core/processing";
import { STRICT_VALIDATION } from "@a2ui/web_core/validating";
import { basicCatalog } from "../../a2ui/catalog";
import { A2uiStreamValidator, validateA2uiMessages } from "../../a2ui/protocol";

export interface AnalysisAction {
  name: "select_run" | "refresh_runs" | "reset_filters" | "navigate_dashboard";
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
    private readonly onAction: (action: AnalysisAction) => void,
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
    const props = component.properties;

    switch (component.type) {
      case "Column":
      case "Row": {
        const node = this.document.createElement("div");
        node.className = `a2ui-layout a2ui-layout--${component.type.toLowerCase()}`;
        const children = props.children;
        if (Array.isArray(children)) {
          for (const childId of children) {
            if (typeof childId === "string") node.appendChild(this.renderComponent(surface, childId, contextPath, nextAncestry));
          }
        } else if (isRecord(children) && typeof children.path === "string" && typeof children.componentId === "string") {
          this.renderList(node, surface, children.path, children.componentId, contextPath, nextAncestry);
        }
        return node;
      }
      case "List": {
        const children = props.children;
        let node: HTMLElement = this.document.createElement("div");
        node.className = "a2ui-list";
        if (isRecord(children) && typeof children.path === "string"
          && DataModel.resolvePath(children.path, contextPath) === "/events") {
          const disclosure = this.document.createElement("details");
          disclosure.className = "a2ui-event-list card card--padded";
          const summary = this.document.createElement("summary");
          summary.textContent = "Recorded event history";
          disclosure.appendChild(summary);
          disclosure.appendChild(node);
          node = disclosure;
        }
        if (Array.isArray(children)) {
          for (const childId of children) {
            if (typeof childId === "string") node.appendChild(this.renderComponent(surface, childId, contextPath, nextAncestry));
          }
        } else if (isRecord(children) && typeof children.path === "string" && typeof children.componentId === "string") {
          this.renderList(node, surface, children.path, children.componentId, contextPath, nextAncestry);
        }
        return node;
      }
      case "Card": {
        const node = this.document.createElement("article");
        node.className = "card card--padded a2ui-card";
        if (typeof props.child === "string") node.appendChild(this.renderComponent(surface, props.child, contextPath, nextAncestry));
        return node;
      }
      case "Text": {
        const node = this.document.createElement("p");
        node.className = `a2ui-text${props.variant === "caption" ? " a2ui-text--caption" : ""}`;
        const value = this.resolveValue(surface, props.text, contextPath);
        node.textContent = toDisplayText(value).slice(0, 2_000);
        return node;
      }
      case "Button": {
        const node = this.document.createElement("button");
        node.className = `button ${props.variant === "primary" ? "button--primary" : "button--secondary"}`;
        node.type = "button";
        if (typeof props.child === "string") {
          const label = surface.componentsModel.get(props.child);
          if (!label || label.type !== "Text") throw new Error("A2UI Button labels must use Text components.");
          node.textContent = toDisplayText(this.resolveValue(surface, label.properties.text, contextPath)).slice(0, 160);
        }
        const action = props.action;
        if (isRecord(action) && isRecord(action.event) && typeof action.event.name === "string") {
          node.addEventListener("click", () => {
            const context: Record<string, unknown> = {};
            if (isRecord(action.event.context)) {
              for (const [key, value] of Object.entries(action.event.context)) {
                context[key] = this.resolveValue(surface, value, contextPath);
              }
            }
            this.onAction({ name: action.event.name as AnalysisAction["name"], context });
          });
        }
        return node;
      }
      case "Divider": {
        const node = this.document.createElement("hr");
        node.className = "a2ui-divider";
        return node;
      }
      default:
        throw new Error("A2UI component is outside the renderer's approved subset.");
    }
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

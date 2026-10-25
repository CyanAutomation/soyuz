import type { ElementNode, QueryManager, Store } from "@openuidev/lang-core";
import type { Library } from "@openuidev/lang-core";

export interface OpenUIAction {
  type: string;
  params?: Record<string, unknown>;
}

export interface NativeRenderContext {
  store: Store;
  queryManager: QueryManager;
  dispatchAction(action: OpenUIAction): void;
  renderChildren(parent: HTMLElement, nodes: unknown[], parentKey: string): void;
  bindEvents(element: HTMLElement): AbortSignal;
  disposeElementTree(element: HTMLElement): void;
}

export type NativeComponentRenderer = (
  existing: HTMLElement | null,
  node: ElementNode,
  props: Record<string, unknown>,
  context: NativeRenderContext,
) => HTMLElement;

export class OpenUIDOMRenderer {
  private readonly controllers = new WeakMap<HTMLElement, AbortController>();
  private renderedCount = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly library: Library,
    private readonly renderers: Record<string, NativeComponentRenderer>,
    private readonly limits: { maxDepth: number; maxComponents: number },
  ) {}

  render(
    root: ElementNode,
    runtime: Pick<NativeRenderContext, "store" | "queryManager" | "dispatchAction">,
  ): void {
    this.renderedCount = 0;
    this.reconcile(this.container, [root], "view", 0, runtime);
  }

  clear(): void {
    for (const child of Array.from(this.container.children)) this.disposeTree(child as HTMLElement);
    this.container.replaceChildren();
  }

  dispose(): void {
    this.clear();
  }

  private reconcile(
    parent: HTMLElement,
    nodes: unknown[],
    parentKey: string,
    depth: number,
    runtime: Pick<NativeRenderContext, "store" | "queryManager" | "dispatchAction">,
  ): void {
    const existingByKey = new Map<string, HTMLElement>();
    for (const child of Array.from(parent.children)) {
      const element = child as HTMLElement;
      const key = element.dataset.openuiKey;
      if (key) existingByKey.set(key, element);
    }

    const next: HTMLElement[] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const key = isElementNode(node) && isStableStatementId(node.statementId)
        ? `statement:${node.statementId}`
        : `${parentKey}:${index}:${isElementNode(node) ? node.typeName : "invalid"}`;
      const prior = existingByKey.get(key) ?? null;
      existingByKey.delete(key);
      next.push(this.renderNode(node, key, prior, depth + 1, runtime));
    }

    for (const element of existingByKey.values()) this.disposeTree(element);
    for (let index = 0; index < next.length; index += 1) {
      const element = next[index];
      const atPosition = parent.children.item(index);
      if (atPosition !== element) parent.insertBefore(element, atPosition);
    }
    while (parent.children.length > next.length) {
      const element = parent.lastElementChild as HTMLElement | null;
      if (!element) break;
      this.disposeTree(element);
      element.remove();
    }
  }

  private renderNode(
    value: unknown,
    key: string,
    existing: HTMLElement | null,
    depth: number,
    runtime: Pick<NativeRenderContext, "store" | "queryManager" | "dispatchAction">,
  ): HTMLElement {
    this.renderedCount += 1;
    if (this.renderedCount > this.limits.maxComponents || depth > this.limits.maxDepth) {
      return this.fallback(key, "Rendering limit reached.", existing);
    }
    if (!isElementNode(value)) return this.fallback(key, "An unsupported OpenUI node was skipped.", existing);

    const spec = this.library.components[value.typeName];
    const renderer = this.renderers[value.typeName];
    if (!spec || !renderer) return this.fallback(key, `Unsupported component: ${value.typeName.slice(0, 80)}.`, existing);
    if (value.partial) return this.fallback(key, "This component is still being generated.", existing);

    const safeProps = materializeChildProps(value.props);
    const validation = spec.props.safeParse(safeProps);
    if (!validation.success) return this.fallback(key, "A generated component had invalid properties.", existing);

    const element = existing?.dataset.openuiType === value.typeName ? existing : null;
    if (existing && existing !== element) {
      this.disposeTree(existing);
      existing.remove();
    }
    const props = { ...(validation.data as Record<string, unknown>) };
    // Child component nodes are preserved so the adapter can reconcile them by stable IDs.
    if (Array.isArray(value.props.children)) props.children = value.props.children;
    const context: NativeRenderContext = {
      ...runtime,
      renderChildren: (parent, children, parentKey) =>
        this.reconcile(parent, children, parentKey, depth, runtime),
      bindEvents: (target) => {
        this.controllers.get(target)?.abort();
        const controller = new AbortController();
        this.controllers.set(target, controller);
        return controller.signal;
      },
      disposeElementTree: (target) => this.disposeTree(target),
    };

    try {
      const rendered = renderer(element, value, props, context);
      rendered.dataset.openuiKey = key;
      rendered.dataset.openuiType = value.typeName;
      return rendered;
    } catch {
      return this.fallback(key, "This component could not be rendered.", element);
    }
  }

  private fallback(key: string, message: string, existing: HTMLElement | null): HTMLElement {
    const fallback = existing?.tagName === "P" && existing.classList.contains("openui-fallback")
      ? existing
      : document.createElement("p");
    fallback.className = "openui-fallback notice notice--warning";
    fallback.setAttribute("role", "status");
    fallback.textContent = message;
    fallback.dataset.openuiKey = key;
    fallback.dataset.openuiType = "fallback";
    return fallback;
  }

  private disposeTree(element: HTMLElement): void {
    this.controllers.get(element)?.abort();
    for (const child of Array.from(element.children)) this.disposeTree(child as HTMLElement);
  }
}

export function isElementNode(value: unknown): value is ElementNode {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ElementNode>;
  return candidate.type === "element"
    && typeof candidate.typeName === "string"
    && candidate.props !== null
    && typeof candidate.props === "object"
    && !Array.isArray(candidate.props)
    && typeof candidate.partial === "boolean";
}

function isStableStatementId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
}

function materializeChildProps(value: unknown, depth = 0): unknown {
  if (depth > 32) return null;
  if (isElementNode(value)) return materializeChildProps(value.props, depth + 1);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => materializeChildProps(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    output[key] = materializeChildProps(child, depth + 1);
  }
  return output;
}

import { A2UI_CATALOG_ID, type A2uiActionName } from "./protocol.js";

export interface A2uiComponentDefinition {
  id: string;
  component: "Column" | "Row" | "Card" | "Text" | "Button" | "Divider" | "List";
  [property: string]: unknown;
}

export type A2uiBinding = { "@path": string };
export type A2uiTextValue = string | number | boolean | A2uiBinding;

/** Reusable application-owned A2UI v1.0 component primitives. */
export const a2uiText = (id: string, text: A2uiTextValue): A2uiComponentDefinition => ({
  id, component: "Text", text,
});

export const a2uiColumn = (id: string, children: string[]): A2uiComponentDefinition => ({
  id, component: "Column", children,
});

export const a2uiRow = (id: string, children: string[]): A2uiComponentDefinition => ({
  id, component: "Row", children,
});

export const a2uiCard = (id: string, child: string): A2uiComponentDefinition => ({
  id, component: "Card", child,
});

export const a2uiList = (id: string, path: string, componentId: string): A2uiComponentDefinition => ({
  id, component: "List", children: { path, componentId },
});

export function a2uiButton(
  id: string,
  child: string,
  name: A2uiActionName,
  context?: Record<string, unknown>,
): A2uiComponentDefinition {
  return {
    id,
    component: "Button",
    child,
    action: { event: { name, ...(context ? { context } : {}) } },
  };
}

export function createFixedA2uiSurface(surfaceId: string, components: A2uiComponentDefinition[]): unknown[] {
  return [{
    version: "1.0",
    createSurface: { surfaceId, catalogId: A2UI_CATALOG_ID, components },
  }];
}

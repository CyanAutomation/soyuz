import { MessageProcessor } from "@a2ui/web_core/processing";
import { STRICT_VALIDATION } from "@a2ui/web_core/validating";
import { A2UI_CATALOG_ID, basicCatalog } from "./catalog";

export { A2UI_CATALOG_ID };
const A2UI_MAX_MESSAGE_CHARS = 32_000;
const A2UI_MAX_STREAM_CHARS = 64_000;
const A2UI_MAX_COMPONENTS = 100;
const A2UI_MAX_DEPTH = 8;
const A2UI_MAX_MESSAGES = 100;

const ALLOWED_COMPONENTS = new Set(["Column", "Row", "Card", "Text", "Button", "Divider", "List"]);
const ALLOWED_ACTIONS = new Set(["select_run", "refresh_runs", "reset_filters"]);
const ALLOWED_DATA_ROOTS = new Set([
  "runs",
  "statusCounts",
  "selectedRun",
  "selectedRunId",
  "events",
  "artifacts",
  "ops",
]);

export interface A2uiValidationResult {
  ok: boolean;
  reason?: string;
  surfaceId?: string;
  componentCount?: number;
  messages?: unknown[];
}

export interface A2uiValidationOptions {
  expectedSurfaceId?: string;
}

/** Validates the deliberately narrow A2UI v1.0 subset accepted by Soyuz. */
export function validateA2uiMessages(messages: unknown[], options: A2uiValidationOptions = {}): A2uiValidationResult {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > A2UI_MAX_MESSAGES) {
    return { ok: false, reason: "The A2UI message stream is empty or too large." };
  }

  const validator = new A2uiStreamValidator(options);
  try {
    for (const message of messages) validator.pushMessage(message);
    const result = validator.finish();
    return { ...result, messages: validator.messages };
  } catch {
    return { ok: false, reason: "The A2UI message stream is invalid." };
  } finally {
    validator.dispose();
  }
}

export class A2uiStreamValidator {
  private readonly processor = new MessageProcessor([basicCatalog as never], undefined, {
    version: "1.0",
    validationConfig: STRICT_VALIDATION,
  });
  private readonly componentIds = new Set<string>();
  private readonly accepted: unknown[] = [];
  private currentSurfaceId: string | null = null;
  private totalChars = 0;
  private finished = false;

  constructor(private readonly options: A2uiValidationOptions = {}) {}

  get messages(): unknown[] {
    return [...this.accepted];
  }

  pushLine(line: string): unknown {
    if (this.finished) throw new Error("The A2UI message stream is already complete.");
    if (line.length === 0 || line.length > A2UI_MAX_MESSAGE_CHARS) throw new Error("A2UI message is outside supported limits.");

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("A2UI message is not valid JSON.");
    }
    return this.pushMessage(value);
  }

  pushMessage(value: unknown): unknown {
    if (this.finished || this.accepted.length >= A2UI_MAX_MESSAGES) throw new Error("The A2UI stream is outside supported limits.");
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || serialized.length > A2UI_MAX_MESSAGE_CHARS) throw new Error("A2UI message is outside supported limits.");
    this.totalChars += serialized.length;
    if (this.totalChars > A2UI_MAX_STREAM_CHARS) throw new Error("The A2UI stream is outside supported limits.");
    const { message, operation } = readOperation(value);
    this.inspectOperation(operation, message);
    this.processWithCatalog(value);
    this.accepted.push(value);
    return value;
  }

  finish(): A2uiValidationResult {
    if (this.finished) throw new Error("The A2UI stream is already complete.");
    this.finished = true;
    if (!this.currentSurfaceId || this.processor.getSurfaces().size !== 1) throw new Error("A2UI stream must contain one surface.");
    const surface = this.processor.getSurface(this.currentSurfaceId);
    if (!surface || surface.componentsModel.size === 0) throw new Error("A2UI surface has no components.");
    surface.componentsModel.validateTopology({ rootId: "root", maxDepth: A2UI_MAX_DEPTH });
    return { ok: true, surfaceId: this.currentSurfaceId, componentCount: surface.componentsModel.size };
  }

  dispose(): void {
    this.processor.dispose();
  }

  private inspectComponents(raw: unknown): void {
    if (!Array.isArray(raw)) throw new Error("A2UI components must be an array.");
    for (const component of raw) this.inspectComponent(component);
  }

  private inspectOperation(operation: string, message: Record<string, any>): void {
    if (operation === "createSurface") {
      this.inspectSurfaceCreation(message.createSurface as Record<string, unknown>);
      return;
    }
    if (operation === "updateComponents") {
      this.inspectComponentUpdate(message.updateComponents as Record<string, unknown>);
      return;
    }
    throw new Error("This A2UI operation is outside the read-only UI contract.");
  }

  private inspectSurfaceCreation(surface: Record<string, unknown>): void {
    if (this.accepted.length !== 0 || this.currentSurfaceId !== null) throw new Error("A2UI stream must create exactly one surface first.");
    const surfaceId = surface.surfaceId;
    if (typeof surfaceId !== "string" || (this.options.expectedSurfaceId && surfaceId !== this.options.expectedSurfaceId)) {
      throw new Error("A2UI surface identifier is unexpected.");
    }
    if (surface.catalogId !== A2UI_CATALOG_ID || surface.dataModel !== undefined || surface.sendDataModel === true) {
      throw new Error("A2UI surface configuration is not allowed.");
    }
    this.currentSurfaceId = surfaceId;
    this.inspectComponents(surface.components);
  }

  private inspectComponentUpdate(update: Record<string, unknown>): void {
    if (!this.currentSurfaceId) throw new Error("A2UI surface must be created before it can be updated.");
    if (update.surfaceId !== this.currentSurfaceId) throw new Error("A2UI update targets an unexpected surface.");
    this.inspectComponents(update.components);
  }

  private processWithCatalog(value: unknown): void {
    try {
      this.processor.processMessages(value as never);
    } catch {
      throw new Error("A2UI message does not match the official protocol or catalog schema.");
    }
  }

  private inspectComponent(component: unknown): void {
    if (!isRecord(component)) throw new Error("A2UI component is malformed.");
    if (typeof component.id !== "string" || typeof component.component !== "string" || !ALLOWED_COMPONENTS.has(component.component)) {
      throw new Error("A2UI component is not in the approved catalog subset.");
    }
    this.componentIds.add(component.id);
    if (this.componentIds.size > A2UI_MAX_COMPONENTS) throw new Error("A2UI surface has too many components.");
    inspectUntrustedFields(component);
  }
}

function readOperation(value: unknown): { message: Record<string, any>; operation: string } {
  if (!isRecord(value) || value.version !== "1.0") throw new Error("A2UI message does not match protocol v1.0.");
  const operationKeys = Object.keys(value).filter((key) => key !== "version");
  if (operationKeys.length !== 1) throw new Error("A2UI message has no unique operation.");
  return { message: value, operation: operationKeys[0]! };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspectUntrustedFields(value: unknown, parentKey = ""): void {
  if (Array.isArray(value)) {
    inspectUntrustedArray(value, parentKey);
    return;
  }
  if (!isRecord(value)) return;

  if ("@call" in value || "functionCall" in value) throw new Error("A2UI function calls are disabled.");

  if (parentKey === "action") {
    assertAllowedAction(value);
    return;
  }

  for (const [key, child] of Object.entries(value)) inspectUntrustedField(key, child);
}

function inspectUntrustedArray(values: unknown[], parentKey: string): void {
  for (const value of values) inspectUntrustedFields(value, parentKey);
}

function inspectUntrustedField(key: string, value: unknown): void {
  if (key === "action") {
    assertAllowedAction(value);
    return;
  }
  if (isDataPathField(key, value) && !isAllowedDataPath(value)) {
    throw new Error("A2UI binding points outside the dashboard data model.");
  }
  inspectUntrustedFields(value, key);
}

function isDataPathField(key: string, value: unknown): boolean {
  return key === "@path" || (key === "path" && typeof value === "string");
}

function assertAllowedAction(value: unknown): asserts value is Record<string, unknown> {
  if (!isAllowedAction(value)) throw new Error("A2UI action is not approved.");
}

function isAllowedAction(value: unknown): boolean {
  const event = readActionEvent(value);
  return Boolean(event && ALLOWED_ACTIONS.has(String(event.name)) && isAllowedActionContext(event));
}

function readActionEvent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (Object.keys(action).length !== 1 || !isRecord(action.event)) return null;
  return action.event;
}

function isAllowedActionContext(event: Record<string, unknown>): boolean {
  if (event.context === undefined) return event.name !== "select_run";
  if (!isRecord(event.context)) return false;

  switch (event.name) {
    case "select_run":
      return isSelectRunContext(event.context);
    case "refresh_runs":
    case "reset_filters":
      return Object.keys(event.context).length === 0;
    default:
      return false;
  }
}

function isSelectRunContext(context: Record<string, unknown>): boolean {
  return Object.keys(context).length === 1 && "runId" in context && isUuidOrRunBinding(context.runId);
}

function isUuidOrRunBinding(value: unknown): boolean {
  if (typeof value === "string") return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return Object.keys(binding).length === 1 && typeof binding["@path"] === "string" && isAllowedDataPath(binding["@path"]);
}

function isAllowedDataPath(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  const segments = value.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".." || ["__proto__", "prototype", "constructor"].includes(segment))) {
    return false;
  }
  if (value.startsWith("/")) return ALLOWED_DATA_ROOTS.has(segments[0]);
  return segments.every((segment) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(segment));
}

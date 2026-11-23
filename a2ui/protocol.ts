import { MessageProcessor } from "@a2ui/web_core/processing";
import { STRICT_VALIDATION } from "@a2ui/web_core/validating";
import { A2UI_CATALOG_ID, basicCatalog } from "./catalog";

export { A2UI_CATALOG_ID };
export const A2UI_MAX_MESSAGE_CHARS = 32_000;
export const A2UI_MAX_STREAM_CHARS = 64_000;
export const A2UI_MAX_COMPONENTS = 100;
export const A2UI_MAX_DEPTH = 8;
export const A2UI_MAX_MESSAGES = 100;

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

  get surfaceId(): string | null {
    return this.currentSurfaceId;
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
    if (!isRecord(value) || value.version !== "1.0") throw new Error("A2UI message does not match protocol v1.0.");
    const operationKeys = Object.keys(value).filter((key) => key !== "version");
    if (operationKeys.length !== 1) throw new Error("A2UI message has no unique operation.");
    const messageType = operationKeys[0];
    const message = value;

    if (messageType === "createSurface") {
      if (this.accepted.length !== 0 || this.currentSurfaceId !== null) throw new Error("A2UI stream must create exactly one surface first.");
      const surface = message.createSurface as Record<string, unknown>;
      const surfaceId = surface.surfaceId;
      if (typeof surfaceId !== "string" || (this.options.expectedSurfaceId && surfaceId !== this.options.expectedSurfaceId)) {
        throw new Error("A2UI surface identifier is unexpected.");
      }
      if (surface.catalogId !== A2UI_CATALOG_ID || surface.dataModel !== undefined || surface.sendDataModel === true) {
        throw new Error("A2UI surface configuration is not allowed.");
      }
      this.currentSurfaceId = surfaceId;
      this.inspectComponents(surface.components);
    } else if (messageType === "updateComponents") {
      if (!this.currentSurfaceId) throw new Error("A2UI surface must be created before it can be updated.");
      const update = message.updateComponents as Record<string, unknown>;
      if (update.surfaceId !== this.currentSurfaceId) throw new Error("A2UI update targets an unexpected surface.");
      this.inspectComponents(update.components);
    } else {
      throw new Error("This A2UI operation is outside the read-only UI contract.");
    }

    try {
      this.processor.processMessages(value as never);
    } catch {
      throw new Error("A2UI message does not match the official protocol or catalog schema.");
    }
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
    for (const component of raw) {
      if (!component || typeof component !== "object" || Array.isArray(component)) throw new Error("A2UI component is malformed.");
      const record = component as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.component !== "string" || !ALLOWED_COMPONENTS.has(record.component)) {
        throw new Error("A2UI component is not in the approved catalog subset.");
      }
      this.componentIds.add(record.id);
      if (this.componentIds.size > A2UI_MAX_COMPONENTS) throw new Error("A2UI surface has too many components.");
      inspectUntrustedFields(record);
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspectUntrustedFields(value: unknown, parentKey = ""): void {
  if (Array.isArray(value)) {
    for (const item of value) inspectUntrustedFields(item, parentKey);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if ("@call" in record || "functionCall" in record) throw new Error("A2UI function calls are disabled.");

  if (parentKey === "action") {
    if (!isAllowedAction(record)) throw new Error("A2UI action is not approved.");
    return;
  }

  for (const [key, child] of Object.entries(record)) {
    if (key === "action") {
      if (!isAllowedAction(child)) throw new Error("A2UI action is not approved.");
      continue;
    }
    if ((key === "@path" || (key === "path" && typeof child === "string")) && !isAllowedDataPath(child)) {
      throw new Error("A2UI binding points outside the dashboard data model.");
    }
    inspectUntrustedFields(child, key);
  }
}

function isAllowedAction(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (Object.keys(action).length !== 1 || !action.event || typeof action.event !== "object" || Array.isArray(action.event)) return false;
  const event = action.event as Record<string, unknown>;
  if (!ALLOWED_ACTIONS.has(String(event.name))) return false;
  const context = event.context;
  if (context === undefined) return event.name !== "select_run";
  if (!context || typeof context !== "object" || Array.isArray(context)) return false;
  const fields = context as Record<string, unknown>;

  switch (event.name) {
    case "select_run":
      return Object.keys(fields).length === 1 && "runId" in fields && isUuidOrRunBinding(fields.runId);
    case "refresh_runs":
    case "reset_filters":
      return Object.keys(fields).length === 0;
    default:
      return false;
  }
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

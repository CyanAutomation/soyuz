export type OpenApiMethod = "get" | "post" | "put" | "patch" | "delete";

export interface OpenApiTag {
  name: string;
  description?: string;
}

export interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  additionalProperties?: boolean | OpenApiSchema;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  [key: string]: unknown;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema;
  example?: unknown;
  examples?: Record<string, { summary?: string; value?: unknown }>;
}

export interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}

export interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags?: string[];
  security?: Array<Record<string, string[] | undefined>>;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse | { $ref: string }>;
}

export interface OpenApiPathItem {
  parameters?: OpenApiParameter[];
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  head?: OpenApiOperation;
  options?: OpenApiOperation;
  trace?: OpenApiOperation;
  [methodOrExtension: string]: OpenApiOperation | OpenApiParameter[] | undefined;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: OpenApiTag[];
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, { description?: string; type?: string; scheme?: string }>;
    responses?: Record<string, OpenApiResponse>;
  };
}

export function isOpenApiDocument(value: unknown): value is OpenApiDocument {
  if (!isRecord(value)) return false;
  if (typeof value.openapi !== "string" || !value.openapi.startsWith("3.")) return false;
  if (!isRecord(value.info) || typeof value.info.title !== "string" || typeof value.info.version !== "string") return false;
  if (!isRecord(value.paths)) return false;

  return Object.values(value.paths).every((pathItem) => {
    if (!isRecord(pathItem)) return false;
    return Object.entries(pathItem).every(([method, operation]) => {
      if (method === "parameters" || method.startsWith("x-")) return true;
      if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)) return false;
      return isRecord(operation)
        && typeof operation.operationId === "string"
        && typeof operation.summary === "string"
        && isRecord(operation.responses);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

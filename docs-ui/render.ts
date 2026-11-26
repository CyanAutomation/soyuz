import type {
  OpenApiDocument,
  OpenApiMediaType,
  OpenApiMethod,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiResponse,
  OpenApiSchema,
} from "./openapi-types.js";

const METHODS: OpenApiMethod[] = ["get", "post", "put", "patch", "delete"];

export function renderOpenApiDocument(spec: OpenApiDocument, document: Document, origin: string): void {
  const navigation = requiredElement<HTMLElement>(document, "api-navigation");
  const content = requiredElement<HTMLElement>(document, "api-content");
  const status = requiredElement<HTMLElement>(document, "api-status");
  const originLabel = requiredElement<HTMLElement>(document, "api-origin");
  const title = requiredElement<HTMLElement>(document, "api-title");
  const description = requiredElement<HTMLElement>(document, "api-description");
  const version = requiredElement<HTMLElement>(document, "api-version");
  const search = document.getElementById("api-search") as HTMLInputElement | null;

  navigation.replaceChildren();
  for (const child of Array.from(content.children)) {
    if (child !== status) child.remove();
  }
  originLabel.textContent = origin;
  title.textContent = spec.info.title;
  description.textContent = spec.info.description ?? "API operations and schemas.";
  version.textContent = spec.info.version;

  const groups = new Map<string, HTMLElement>();
  const orderedTags = (spec.tags ?? []).map((tag) => tag.name);
  let operationCount = 0;
  let sectionIndex = 0;

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = pathItem[method] as OpenApiOperation | undefined;
      if (!operation) continue;
      operationCount += 1;

      const tag = operation.tags?.[0] ?? "Other";
      let group = groups.get(tag);
      if (!group) {
        const sectionId = `api-section-${slug(tag)}-${sectionIndex++}`;
        const navLink = document.createElement("a");
        navLink.href = `#${sectionId}`;
        navLink.textContent = tag;
        appendTo(navigation, navLink);

        group = document.createElement("section");
        group.className = "api-group";
        group.id = sectionId;
        const heading = document.createElement("h2");
        heading.textContent = tag;
        appendTo(group, heading);
        const tagDescription = spec.tags?.find((candidate) => candidate.name === tag)?.description;
        if (tagDescription) appendTo(group, textElement(document, "p", tagDescription));
        appendTo(content, group);
        groups.set(tag, group);
      }

      const article = renderOperation(spec, document, path, method, operation, operationCount);
      appendTo(group, article);
      if (!orderedTags.includes(tag)) orderedTags.push(tag);
    }
  }

  const visibleCount = () => content.querySelectorAll("article.api-operation:not([hidden])").length;
  const updateCount = () => {
    const count = visibleCount();
    status.textContent = count === operationCount
      ? `${operationCount} operations`
      : `Showing ${count} of ${operationCount} operations`;
    for (const group of groups.values()) {
      group.hidden = group.querySelector("article.api-operation:not([hidden])") === null;
    }
  };

  search?.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase();
    for (const article of content.querySelectorAll<HTMLElement>("article.api-operation")) {
      article.hidden = query.length > 0 && !(article.dataset.searchText ?? "").includes(query);
    }
    updateCount();
  });

  if (orderedTags.length === 0) {
    status.textContent = "No operations are documented.";
    return;
  }
  updateCount();
}

function renderOperation(
  spec: OpenApiDocument,
  document: Document,
  path: string,
  method: OpenApiMethod,
  operation: OpenApiOperation,
  index: number,
): HTMLElement {
  const article = document.createElement("article");
  article.className = "api-operation";
  article.dataset.searchText = [method, path, operation.summary, operation.description, ...(operation.tags ?? [])]
    .join(" ")
    .toLocaleLowerCase();

  const heading = document.createElement("h3");
  heading.id = `operation-${index}`;
  heading.textContent = operation.summary;

  const route = document.createElement("p");
  route.className = "api-operation__route";
  const methodBadge = document.createElement("span");
  methodBadge.className = `method method--${method}`;
  methodBadge.textContent = method.toUpperCase();
  const pathCode = document.createElement("code");
  pathCode.textContent = path;
  appendTo(route, methodBadge, pathCode);

  appendTo(article, heading, route);
  if (operation.description) appendTo(article, textElement(document, "p", operation.description));

  const details = document.createElement("details");
  details.className = "api-operation__details";
  const summary = document.createElement("summary");
  summary.textContent = "Parameters, schemas, and responses";
  appendTo(details, summary);
  const detailContent = document.createElement("div");
  detailContent.className = "api-operation__detail-content";
  appendTo(details, detailContent);

  renderAuthentication(spec, document, detailContent, operation);
  renderParameters(spec, document, detailContent, [...(operation.parameters ?? [])]);
  if (operation.requestBody) renderRequestBody(spec, document, detailContent, operation.requestBody);
  renderResponses(spec, document, detailContent, operation.responses);

  appendTo(article, details);
  return article;
}

function renderAuthentication(spec: OpenApiDocument, document: Document, target: HTMLElement, operation: OpenApiOperation): void {
  const section = detailSection(document, target, "Authentication");
  const security = operation.security ?? spec.security ?? [];
  if (security.length === 0) {
    appendTo(section, textElement(document, "p", "Public endpoint"));
    return;
  }

  const list = document.createElement("ul");
  for (const alternative of security) {
    const names = Object.keys(alternative).map((name) => {
      const description = spec.components?.securitySchemes?.[name]?.description;
      return description ? `${name}: ${description}` : name;
    });
    const item = document.createElement("li");
    item.textContent = names.join(" and ");
    appendTo(list, item);
  }
  appendTo(section, list);
}

function renderParameters(spec: OpenApiDocument, document: Document, target: HTMLElement, parameters: OpenApiParameter[]): void {
  if (parameters.length === 0) return;
  const section = detailSection(document, target, "Parameters");
  const list = document.createElement("dl");
  for (const parameter of parameters) {
    const name = document.createElement("dt");
    name.textContent = `${parameter.name} (${parameter.in}${parameter.required ? ", required" : ""})`;
    const value = document.createElement("dd");
    if (parameter.description) appendTo(value, textElement(document, "p", parameter.description));
    if (parameter.schema) appendTo(value, renderSchema(spec, document, parameter.schema));
    appendTo(list, name, value);
  }
  appendTo(section, list);
}

function renderRequestBody(spec: OpenApiDocument, document: Document, target: HTMLElement, body: NonNullable<OpenApiOperation["requestBody"]>): void {
  const section = detailSection(document, target, `Request body${body.required ? " (required)" : ""}`);
  if (body.description) appendTo(section, textElement(document, "p", body.description));
  renderMediaTypes(spec, document, section, body.content ?? {});
}

function renderResponses(
  spec: OpenApiDocument,
  document: Document,
  target: HTMLElement,
  responses: OpenApiOperation["responses"],
): void {
  const section = detailSection(document, target, "Responses");
  const list = document.createElement("ul");
  list.className = "response-list";
  for (const [code, candidate] of Object.entries(responses)) {
    const response = resolveResponse(spec, candidate);
    const item = document.createElement("li");
    const heading = document.createElement("h5");
    heading.textContent = `${code} — ${response?.description ?? "Response"}`;
    appendTo(item, heading);
    if (response?.content) renderMediaTypes(spec, document, item, response.content);
    appendTo(list, item);
  }
  appendTo(section, list);
}

function renderMediaTypes(spec: OpenApiDocument, document: Document, target: HTMLElement, mediaTypes: Record<string, OpenApiMediaType>): void {
  for (const [mediaType, media] of Object.entries(mediaTypes)) {
    const heading = textElement(document, "h5", mediaType);
    appendTo(target, heading);
    if (media.schema) appendTo(target, renderSchema(spec, document, media.schema));
    const example = media.example ?? Object.values(media.examples ?? {})[0]?.value;
    if (example !== undefined) appendTo(target, codeBlock(document, `${mediaType} example`, JSON.stringify(example, null, 2), "json"));
  }
}

function renderSchema(spec: OpenApiDocument, document: Document, source: OpenApiSchema, depth = 0): HTMLElement {
  const schema = resolveSchema(spec, source);
  const container = document.createElement("div");
  container.className = "schema-summary";
  if (!schema) {
    appendTo(container, textElement(document, "p", "Schema details are available in the OpenAPI document."));
    return container;
  }

  const type = schemaType(source, schema);
  const typeLabel = textElement(document, "p", `Type: ${type}`);
  typeLabel.className = "schema-summary__type";
  appendTo(container, typeLabel);
  if (schema.description) appendTo(container, textElement(document, "p", schema.description));

  if (schema.enum?.length) appendTo(container, textElement(document, "p", `Allowed values: ${schema.enum.join(", ")}`));
  if (schema.default !== undefined) appendTo(container, textElement(document, "p", `Default: ${String(schema.default)}`));

  const properties = schema.properties;
  if (properties && depth < 2) {
    const required = new Set(schema.required ?? []);
    const list = document.createElement("dl");
    for (const [name, property] of Object.entries(properties)) {
      appendTo(list, textElement(document, "dt", `${name}${required.has(name) ? " (required)" : ""}`));
      const value = document.createElement("dd");
      const resolved = resolveSchema(spec, property);
      appendTo(value, textElement(document, "code", schemaType(property, resolved) + (resolved?.description ? ` — ${resolved.description}` : "")));
      if (resolved?.enum?.length) appendTo(value, textElement(document, "p", `Allowed values: ${resolved.enum.join(", ")}`));
      if (resolved?.properties && depth + 1 < 2) appendTo(value, renderSchema(spec, document, property, depth + 1));
      appendTo(list, value);
    }
    appendTo(container, list);
  } else if (schema.items && depth < 2) {
    appendTo(container, textElement(document, "p", `Items: ${schemaType(schema.items, resolveSchema(spec, schema.items))}`));
  }

  return container;
}

function resolveSchema(spec: OpenApiDocument, schema: OpenApiSchema | undefined): OpenApiSchema | null {
  if (!schema) return null;
  if (!schema.$ref) return schema;
  const prefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(prefix)) return null;
  return spec.components?.schemas?.[schema.$ref.slice(prefix.length)] ?? null;
}

function resolveResponse(spec: OpenApiDocument, response: OpenApiOperation["responses"][string]): OpenApiResponse | null {
  if (!("$ref" in response)) return response;
  const prefix = "#/components/responses/";
  if (!response.$ref.startsWith(prefix)) return null;
  return spec.components?.responses?.[response.$ref.slice(prefix.length)] ?? null;
}

function schemaType(original: OpenApiSchema, resolved: OpenApiSchema | null): string {
  if (original.$ref) return original.$ref.split("/").at(-1) ?? "object";
  const schema = resolved ?? original;
  if (schema.allOf) return schema.allOf.map((item) => schemaType(item, null)).join(" & ");
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf ?? []).map((item) => schemaType(item, null)).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type === "array") return `array of ${schemaType(schema.items ?? {}, null)}`;
  return schema.type ?? (schema.properties ? "object" : "any");
}

function detailSection(document: Document, target: HTMLElement, title: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "api-detail-section";
  appendTo(section, textElement(document, "h4", title));
  appendTo(target, section);
  return section;
}

function codeBlock(document: Document, label: string, value: string, language: string): HTMLElement {
  const figure = document.createElement("figure");
  const caption = textElement(document, "figcaption", label);
  caption.id = `example-${slug(label)}-${Math.random().toString(36).slice(2, 8)}`;
  const pre = document.createElement("pre");
  pre.tabIndex = 0;
  pre.setAttribute("role", "region");
  pre.setAttribute("aria-labelledby", caption.id);
  const code = document.createElement("code");
  code.className = `language-${language}`;
  code.textContent = value;
  appendTo(pre, code);
  appendTo(figure, caption, pre);
  return figure;
}

function textElement<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function requiredElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`API documentation page is missing #${id}`);
  return element as T;
}

function appendTo(parent: Node, ...children: Node[]): void {
  for (const child of children) parent.appendChild(child);
}

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "api";
}

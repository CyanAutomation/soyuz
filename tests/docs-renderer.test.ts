import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import openApiDocument from "../public/openapi.json";
import { renderOpenApiDocument } from "../docs-ui/render.js";
import type { OpenApiDocument } from "../docs-ui/openapi-types.js";

const spec = openApiDocument as unknown as OpenApiDocument;

describe("OpenAPI reference renderer", () => {
  it("renders tagged operations from the OpenAPI document", () => {
    const { document } = parseHTML('<nav id="api-navigation"></nav><p id="api-status"></p><main id="api-content"></main><span id="api-origin"></span><h1 id="api-title"></h1><p id="api-description"></p><span id="api-version"></span>');

    renderOpenApiDocument(spec, document as unknown as Document, "https://soyuz.test");

    expect(document.querySelector("#api-origin")?.textContent).toBe("https://soyuz.test");
    expect(document.querySelector("#api-version")?.textContent).toBe("1.0.0");
    expect(document.querySelectorAll("#api-content h2").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("#api-content article").length).toBeGreaterThan(20);
    expect(document.querySelector("#api-content")?.textContent ?? "").toContain("/v1/worker/runs/{runId}/claim");
    expect(document.querySelector("#api-status")).not.toBeNull();
    expect(document.querySelector("#api-status")?.textContent ?? "").toContain("operations");
  });

  it("renders spec text as text instead of interpreting it as HTML", () => {
    const { document } = parseHTML('<nav id="api-navigation"></nav><p id="api-status"></p><main id="api-content"></main><span id="api-origin"></span><h1 id="api-title"></h1><p id="api-description"></p><span id="api-version"></span>');
    const unsafeDocument = structuredClone(spec);
    unsafeDocument.paths["/health"].get!.summary = '<img src=x onerror="alert(1)">';

    renderOpenApiDocument(unsafeDocument, document as unknown as Document, "https://soyuz.test");

    expect(document.querySelector("#api-content img")).toBeNull();
    expect(document.querySelector("#api-content")?.textContent ?? "").toContain('<img src=x onerror="alert(1)">');
  });
});

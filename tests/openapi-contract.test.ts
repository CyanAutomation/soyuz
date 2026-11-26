import { describe, expect, it } from "vitest";
import openApiDocument from "../public/openapi.json";

const expectedOperations: Record<string, string[]> = {
  "/health": ["get"],
  "/utcp": ["get"],
  "/v1/runs": ["get", "post"],
  "/v1/runs/{runId}": ["get"],
  "/v1/runs/{runId}/retry": ["post"],
  "/v1/runs/{runId}/events": ["get"],
  "/v1/runs/{runId}/cancel": ["post"],
  "/v1/runs/{runId}/artifacts": ["get"],
  "/v1/runs/{runId}/artifacts/{artifactId}": ["get"],
  "/v1/runs/{runId}/publication": ["get"],
  "/v1/run-outcomes": ["get"],
  "/v1/storage-usage": ["get"],
  "/v1/agent/runs": ["get", "post"],
  "/v1/agent/runs/{runId}": ["get"],
  "/v1/agent/runs/{runId}/events": ["get"],
  "/v1/agent/runs/{runId}/cancel": ["post"],
  "/v1/worker/runs/{runId}": ["get"],
  "/v1/worker/runs/{runId}/claim": ["post"],
  "/v1/worker/runs/{runId}/started": ["post"],
  "/v1/worker/runs/{runId}/events": ["post"],
  "/v1/worker/runs/{runId}/completed": ["post"],
  "/v1/worker/runs/{runId}/failed": ["post"],
  "/v1/worker/runs/{runId}/cancelled": ["post"],
  "/v1/worker/runs/{runId}/artifacts/{artifactId}": ["put"],
  "/v1/worker/runs/{runId}/publication-manifests/{artifactId}": ["put"],
  "/v1/worker/runs/{runId}/publication-intents": ["post"],
};

describe("OpenAPI contract", () => {
  it("documents every integration-facing REST operation", () => {
    const actual = Object.fromEntries(
      Object.entries(openApiDocument.paths).map(([path, pathItem]) => [
        path,
        Object.keys(pathItem).filter((method) => ["get", "post", "put", "patch", "delete"].includes(method)).sort(),
      ]),
    );

    expect(actual).toEqual(Object.fromEntries(
      Object.entries(expectedOperations).map(([path, methods]) => [path, [...methods].sort()]),
    ));
  });

  it("gives each operation a stable identifier, tag, and response contract", () => {
    for (const [path, pathItem] of Object.entries(openApiDocument.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        expect(operation.operationId, `${method.toUpperCase()} ${path} operationId`).toBeTruthy();
        expect(operation.tags, `${method.toUpperCase()} ${path} tags`).not.toHaveLength(0);
        expect(Object.keys(operation.responses ?? {}), `${method.toUpperCase()} ${path} responses`).not.toHaveLength(0);
      }
    }
  });
});

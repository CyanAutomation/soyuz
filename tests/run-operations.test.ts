import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { A2UI_CATALOG_ID, validateA2uiMessages } from "../a2ui/protocol";
import { A2uiDomRenderer } from "../dashboard/a2ui-renderer";
import { createRunOperationsSurface, projectRunOperations, type RunOperationsInput, type RunOperationsPublication } from "../dashboard/run-operations";

const now = Date.parse("2026-11-22T12:10:00.000Z");

function run(overrides: Partial<RunOperationsInput> = {}): RunOperationsInput {
  return {
    status: "running",
    runId: "00000000-0000-4000-8000-000000000101",
    displayId: "soyuz-101",
    repoUrl: "https://github.com/example/project",
    ref: "main",
    origin: { type: "api_client", id: "client" },
    retryOf: null,
    createdAt: "2026-11-22T12:00:00.000Z",
    queuedAt: "2026-11-22T12:00:10.000Z",
    startedAt: "2026-11-22T12:01:00.000Z",
    completedAt: null,
    stage: "validation",
    operationalHealth: "healthy",
    lastHeartbeatAt: "2026-11-22T12:09:00.000Z",
    outcomeSummary: null,
    failureMessage: "raw provider error should not enter A2UI data",
    publication: null,
    legacyPublished: false,
    ...overrides,
  };
}

describe("run operations A2UI surface", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("[RUN-OPERATIONS-CLASSIFY-01] groups active, failed, stalled, completed, and publication records", () => {
    const projection = projectRunOperations([
      run(),
      run({ runId: "00000000-0000-4000-8000-000000000102", status: "failed", operationalHealth: "unknown" }),
      run({ runId: "00000000-0000-4000-8000-000000000103", operationalHealth: "suspect_stalled" }),
      run({ runId: "00000000-0000-4000-8000-000000000104", status: "completed", completedAt: "2026-11-22T12:04:00.000Z", outcomeSummary: "Updated the project safely." }),
      run({ runId: "00000000-0000-4000-8000-000000000105", status: "completed", publication: { state: "retryable_failure", attemptCount: 2, nextAttemptAt: "2026-11-22T12:15:00.000Z" } }),
      run({ runId: "00000000-0000-4000-8000-000000000106", status: "completed", legacyPublished: true }),
    ], now);

    expect(projection.ops.activeRuns.map((item) => item.runId)).toEqual(["00000000-0000-4000-8000-000000000101"]);
    expect(projection.ops.attentionRuns.map((item) => item.runId)).toEqual([
      "00000000-0000-4000-8000-000000000102",
      "00000000-0000-4000-8000-000000000103",
    ]);
    expect(projection.ops.completedRuns.map((item) => item.runId)).toEqual([
      "00000000-0000-4000-8000-000000000104",
      "00000000-0000-4000-8000-000000000105",
      "00000000-0000-4000-8000-000000000106",
    ]);
    expect(projection.ops.publicationRuns.map((item) => item.publicationState)).toEqual([
      "Retryable failure",
      "Legacy published",
    ]);
    expect(projection.ops.activeSummary).toContain("1 active run");
  });

  it("[RUN-OPERATIONS-PRIVACY-01] omits repository internals, raw errors, and private publication fields", () => {
    const projection = projectRunOperations([run({
      publication: {
        state: "pending",
        attemptCount: 1,
        nextAttemptAt: null,
        artifactObjectKey: "private-r2-key",
        lastErrorCode: "provider-internal-detail",
        repositoryOwner: "private-owner",
      } as RunOperationsPublication,
    })], now);
    const json = JSON.stringify(projection);

    expect(json).not.toContain("repoUrl");
    expect(json).not.toContain("failureMessage");
    expect(json).not.toContain("raw provider error");
    expect(json).not.toContain("private-r2-key");
    expect(json).not.toContain("provider-internal-detail");
    expect(json).not.toContain("private-owner");
  });

  it("[RUN-OPERATIONS-TEMPLATE-01] provides one fixed validated A2UI surface", () => {
    const surface = createRunOperationsSurface();
    const validation = validateA2uiMessages(surface, { expectedSurfaceId: "soyuz-run-operations" });

    expect(validation.ok).toBe(true);
    expect(validation.surfaceId).toBe("soyuz-run-operations");
    expect(surface).not.toContainEqual(expect.objectContaining({ version: "1.0", updateDataModel: expect.anything() }));
    expect(JSON.stringify(surface)).toContain("select_run");
    expect(JSON.stringify(surface)).not.toContain("jev_decisions");
  });

  it("[A2UI-RENDER-01] renders host bindings as text and dispatches run selection through the host", () => {
    const { document } = parseHTML("<html><body><section id='output'></section></body></html>");
    vi.stubGlobal("document", document);
    const target = document.querySelector("#output") as HTMLElement;
    const onAction = vi.fn();
    const renderer = new A2uiDomRenderer(target, onAction);
    const projection = projectRunOperations([run({ displayId: "<img src=x>run-101" })], now);
    const surface = createRunOperationsSurface();

    expect(surface[0]).toMatchObject({ version: "1.0", createSurface: { catalogId: A2UI_CATALOG_ID } });
    renderer.render(surface, projection as unknown as Record<string, unknown>);

    expect(target.querySelector("img")).toBeNull();
    expect(target.textContent).toContain("<img src=x>run-101");
    expect(target.textContent).toContain("Running · Stage Validation · Age 10m · Queue 50s · Execution 9m");
    target.querySelector<HTMLButtonElement>("button")?.click();
    expect(onAction).toHaveBeenCalledWith({
      name: "select_run",
      context: { runId: "00000000-0000-4000-8000-000000000101" },
    });
    renderer.dispose();
  });
});

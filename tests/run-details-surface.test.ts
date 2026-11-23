import { describe, expect, it, vi } from "vitest";
import { validateA2uiMessages } from "../a2ui/protocol";
import { A2uiDomRenderer } from "../dashboard/a2ui-renderer";
import { createRunDetailsSurface, projectRunDetails, type RunDetailsSurfaceInput } from "../dashboard/run-details-surface";
import { parseHTML } from "linkedom";

const input: RunDetailsSurfaceInput = {
  run: {
    runId: "00000000-0000-4000-8000-000000000101",
    displayId: "soyuz-101",
    status: "completed",
    stage: "finished",
    taskMode: "inspect",
    publishMode: "pr",
    origin: { type: "api_client", id: "client-1" },
    retryOf: "00000000-0000-4000-8000-000000000099",
    outcomeSummary: "Retry completed with checks passing.",
    failureClass: null,
    exitCode: 0,
    changedFileCount: 3,
    publicationStatusAvailable: true,
    publication: { state: "retryable_failure", attemptCount: 2, nextAttemptAt: "2026-11-23T12:00:00.000Z" },
    legacyPublished: false,
  },
  events: [{
    sequence: 1,
    type: "run.completed",
    stage: "finished",
    step: null,
    timestamp: "2026-11-23T11:00:00.000Z",
    payload: { status: "completed", changedFileCount: 3, rawDetail: "private event payload" },
  }],
  artifacts: [{ id: "00000000-0000-4000-8000-000000000201", name: "result.json", size: 128 }],
};

describe("selected run A2UI surface", () => {
  it("[A2UI-SELECTED-RUN-01] projects bounded run, publication, event, and artifact summaries without private evidence", () => {
    const projection = projectRunDetails(input);
    const serialized = JSON.stringify(projection);

    expect(projection.selectedRun).toMatchObject({
      runId: input.run.runId,
      displayId: "soyuz-101",
      summary: expect.stringContaining("Retry completed with checks passing."),
      publicationSummary: expect.stringContaining("Retryable failure"),
    });
    expect(projection.selectedRun.summary).toContain("Task Inspect");
    expect(projection.selectedRun.summary).toContain("Publishing Pr");
    expect(projection.events).toHaveLength(1);
    expect(projection.events[0]?.summary).toContain("Run completed");
    expect(projection.artifacts).toEqual([{ id: input.artifacts[0]!.id, summary: "result.json · 128 B" }]);
    expect(serialized).not.toContain("rawDetail");
    expect(serialized).not.toContain("private event payload");
    expect(serialized).not.toContain("origin");
  });

  it("uses a fixed validated template and exposes only run-scoped host actions", () => {
    const surface = createRunDetailsSurface({ showJevAction: true, showLoadMore: true });
    const validation = validateA2uiMessages(surface, { expectedSurfaceId: "soyuz-run-details" });
    const serialized = JSON.stringify(surface);

    expect(validation.ok).toBe(true);
    expect(serialized).toContain("assess_run");
    expect(serialized).toContain("download_artifact");
    expect(serialized).toContain("load_more_events");
    expect(serialized).not.toContain("profileId");
  });

  it("[JEV-A2UI-01] dispatches the selected run ID without selecting a profile in the A2UI action", () => {
    const { document } = parseHTML("<html><body><section id='output'></section></body></html>");
    const target = document.querySelector("#output") as HTMLElement;
    const onAction = vi.fn();
    const renderer = new A2uiDomRenderer(target, onAction);
    renderer.render(createRunDetailsSurface({ showJevAction: true, showLoadMore: false }), projectRunDetails(input) as unknown as Record<string, unknown>);

    const assess = [...target.querySelectorAll("button")].find((button) => button.textContent === "Assess with JEV");
    expect(assess).toBeTruthy();
    assess?.click();
    expect(onAction).toHaveBeenCalledWith({ name: "assess_run", context: { runId: input.run.runId } });
    renderer.dispose();
  });
});

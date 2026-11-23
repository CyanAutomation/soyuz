import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { createJevAssessmentPanel } from "../dashboard/jev-panel";

function createDocument() {
  return parseHTML("<html><body></body></html>").document;
}

describe("reusable run-card JEV panel", () => {
  it("[JEV-A2UI-02] offers an explicit action and reports request progress", () => {
    const document = createDocument();
    const onAssess = vi.fn();
    const idlePanel = createJevAssessmentPanel({
      runId: "00000000-0000-4000-8000-000000000201",
      profileId: "run_operations_triage_v1",
      state: { status: "idle" },
      onAssess,
      onFeedback: vi.fn(),
      ownerDocument: document,
    });
    idlePanel.querySelector<HTMLButtonElement>("button")?.click();
    expect(onAssess).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000201", "run_operations_triage_v1");

    const panel = createJevAssessmentPanel({
      runId: "00000000-0000-4000-8000-000000000201",
      profileId: "run_operations_triage_v1",
      state: { status: "loading" },
      onAssess,
      onFeedback: vi.fn(),
      ownerDocument: document,
    });

    const button = panel.querySelector<HTMLButtonElement>("button");
    expect(panel.querySelector("h3")?.textContent).toBe("Decision support with JEV");
    expect(button?.textContent).toBe("Assessing run…");
    expect(button?.disabled).toBe(true);
    expect(panel.textContent).toContain("Sending the approved run projection to Senku");
    button?.click();
    expect(onAssess).toHaveBeenCalledOnce();
  });

  it("[JEV-A2UI-02/JEV-RENDER-01] renders advisory answers and rating actions", () => {
    const document = createDocument();
    const onFeedback = vi.fn();
    const panel = createJevAssessmentPanel({
      runId: "00000000-0000-4000-8000-000000000202",
      profileId: "run_operations_triage_v1",
      state: {
        status: "complete",
        result: {
          model: "test-model",
          answers: {
            needs_followup: { type: "noul", noul: 0.8, probabilities: { false: 0.2, true: 0.8 }, confidence: null },
            likely_area: { type: "choice", choice: "execution", probabilities: { execution: 0.8, control_plane: 0.1, unknown: 0.1 }, confidence: 0.75 },
            severity: { type: "score", score: 1, legend: { "0": "Routine", "1": "Needs review", "2": "Urgent" }, probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 }, confidence: 0.8 },
          },
        },
        rating: null,
      },
      onAssess: vi.fn(),
      onFeedback,
      ownerDocument: document,
    });

    expect(panel.textContent).toContain("Advisory result. Verify the run record before taking consequential action.");
    expect(panel.textContent).toContain("Needs review");
    const helpful = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Helpful");
    helpful?.click();
    expect(onFeedback).toHaveBeenCalledWith("helpful");
    expect(panel.querySelector("script")).toBeNull();
  });
});

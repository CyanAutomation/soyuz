import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { renderJevResult } from "../dashboard/analysis/jev-renderer";

describe("fixed JEV result renderer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders validated answer values with text nodes and accessible probability meters", () => {
    const { document } = parseHTML("<html><body><section id='output'></section></body></html>");
    vi.stubGlobal("document", document);
    const output = document.querySelector("#output") as HTMLElement;
    renderJevResult(output, "run_operations_triage_v1", {
      model: "<img src=x>",
      answers: {
        needs_followup: { type: "noul", noul: 0.8, probabilities: { false: 0.2, true: 0.8 }, confidence: null },
        likely_area: { type: "choice", choice: "execution", probabilities: { execution: 0.8, control_plane: 0.1, unknown: 0.1 }, confidence: 0.75 },
        severity: { type: "score", score: 1, legend: { "0": "Routine", "1": "Needs review", "2": "Urgent" }, probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 }, confidence: 0.8 },
      },
    });

    expect(output.textContent).toContain("<img src=x>");
    expect(output.querySelector("img")).toBeNull();
    expect(output.textContent).toContain("Selected: Kaseki execution");
    expect(output.querySelectorAll("progress").length).toBeGreaterThan(0);
    expect(output.textContent).toContain("Confidence: not provided");
  });
});

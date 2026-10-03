import { describe, expect, it } from "vitest";
import { canTransition, isTerminalStatus } from "../src/domain/run-state-machine";

describe("run state machine", () => {
  it("permits admission, execution, and cancellation transitions", () => {
    expect(canTransition("admitting", "queued")).toBe(true);
    expect(canTransition("admitting", "admission_failed")).toBe(true);
    expect(canTransition("queued", "claimed")).toBe(true);
    expect(canTransition("claimed", "running")).toBe(true);
    expect(canTransition("claimed", "admitting")).toBe(true);
    expect(canTransition("claimed", "cancelled")).toBe(true);
    expect(canTransition("queued", "cancelled")).toBe(true);
    expect(canTransition("running", "cancel_requested")).toBe(true);
    expect(canTransition("cancel_requested", "completed")).toBe(true);
    expect(canTransition("cancel_requested", "failed")).toBe(true);
    expect(canTransition("cancel_requested", "cancelled")).toBe(true);
  });

  it("protects terminal states from returning to active states", () => {
    for (const status of ["cancelled", "completed", "failed", "admission_failed"] as const) {
      expect(isTerminalStatus(status)).toBe(true);
      expect(canTransition(status, "queued")).toBe(false);
      expect(canTransition(status, "running")).toBe(false);
    }
  });
});

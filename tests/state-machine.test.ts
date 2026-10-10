import { describe, expect, it } from "vitest";
import { allowedTransitions, canTransition, isTerminalStatus, RUN_STATUSES, type RunStatus } from "../src/domain/run-state-machine";

const documentedTransitions: Record<RunStatus, readonly RunStatus[]> = {
  admitting: ["queued", "admission_failed", "cancelled"],
  queued: ["claimed", "cancelled"],
  claimed: ["running", "admitting", "cancelled", "failed"],
  running: ["cancel_requested", "completed", "failed", "cancelled"],
  cancel_requested: ["completed", "failed", "cancelled"],
  cancelled: [],
  completed: [],
  failed: [],
  admission_failed: [],
};

const terminalStatuses = new Set<RunStatus>(["cancelled", "completed", "failed", "admission_failed"]);

describe("run state machine", () => {
  it("[LIFECYCLE-TRANSITIONS-01] permits only the documented lifecycle transitions", () => {
    for (const from of RUN_STATUSES) {
      expect(allowedTransitions(from), from).toEqual(documentedTransitions[from]);
      for (const to of RUN_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(documentedTransitions[from].includes(to));
      }
    }
  });

  it("[LIFECYCLE-TERMINAL-01] prevents terminal states from returning to active states", () => {
    const activeStatuses = RUN_STATUSES.filter((status) => !terminalStatuses.has(status));

    for (const status of RUN_STATUSES) {
      expect(isTerminalStatus(status), status).toBe(terminalStatuses.has(status));
      if (!terminalStatuses.has(status)) continue;

      for (const activeStatus of activeStatuses) {
        expect(canTransition(status, activeStatus), `${status} -> ${activeStatus}`).toBe(false);
      }
    }
  });
});

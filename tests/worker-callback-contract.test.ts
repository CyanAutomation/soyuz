import { describe, expect, it } from "vitest";
import {
  WorkerCancelledSchema,
  WorkerCompletedSchema,
  WorkerFailedSchema,
} from "../src/contracts/worker-callbacks";

const callbackBase = {
  contractVersion: "1",
  callbackId: "00000000-0000-4000-8000-000000000101",
  workerId: "worker-test",
};

const terminalOutcome = {
  summary: "The run stopped after validation.",
  publishedUrl: "https://github.com/example/project/pull/7",
  changedFileCount: 3,
  outcomeSummary: {
    schemaVersion: 1,
    evaluation: {
      assessment: "poor",
      reviewerConfidence: "high",
      improvementCategories: [],
    },
  },
};

describe("worker terminal callback contract", () => {
  it("accepts Kaseki terminal outcome fields on completed callbacks", () => {
    expect(WorkerCompletedSchema.safeParse({
      ...callbackBase,
      exitCode: 0,
      ...terminalOutcome,
    }).success).toBe(true);
  });

  it("accepts Kaseki terminal outcome fields on failed callbacks", () => {
    expect(WorkerFailedSchema.safeParse({
      ...callbackBase,
      exitCode: 1,
      failureClass: "validation_failed",
      failureMessage: "The validation command failed.",
      ...terminalOutcome,
    }).success).toBe(true);
  });

  it("accepts Kaseki terminal outcome fields on cancelled callbacks", () => {
    expect(WorkerCancelledSchema.safeParse({
      ...callbackBase,
      reason: "Cancellation was applied.",
      ...terminalOutcome,
    }).success).toBe(true);
  });

  it("keeps the terminal outcome fields bounded", () => {
    expect(WorkerFailedSchema.safeParse({
      ...callbackBase,
      failureClass: "validation_failed",
      failureMessage: "The validation command failed.",
      changedFileCount: 100_001,
    }).success).toBe(false);
  });
});

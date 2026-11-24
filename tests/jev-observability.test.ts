import { describe, expect, it } from "vitest";
import { createJevDecisionLogEvent } from "../src/jev/observability";

describe("JEV decision log event", () => {
  it("includes the public correlation ID and only the safe event fields", () => {
    const event = createJevDecisionLogEvent({
      requestId: "req-123",
      profileId: "run_operations_triage_v1",
      durationMs: 12,
      outcome: "provider_unavailable",
      errorCode: "PROVIDER_UNAVAILABLE",
      providerAttemptCount: 1,
      senkuRequestId: "dec-123",
    });

    expect(event).toEqual({
      event: "soyuz_jev_decision",
      backend: "senku",
      requestId: "req-123",
      profileId: "run_operations_triage_v1",
      durationMs: 12,
      outcome: "provider_unavailable",
      errorCode: "PROVIDER_UNAVAILABLE",
      providerAttemptCount: 1,
      senkuRequestId: "dec-123",
    });
    expect(event).not.toHaveProperty("runId");
  });
});

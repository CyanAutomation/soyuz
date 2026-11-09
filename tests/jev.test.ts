import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { buildSenkuInput } from "../src/jev/analysis";
import { JEV_PROFILE_CONTRACTS, type JevProfileId } from "../src/jev/profiles";
import { requestSenkuDecision, SenkuDecisionError, SENKU_REQUEST_TIMEOUT_MS } from "../src/jev/senku-client";

const TOKEN = "senku-soyuz-test-token-value-long-enough";
const TRIAGE_INPUT = { run: {
  status: "failed",
  stage: "validation",
  operationalHealth: "suspect_stalled",
  failureClass: "provider_failure",
  createdAt: "2026-11-08T12:00:00.000Z",
  queuedAt: "2026-11-08T12:00:01.000Z",
  startedAt: "2026-11-08T12:00:02.000Z",
  completedAt: "2026-11-08T12:00:03.000Z",
  lastHeartbeatAt: "2026-11-08T12:00:02.500Z",
} };

const OUTPUT_REVIEW_INPUT = {
  canonicalRun: { status: "completed", failureClass: null, exitCode: 0, changedFileCount: 3 },
  summary: "Recorded bounded summary.",
};

function validAnswers(profileId: JevProfileId): Record<string, unknown> {
  switch (profileId) {
    case "run_operations_triage_v1":
      return {
        needs_followup: { type: "noul", noul: 0.8, probabilities: { false: 0.2, true: 0.8 }, confidence: null },
        likely_area: {
          type: "choice", choice: "execution",
          probabilities: { execution: 0.8, control_plane: 0.1, unknown: 0.1 }, confidence: null,
        },
        severity: {
          type: "score", score: 1,
          legend: { "0": "Routine", "1": "Needs review", "2": "Urgent" },
          probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 }, confidence: null,
        },
      };
    case "kaseki_output_review_v1":
    case "kaseki_output_review_v2": {
      const answers: Record<string, unknown> = {
        summary_specificity: { type: "noul", noul: 0.9, probabilities: { false: 0.1, true: 0.9 }, confidence: null },
        outcome_alignment: {
          type: "choice", choice: "consistent",
          probabilities: { consistent: 0.8, unclear: 0.1, inconsistent: 0.1 }, confidence: null,
        },
        evidence_strength: {
          type: "score", score: 1,
          legend: { "0": "Insufficient", "1": "Some concrete detail", "2": "Clear and specific" },
          probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 }, confidence: null,
        },
      };
      if (profileId === "kaseki_output_review_v2") {
        answers.recorded_outcome = {
          type: "score", score: 2,
          legend: {
            "0": "Outcome unclear or unsuccessful",
            "1": "Partial or limited outcome evidence",
            "2": "Successful and clearly reported outcome",
          },
          probabilities: { "0": 0.05, "1": 0.1, "2": 0.85 }, confidence: 0.85,
        };
      }
      return answers;
    }
  }
}

function senkuResponse(profileId: JevProfileId, overrides: Record<string, unknown> = {}): Response {
  const answers = validAnswers(profileId);
  const payload = {
    schemaVersion: "1",
    requestId: "dec-00000000-0000-4000-8000-000000000001",
    status: "completed",
    profileId,
    profileVersion: JEV_PROFILE_CONTRACTS[profileId].version,
    provider: "jev",
    model: "typesafe/jev-test",
    answers,
    result: answers,
    durationMs: 9,
    attemptCount: 1,
    usage: { input_tokens: 120, output_tokens: 80, cost: 0.002 },
    ...overrides,
  };
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

function environment(overrides: Partial<Env> = {}): Env {
  return {
    SENKU_SOYUZ_API_TOKEN: TOKEN,
    SENKU: { fetch: async () => senkuResponse("run_operations_triage_v1") } as unknown as Fetcher,
    ...overrides,
  } as Env;
}

describe("Soyuz to Senku decision client", () => {
  it("preserves nullable output evidence, accepts exit code -1, and bounds recorded summaries", () => {
    const summary = "😀".repeat(2_001);
    const row = {
      status: "completed",
      failure_class: null,
      exit_code: -1,
      result_json: JSON.stringify({ summary, changedFileCount: 1_000_001, publishedUrl: "https://private.example.invalid" }),
    } as Parameters<typeof buildSenkuInput>[1];

    expect(buildSenkuInput("kaseki_output_review_v2", row)).toEqual({
      canonicalRun: { status: "completed", failureClass: null, exitCode: -1, changedFileCount: null },
      summary: "😀".repeat(2_000),
    });
  });

  it("sends the versioned profile envelope and machine token through one binding call", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => senkuResponse("run_operations_triage_v1"));
    const binding = { fetch: fetchMock } as unknown as Fetcher;
    const result = await requestSenkuDecision(environment(), "run_operations_triage_v1", TRIAGE_INPUT, binding);

    expect(binding.fetch).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.url).toBe("https://senku.internal/v1/profiles/run_operations_triage_v1/evaluate");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer " + TOKEN);
    expect(JSON.parse(await request.clone().text())).toEqual({ schemaVersion: "1", input: TRIAGE_INPUT });
    expect(result).toMatchObject({
      model: "typesafe/jev-test",
      requestId: "dec-00000000-0000-4000-8000-000000000001",
      attemptCount: 1,
      usage: { input_tokens: 120, output_tokens: 80 },
    });
    expect(result.answers).toHaveProperty("needs_followup");
  });

  it("uses the existing Soyuz output-review profile IDs and accepts nullable evidence and confidence", async () => {
    for (const profileId of ["kaseki_output_review_v1", "kaseki_output_review_v2"] as const) {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL) => senkuResponse(profileId));
      const binding = { fetch: fetchMock } as unknown as Fetcher;
      const result = await requestSenkuDecision(environment(), profileId, OUTPUT_REVIEW_INPUT, binding);
      const request = fetchMock.mock.calls[0]![0] as Request;
      const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
      expect(request.url).toContain("/v1/profiles/" + profileId + "/evaluate");
      expect(body).toEqual({ schemaVersion: "1", input: OUTPUT_REVIEW_INPUT });
      expect(result.answers).toHaveProperty("outcome_alignment");
      expect(Object.keys(result.answers)).toHaveLength(profileId === "kaseki_output_review_v1" ? 3 : 4);
    }
  });

  it.each([
    [503, "NOT_CONFIGURED", "NOT_CONFIGURED"],
    [504, "PROVIDER_TIMEOUT", "PROVIDER_TIMEOUT"],
    [502, "PROVIDER_UNAVAILABLE", "PROVIDER_UNAVAILABLE"],
    [502, "INVALID_PROVIDER_RESPONSE", "INVALID_RESPONSE"],
    [400, "INVALID_REQUEST", "INVALID_REQUEST"],
  ])("maps Senku %i %s without exposing the response body", async (status, remoteCode, expectedCode) => {
    const binding = {
      fetch: vi.fn(async () => new Response(JSON.stringify({
        error: { code: remoteCode, message: "private raw error", requestId: "dec-00000000-0000-4000-8000-000000000002" },
      }), { status, headers: { "content-type": "application/json" } })),
    } as unknown as Fetcher;

    let caught: unknown;
    try {
      await requestSenkuDecision(environment(), "run_operations_triage_v1", TRIAGE_INPUT, binding);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SenkuDecisionError);
    expect(caught).toMatchObject({ code: expectedCode });
    expect((caught as Error).message).not.toContain("private raw error");
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong schema", { schemaVersion: "2" }],
    ["wrong profile", { profileId: "kaseki_output_review_v1" }],
    ["wrong profile version", { profileVersion: "9" }],
    ["missing answer", { answers: {} }],
    ["unexpected answer", { answers: { ...validAnswers("run_operations_triage_v1"), extra: { type: "noul" } } }],
    ["invalid answer", { answers: { ...validAnswers("run_operations_triage_v1"), needs_followup: { type: "noul", noul: 1.1 } } }],
    ["wrong result", { result: {} }],
    ["invalid attempt count", { attemptCount: 2 }],
    ["invalid usage", { usage: { input_tokens: -1 } }],
  ])("rejects malformed Senku response: %s", async (_name, overrides) => {
    const binding = { fetch: vi.fn(async () => senkuResponse("run_operations_triage_v1", overrides)) } as unknown as Fetcher;
    await expect(requestSenkuDecision(environment(), "run_operations_triage_v1", TRIAGE_INPUT, binding))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("handles invalid JSON and oversized responses", async () => {
    const invalidJson = { fetch: vi.fn(async () => new Response("{", { headers: { "content-type": "application/json" } })) } as unknown as Fetcher;
    await expect(requestSenkuDecision(environment(), "run_operations_triage_v1", TRIAGE_INPUT, invalidJson))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const oversized = { fetch: vi.fn(async () => new Response(" ".repeat(64 * 1024 + 1), { headers: { "content-type": "application/json" } })) } as unknown as Fetcher;
    await expect(requestSenkuDecision(environment(), "run_operations_triage_v1", TRIAGE_INPUT, oversized))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("fails safely for a missing binding, missing token, service outage, and timeout", async () => {
    await expect(requestSenkuDecision(environment({ SENKU: undefined }), "run_operations_triage_v1", TRIAGE_INPUT))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(requestSenkuDecision(environment({ SENKU_SOYUZ_API_TOKEN: undefined }), "run_operations_triage_v1", TRIAGE_INPUT))
      .rejects.toMatchObject({ code: "NOT_CONFIGURED" });

    const unavailable = { fetch: vi.fn(async () => { throw new Error("private binding error"); }) } as unknown as Fetcher;
    await expect(requestSenkuDecision(environment(), "run_operations_triage_v1", TRIAGE_INPUT, unavailable))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(unavailable.fetch).toHaveBeenCalledTimes(1);

    const timeout = {
      fetch: vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })),
    } as unknown as Fetcher;
    await expect(requestSenkuDecision(environment(), "run_operations_triage_v1", TRIAGE_INPUT, timeout, 5))
      .rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(SENKU_REQUEST_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("classifies a timeout while reading the Senku response body", async () => {
    const timeout = {
      fetch: vi.fn((request: Request) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        },
      }), { headers: { "content-type": "application/json" } }))),
    } as unknown as Fetcher;

    await expect(requestSenkuDecision(environment(), "run_operations_triage_v1", TRIAGE_INPUT, timeout, 5))
      .rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });
});

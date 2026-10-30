import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { JevDecisionError, runJevDecision, type JevQuestions } from "../src/jev/decision";

const triageQuestions = {
  is_urgent: {
    type: "noul",
    instructions: "Does this require immediate human attention?",
    criteria: { true: "Clearly time-sensitive or dangerous", false: "Routine or already resolved" },
  },
  department: {
    type: "choice",
    instructions: "Which area most likely owns this issue?",
    criteria: {
      execution: "Kaseki execution or repository task",
      control_plane: "Soyuz API, queue, or stored run state",
      unknown: "The available record is insufficient",
    },
  },
  severity: {
    type: "score",
    instructions: "Rate the operational severity.",
    criteria: ["Routine", "Needs review", "Urgent"],
  },
} as const satisfies JevQuestions;

const validResponse = {
  model: "typesafe/jev-1.13-test",
  answers: {
    is_urgent: { type: "noul", noul: 0.95 },
    department: {
      type: "choice",
      choice: "execution",
      probabilities: { execution: 0.85, control_plane: 0.1, unknown: 0.05 },
      confidence: 0.78,
    },
    severity: {
      type: "score",
      score: 1.05,
      legend: { "0": "Routine", "1": "Needs review", "2": "Urgent" },
      probabilities: { "0": 0.05, "1": 0.9, "2": 0.05 },
      confidence: 0.93,
    },
  },
};

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENROUTER_API_KEY: "openrouter-test-key-long-enough",
    JEV_MODEL: "~typesafe/jev-latest",
    ...overrides,
  } as Env;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("reusable JEV decision adapter", () => {
  it("[JEV-ADAPTER-01] sends server-supplied typed questions and returns normalized answers", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(validResponse));

    const result = await runJevDecision(testEnv(), {
      state: JSON.stringify({ status: "failed", outcomeSummary: "The build failed during validation." }),
      questions: triageQuestions,
    }, fetcher as typeof fetch);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer openrouter-test-key-long-enough");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "~typesafe/jev-latest",
      state: JSON.stringify({ status: "failed", outcomeSummary: "The build failed during validation." }),
      questions: triageQuestions,
    });
    expect(result.model).toBe("typesafe/jev-1.13-test");
    expect(result.answers.is_urgent).toMatchObject({ type: "noul", noul: 0.95, confidence: null });
    expect((result.answers.is_urgent as { probabilities: Record<string, number> }).probabilities.true).toBe(0.95);
    expect((result.answers.department as { confidence: number | null }).confidence).toBe(0.78);
    expect((result.answers.severity as { score: number }).score).toBe(1.05);
  });

  it("[JEV-ADAPTER-02] is reusable with a different question profile", async () => {
    const questions = {
      summary_clear: {
        type: "noul",
        instructions: "Is the recorded summary clear?",
        criteria: { true: "States a concrete result", false: "Vague or absent" },
      },
    } as const satisfies JevQuestions;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({
      model: "typesafe/jev-test",
      answers: { summary_clear: { type: "noul", noul: 0.72 } },
    }));

    const result = await runJevDecision(testEnv(), {
      state: JSON.stringify({ summary: "Updated three files and passed validation." }),
      questions,
    }, fetcher as typeof fetch);

    expect(result.answers.summary_clear).toMatchObject({ type: "noul", noul: 0.72 });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).questions).toEqual(questions);
  });

  it("[JEV-ADAPTER-06] treats an explicit null confidence as unavailable", async () => {
    const fetcher = vi.fn(async () => response({
      ...validResponse,
      answers: {
        ...validResponse.answers,
        department: { ...validResponse.answers.department, confidence: null },
      },
    }));
    const result = await runJevDecision(testEnv(), { state: "bounded state", questions: triageQuestions }, fetcher as typeof fetch);
    expect(result.answers.department).toMatchObject({ type: "choice", confidence: null });
  });

  it.each([
    ["missing answer", { ...validResponse, answers: { ...validResponse.answers, severity: undefined } }],
    ["unexpected answer", { ...validResponse, answers: { ...validResponse.answers, extra: { type: "noul", noul: 0.5 } } }],
    ["wrong answer type", { ...validResponse, answers: { ...validResponse.answers, is_urgent: { type: "choice", choice: "true" } } }],
    ["out-of-range probability", { ...validResponse, answers: { ...validResponse.answers, is_urgent: { type: "noul", noul: 1.1 } } }],
    ["unknown choice", { ...validResponse, answers: { ...validResponse.answers, department: { ...validResponse.answers.department, choice: "sales" } } }],
    ["probabilities do not sum to one", { ...validResponse, answers: { ...validResponse.answers, department: { ...validResponse.answers.department, probabilities: { execution: 0.8, control_plane: 0.1, unknown: 0.05 } } } }],
    ["score exceeds its scale", { ...validResponse, answers: { ...validResponse.answers, severity: { ...validResponse.answers.severity, score: 2.1 } } }],
    ["legend differs from the requested scale", { ...validResponse, answers: { ...validResponse.answers, severity: { ...validResponse.answers.severity, legend: { "0": "Low", "1": "Medium", "2": "High" } } } }],
  ])("[JEV-ADAPTER-03] rejects malformed provider answers: %s", async (_label, body) => {
    const fetcher = vi.fn(async () => response(body));
    await expect(runJevDecision(testEnv(), { state: "bounded state", questions: triageQuestions }, fetcher as typeof fetch))
      .rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });

  it("[JEV-ADAPTER-04] rejects unsafe request definitions before contacting OpenRouter", async () => {
    const fetcher = vi.fn();
    await expect(runJevDecision(testEnv(), {
      state: " ".repeat(3),
      questions: triageQuestions,
    }, fetcher as typeof fetch)).rejects.toBeInstanceOf(JevDecisionError);
    await expect(runJevDecision(testEnv(), {
      state: "x".repeat(20_001),
      questions: triageQuestions,
    }, fetcher as typeof fetch)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("[JEV-ADAPTER-05] handles missing credentials and provider failures without returning provider details", async () => {
    const missingKey = vi.fn();
    await expect(runJevDecision(testEnv({ OPENROUTER_API_KEY: undefined }), {
      state: "bounded state",
      questions: triageQuestions,
    }, missingKey as typeof fetch)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(missingKey).not.toHaveBeenCalled();

    const providerSecret = "sensitive upstream body";
    const upstreamFailure = vi.fn(async () => new Response(providerSecret, { status: 429 }));
    await expect(runJevDecision(testEnv(), {
      state: "bounded state",
      questions: triageQuestions,
    }, upstreamFailure as typeof fetch)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

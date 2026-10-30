import type { Env } from "../env";
import {
  JevQuestionsSchema,
  type JevAnswer,
  type JevQuestion,
  type JevQuestions,
} from "./contracts";

const MAX_STATE_BYTES = 20_000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const PROVIDER_TIMEOUT_MS = 45_000;
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MODEL = "~typesafe/jev-latest";

export type { JevAnswer, JevQuestion, JevQuestions } from "./contracts";

type AnswerForQuestion<Question extends JevQuestion> =
  Question extends { type: "noul" } ? Extract<JevAnswer, { type: "noul" }>
    : Question extends { type: "choice" } ? Extract<JevAnswer, { type: "choice" }>
      : Extract<JevAnswer, { type: "score" }>;

export interface JevDecisionResult<Questions extends JevQuestions = JevQuestions> {
  model: string;
  answers: { [Key in keyof Questions]: AnswerForQuestion<Questions[Key]> };
}

export type JevDecisionErrorCode =
  | "INVALID_REQUEST"
  | "NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "INVALID_PROVIDER_RESPONSE";

export class JevDecisionError extends Error {
  constructor(readonly code: JevDecisionErrorCode) {
    super(code);
    this.name = "JevDecisionError";
  }
}

/**
 * Reusable server-side JEV call. Callers provide a bounded state projection and
 * a server-owned question definition; browser input should never be forwarded
 * here as questions or as unfiltered state.
 */
export async function runJevDecision<Questions extends JevQuestions>(
  env: Pick<Env, "OPENROUTER_API_KEY" | "JEV_MODEL">,
  input: { state: string; questions: Questions },
  fetcher: typeof fetch = fetch,
): Promise<JevDecisionResult<Questions>> {
  if (typeof input.state !== "string") throw new JevDecisionError("INVALID_REQUEST");
  const stateBytes = new TextEncoder().encode(input.state).byteLength;
  const questions = JevQuestionsSchema.safeParse(input.questions);
  if (input.state.trim().length === 0 || stateBytes > MAX_STATE_BYTES || !questions.success) {
    throw new JevDecisionError("INVALID_REQUEST");
  }

  const apiKey = env.OPENROUTER_API_KEY?.trim();
  const model = env.JEV_MODEL?.trim() || DEFAULT_MODEL;
  if (!apiKey || model.length > 200) throw new JevDecisionError("NOT_CONFIGURED");

  const aborter = new AbortController();
  const timeout = setTimeout(() => aborter.abort(), PROVIDER_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher(DECISIONS_URL, {
        method: "POST",
        redirect: "error",
        signal: aborter.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ model, state: input.state, questions: questions.data }),
      });
    } catch {
      throw new JevDecisionError(aborter.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE");
    }
    if (!response.ok || !response.body) throw new JevDecisionError("PROVIDER_UNAVAILABLE");

    const payload = await readProviderPayload(response);
    return validateProviderPayload(payload, questions.data) as JevDecisionResult<Questions>;
  } finally {
    clearTimeout(timeout);
  }
}

async function readProviderPayload(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof JevDecisionError) throw error;
    throw new JevDecisionError("PROVIDER_UNAVAILABLE");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  }
}

function validateProviderPayload(value: unknown, questions: JevQuestions): JevDecisionResult {
  if (!isRecord(value) || typeof value.model !== "string" || value.model.length === 0 || value.model.length > 200 || !isRecord(value.answers)) {
    throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  }
  const expectedKeys = Object.keys(questions).sort();
  const answerKeys = Object.keys(value.answers).sort();
  if (expectedKeys.length !== answerKeys.length || expectedKeys.some((key, index) => key !== answerKeys[index])) {
    throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  }

  const answers: Record<string, JevAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const raw = value.answers[key];
    if (!isRecord(raw) || raw.type !== question.type) throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
    if (question.type === "noul") answers[key] = normalizeNoulAnswer(raw);
    else if (question.type === "choice") answers[key] = normalizeChoiceAnswer(raw, question);
    else answers[key] = normalizeScoreAnswer(raw, question);
  }
  return { model: value.model, answers };
}

function normalizeNoulAnswer(value: Record<string, unknown>): JevAnswer {
  if (!hasExactKeys(value, ["type", "noul"]) || !isProbability(value.noul)) {
    throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  }
  return {
    type: "noul",
    noul: value.noul,
    probabilities: { false: 1 - value.noul, true: value.noul },
    confidence: null,
  };
}

function normalizeChoiceAnswer(value: Record<string, unknown>, question: Extract<JevQuestion, { type: "choice" }>): JevAnswer {
  const allowedKeys = Object.keys(question.criteria).sort();
  if (!hasExactKeys(value, ["type", "choice", "probabilities", "confidence"])
    && !hasExactKeys(value, ["type", "choice", "probabilities"])) {
    throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  }
  if (typeof value.choice !== "string" || !allowedKeys.includes(value.choice)) {
    throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  }
  const probabilities = normalizeProbabilities(value.probabilities, allowedKeys);
  const confidence = optionalConfidence(value.confidence);
  return { type: "choice", choice: value.choice, probabilities, confidence };
}

function normalizeScoreAnswer(value: Record<string, unknown>, question: Extract<JevQuestion, { type: "score" }>): JevAnswer {
  const scoreKeys = question.criteria.map((_label, index) => String(index));
  if (!hasExactKeys(value, ["type", "score", "legend", "probabilities", "confidence"])
    && !hasExactKeys(value, ["type", "score", "legend", "probabilities"])) {
    throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  }
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > question.criteria.length - 1) {
    throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  }
  const legend = value.legend;
  if (!isRecord(legend) || !hasExactKeys(legend, scoreKeys)
    || scoreKeys.some((key, index) => legend[key] !== question.criteria[index])) {
    throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  }
  const probabilities = normalizeProbabilities(value.probabilities, scoreKeys);
  const confidence = optionalConfidence(value.confidence);
  return {
    type: "score",
    score: value.score,
    legend: Object.fromEntries(scoreKeys.map((key, index) => [key, question.criteria[index]])),
    probabilities,
    confidence,
  };
}

function normalizeProbabilities(value: unknown, expectedKeys: string[]): Record<string, number> {
  if (!isRecord(value) || !hasExactKeys(value, expectedKeys)) throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  const result: Record<string, number> = {};
  let total = 0;
  for (const key of expectedKeys) {
    const probability = value[key];
    if (!isProbability(probability)) throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
    result[key] = probability;
    total += probability;
  }
  if (Math.abs(total - 1) > 0.02) throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  return result;
}

function optionalConfidence(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!isProbability(value)) throw new JevDecisionError("INVALID_PROVIDER_RESPONSE");
  return value;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

import type { PublisherEntrypoint } from "./rpc-v1";

export type MockPublisherScenario =
  | "success"
  | "retryable_error"
  | "permanent_conflict"
  | "app_not_installed"
  | "github_permission_denied"
  | "lost_response"
  | "timeout"
  | "delay"
  | "wrong_publication_id"
  | "wrong_repository"
  | "wrong_branch"
  | "malformed_response";

const errorScenarios: Partial<Record<MockPublisherScenario, {
  code: "GITHUB_TIMEOUT" | "BASE_MOVED" | "APP_NOT_INSTALLED" | "GITHUB_PERMISSION_DENIED";
  classification: "retryable" | "conflict" | "policy";
}>> = {
  retryable_error: { code: "GITHUB_TIMEOUT", classification: "retryable" },
  permanent_conflict: { code: "BASE_MOVED", classification: "conflict" },
  app_not_installed: { code: "APP_NOT_INSTALLED", classification: "policy" },
  github_permission_denied: { code: "GITHUB_PERMISSION_DENIED", classification: "policy" },
};

/** Test-only idempotent RPC fake. It has no Worker binding or production configuration. */
export class MockPublisherEntrypoint implements PublisherEntrypoint {
  readonly calls: string[] = [];
  readonly rpcCredentials: Array<{ callerId: string; apiKey: string }> = [];
  readonly #script: Array<{ scenario: MockPublisherScenario; delayMs?: number }>;
  readonly #completed = new Map<string, { requestJson: string; result: unknown }>();

  constructor(scenarios: Array<MockPublisherScenario | { scenario: MockPublisherScenario; delayMs?: number }> = ["success"]) {
    this.#script = scenarios.map((scenario) => typeof scenario === "string" ? { scenario } : scenario);
  }

  async publish(requestJson: string, callerId: string, apiKey: string): Promise<unknown> {
    this.calls.push(requestJson);
    this.rpcCredentials.push({ callerId, apiKey });
    const request = JSON.parse(requestJson) as {
      publicationId: string;
      runId: string;
      repository: { owner: string; name: string };
      mode: "branch" | "pr";
      headRef: string;
    };
    const prior = this.#completed.get(request.publicationId);
    if (prior) {
      if (prior.requestJson !== requestJson) {
        return structuredError(request, "BRANCH_CONFLICT", "conflict");
      }
      return prior.result;
    }

    const next = this.#script.shift() ?? { scenario: "success" as const };
    const result = this.#result(request, next.scenario);
    if (next.scenario === "delay") await new Promise((resolve) => setTimeout(resolve, next.delayMs ?? 1));
    if (next.scenario === "timeout") {
      if (next.delayMs) await new Promise((resolve) => setTimeout(resolve, next.delayMs));
      throw new Error("mock RPC timed out");
    }
    if (next.scenario === "lost_response") {
      this.#completed.set(request.publicationId, { requestJson, result });
      throw new Error("mock RPC response was lost after GitHub mutation");
    }
    if (next.scenario === "success" || next.scenario === "wrong_publication_id"
      || next.scenario === "wrong_repository" || next.scenario === "wrong_branch" || next.scenario === "delay") {
      this.#completed.set(request.publicationId, { requestJson, result });
    }
    return result;
  }

  #result(request: {
    publicationId: string;
    runId: string;
    repository: { owner: string; name: string };
    mode: "branch" | "pr";
    headRef: string;
  }, scenario: MockPublisherScenario): unknown {
    const errorScenario = errorScenarios[scenario];
    if (errorScenario) return structuredError(request, errorScenario.code, errorScenario.classification);
    if (scenario === "malformed_response") return { contractVersion: "1", outcome: "success" };

    const repository = scenario === "wrong_repository"
      ? { owner: "another-owner", name: "another-repository" }
      : request.repository;
    const common = {
      contractVersion: "1",
      publicationId: scenario === "wrong_publication_id" ? "018f0000-0000-7000-8000-000000000001" : request.publicationId,
      runId: request.runId,
      repository,
      mode: request.mode,
      retryable: false,
      reconciliation: "not_needed",
    };
    const branch = {
      ref: scenario === "wrong_branch" ? "kirisame/p/018f0000-0000-7000-8000-000000000001" : request.headRef,
      commitSha: "b".repeat(40),
      reused: false,
    };
    if (request.mode === "branch") return { ...common, outcome: "branch_published", branch };
    return {
      ...common,
      outcome: "pr_published",
      branch,
      pullRequest: {
        number: 17,
        url: `https://github.com/${repository.owner}/${repository.name}/pull/17`,
        state: "open",
      },
    };
  }
}

function structuredError(
  request: { publicationId: string; runId: string; repository: { owner: string; name: string }; mode: "branch" | "pr" },
  code: "GITHUB_TIMEOUT" | "BASE_MOVED" | "BRANCH_CONFLICT" | "APP_NOT_INSTALLED" | "GITHUB_PERMISSION_DENIED",
  classification: "retryable" | "conflict" | "policy",
) {
  return {
    contractVersion: "1",
    publicationId: request.publicationId,
    runId: request.runId,
    repository: request.repository,
    mode: request.mode,
    outcome: classification === "retryable" ? "retryable_failure" : "blocked",
    retryable: classification === "retryable",
    reconciliation: classification === "retryable" ? "unknown" : classification === "conflict" ? "conflict" : "not_needed",
    error: { code, classification, message: "Mock publisher response." },
  };
}

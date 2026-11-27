import assert from "node:assert/strict";
import { after, test } from "node:test";
import { resolve } from "node:path";
import { createTestHarness, type WorkerHandle } from "wrangler";
import { createOpenRouterFaultResponse, OPENROUTER_TEST_FAILURE_MARKER, type OpenRouterFaultScenario } from "./test-support/provider-faults.ts";

const SENKU_TOKEN = "senku-soyuz-cross-worker-test-token-000000";
const KASEKI_TOKEN = "senku-kaseki-cross-worker-test-token-000000";
const PROVIDER_KEY = "synthetic-openrouter-test-key";
const TASK_MARKER = "SYNTHETIC_TASK_PROMPT_MUST_STAY_IN_SOYUZ";
const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const senkuConfig = process.env.SENKU_WRANGLER_CONFIG;

type ProviderScenario = "success" | "http_503" | "http_429" | "http_429_retry" | "malformed_json" | "timeout";

let server: ReturnType<typeof createTestHarness> | undefined;
let originalFetch: typeof fetch | undefined;
let providerCalls = 0;
let providerRequest: Record<string, unknown> | undefined;
let providerScenario: ProviderScenario = "success";

after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  if (server) await server.close();
});

test("Soyuz maps OpenRouter faults across the authenticated Senku Service Binding", {
  skip: senkuConfig ? false : "Set SENKU_WRANGLER_CONFIG to the Senku worktree wrangler.jsonc path.",
}, async (t) => {
  if (!senkuConfig) return;

  server = createTestHarness({
    root: process.cwd(),
    workers: [
      {
        configPath: "./wrangler.jsonc",
        bindingOverrides: { SENKU: "senku", KIRISAME: "kirisame-fixture" },
        vars: {
          SOYUZ_ENVIRONMENT: "development",
          SOYUZ_PUBLIC_URL: "https://soyuz.test",
          SOYUZ_OAUTH_ALLOWED_GITHUB_IDS: "68898852,68898853",
        },
        secrets: {
          CLIENT_API_TOKEN: "soyuz-cross-worker-client-test-token-000000",
          WORKER_API_TOKEN: "soyuz-cross-worker-worker-test-token-000000",
          SENKU_SOYUZ_API_TOKEN: SENKU_TOKEN,
          GITHUB_OAUTH_CLIENT_ID: "soyuz-cross-worker-client-id",
          GITHUB_OAUTH_CLIENT_SECRET: "soyuz-cross-worker-client-secret",
        },
      },
      {
        configPath: resolve(senkuConfig),
        vars: {
          SENKU_PROVIDER_TIMEOUT_MS: "2500",
          SENKU_PROVIDER_REQUEST_URL: OPENROUTER_URL,
        },
        secrets: {
          SENKU_PROVIDER_AUTHORIZATION: `Bearer ${PROVIDER_KEY}`,
          SENKU_SOYUZ_API_TOKEN: SENKU_TOKEN,
          SENKU_KASEKI_API_TOKEN: KASEKI_TOKEN,
        },
      },
      {
        config: {
          name: "kirisame-fixture",
          main: "scripts/kirisame-fixture-worker.mjs",
          compatibility_date: "2026-10-02",
        },
      },
      {
        config: {
          name: "soyuz-oauth-fixture",
          main: "scripts/oauth-fixture-worker.mjs",
          compatibility_date: "2026-10-02",
          kv_namespaces: [{ binding: "OAUTH_KV", id: "bbaeb9b98b8746818193a5eac9e69f88" }],
        },
      },
    ],
  });

  await server.listen();
  const soyuz = server.getWorker("soyuz");
  await soyuz.applyD1Migrations("DB");
  const env = await soyuz.getEnv();

  const oauthFixture = server.getWorker("soyuz-oauth-fixture");
  const accessToken = await mintAccessToken(oauthFixture, soyuz, "68898852");

  const runResponse = await soyuz.fetch("https://soyuz.test/v1/runs", {
    method: "POST",
    headers: {
      authorization: "Bearer soyuz-cross-worker-client-test-token-000000",
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      repoUrl: "https://example.invalid/synthetic.git",
      taskPrompt: TASK_MARKER,
      taskMode: "inspect",
      publishMode: "none",
    }),
  });
  const runBody = await runResponse.json() as { data?: { id?: string } };
  assert.equal(runResponse.status, 202);
  const runId = runBody.data?.id;
  assert.ok(runId, "Soyuz should retain the synthetic run before analysis");
  const before = await env.DB.prepare("SELECT status, stage FROM runs WHERE id = ?").bind(runId).first();

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url !== OPENROUTER_URL) {
      throw new Error("The cross-worker test blocks all external requests except its OpenRouter mock.");
    }

    providerCalls += 1;
    providerRequest = await request.clone().json() as Record<string, unknown>;
    switch (providerScenario) {
      case "http_429":
        return new Response(null, { status: 429, headers: { "retry-after": "7" } });
      case "http_429_retry":
        if (providerCalls === 1) {
          return new Response(null, { status: 429, headers: { "retry-after": "1" } });
        }
        return createProviderSuccessResponse(providerRequest);
      case "http_503":
      case "malformed_json":
      case "timeout":
        return createOpenRouterFaultResponse(
          request,
          providerScenario as OpenRouterFaultScenario,
          10_000,
        );
      case "success":
        return createProviderSuccessResponse(providerRequest);
    }
  };

  const scenarios: Array<{
    name: string;
    providerScenario: ProviderScenario;
    status: number;
    expectedProviderCalls: number;
    errorCode?: string;
  }> = [
    { name: "success returns the compatible dashboard shape", providerScenario: "success", status: 200, expectedProviderCalls: 1 },
    { name: "provider 429 maps to a rate-limited response with Retry-After", providerScenario: "http_429", status: 429, expectedProviderCalls: 1, errorCode: "JEV_PROVIDER_RATE_LIMITED" },
    { name: "provider 429 retries once inside Senku and returns success", providerScenario: "http_429_retry", status: 200, expectedProviderCalls: 2 },
    { name: "provider 503 maps to a safe unavailable response", providerScenario: "http_503", status: 502, expectedProviderCalls: 1, errorCode: "JEV_PROVIDER_UNAVAILABLE" },
    { name: "malformed provider JSON maps to an invalid response", providerScenario: "malformed_json", status: 502, expectedProviderCalls: 1, errorCode: "JEV_RESPONSE_INVALID" },
    { name: "provider timeout aborts and maps to a timeout response", providerScenario: "timeout", status: 504, expectedProviderCalls: 1, errorCode: "JEV_PROVIDER_TIMEOUT" },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      providerScenario = scenario.providerScenario;
      providerCalls = 0;
      providerRequest = undefined;
      const scenarioAccessToken = scenario.providerScenario === "timeout"
        ? await mintAccessToken(oauthFixture, soyuz, "68898853")
        : accessToken;

      const decisionResponse = await soyuz.fetch("https://soyuz.test/dashboard/api/analysis/decisions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${scenarioAccessToken}`,
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.10",
        },
        body: JSON.stringify({ profileId: "run_operations_triage_v1", runId }),
      });
      const decisionBody = await decisionResponse.json() as {
        data?: { model?: string; answers?: Record<string, unknown> };
        error?: { code?: string; message?: string };
      };

      if (decisionResponse.status !== scenario.status) {
        console.error("Cross-Worker diagnostics", server?.getLogs());
      }
      assert.equal(decisionResponse.status, scenario.status, JSON.stringify(decisionBody));
      if (scenario.errorCode) {
        assert.equal(decisionBody.error?.code, scenario.errorCode);
        if (scenario.providerScenario === "http_429") assert.equal(decisionResponse.headers.get("retry-after"), "7");
      } else {
        assert.equal(decisionBody.data?.model, "typesafe/jev-cross-worker-test");
        assert.deepEqual(Object.keys(decisionBody.data ?? {}).sort(), ["answers", "model"]);
      }
      assert.equal(providerCalls, scenario.expectedProviderCalls);
      const sentProviderRequest = latestProviderRequest();
      assert.ok(sentProviderRequest);
      assert.equal(sentProviderRequest.model, "~typesafe/jev-latest");
      const state = JSON.parse(String(sentProviderRequest.state)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(state).sort(), ["run", "source"]);
      assert.equal((state.run as Record<string, unknown>).status, "queued");
      assert.equal(JSON.stringify(sentProviderRequest).includes(TASK_MARKER), false, "raw task prompts stay inside Soyuz");
      assert.equal(JSON.stringify(decisionBody).includes(OPENROUTER_TEST_FAILURE_MARKER), false, "upstream bodies stay out of API responses");

      const afterRun = await env.DB.prepare("SELECT status, stage FROM runs WHERE id = ?").bind(runId).first();
      assert.deepEqual(afterRun, before, "advisory JEV success and failure must not change run state");
    });
  }

  const logs = server.getLogs();
  const successfulSenkuLogs = logs.filter((log) => log.message.includes('"event":"profile.evaluation_completed"'));
  assert.equal(successfulSenkuLogs.length, 2, "only completed provider scenarios emit profile.evaluation_completed");
  const completedProviderAttempts = successfulSenkuLogs
    .map((log) => JSON.parse(log.message) as { attemptCount?: number })
    .map((log) => log.attemptCount)
    .sort();
  assert.deepEqual(completedProviderAttempts, [1, 2]);
  assert.equal(successfulSenkuLogs[0].message.includes('"clientId":"soyuz"'), true);
  assert.equal(JSON.stringify(logs).includes(SENKU_TOKEN), false, "machine credentials stay out of logs");
  assert.equal(JSON.stringify(logs).includes(PROVIDER_KEY), false, "provider credentials stay out of logs");
  assert.equal(JSON.stringify(logs).includes(OPENROUTER_TEST_FAILURE_MARKER), false, "upstream bodies stay out of logs");
});

type FetchableTestWorker = Pick<WorkerHandle, "fetch">;

async function mintAccessToken(
  oauthFixture: FetchableTestWorker,
  soyuz: FetchableTestWorker,
  githubUserId: string,
): Promise<string> {
  const fixtureResponse = await oauthFixture.fetch(`http://soyuz-oauth-fixture/mint?githubUserId=${githubUserId}`);
  const fixture = await fixtureResponse.json() as { clientId: string; code: string; redirectUri: string; verifier: string };
  assert.equal(fixtureResponse.status, 200);

  const tokenResponse = await soyuz.fetch("https://soyuz.test/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: fixture.code,
      client_id: fixture.clientId,
      redirect_uri: fixture.redirectUri,
      code_verifier: fixture.verifier,
      resource: "https://soyuz.test/",
    }),
  });
  const tokenBody = await tokenResponse.json() as { access_token?: string };
  assert.equal(tokenResponse.status, 200);
  assert.ok(tokenBody.access_token, "OAuth should exchange the code for a read-scope token");
  return tokenBody.access_token;
}

function latestProviderRequest(): Record<string, unknown> | undefined {
  return providerRequest;
}

function createProviderSuccessResponse(providerRequest: Record<string, unknown> | undefined): Response {
  assert.ok(providerRequest);
  const questions = providerRequest.questions as Record<string, Record<string, unknown>>;
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      answers[key] = { type: "noul", noul: 0.8 };
    } else if (question.type === "choice") {
      const choices = Object.keys(question.criteria as Record<string, unknown>);
      answers[key] = {
        type: "choice",
        choice: choices[0],
        probabilities: Object.fromEntries(choices.map((choice, index) => [choice, index === 0 ? 1 : 0])),
        confidence: null,
      };
    } else {
      const criteria = question.criteria as unknown[];
      const scoreKeys = criteria.map((_criterion, index) => String(index));
      answers[key] = {
        type: "score",
        score: 0,
        legend: Object.fromEntries(criteria.map((criterion, index) => [String(index), criterion])),
        probabilities: Object.fromEntries(scoreKeys.map((score, index) => [score, index === 0 ? 1 : 0])),
        confidence: null,
      };
    }
  }
  return new Response(JSON.stringify({ model: "typesafe/jev-cross-worker-test", answers, usage: { input_tokens: 10, output_tokens: 5 } }), {
    headers: { "content-type": "application/json" },
  });
}

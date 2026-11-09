import assert from "node:assert/strict";
import { after, test } from "node:test";
import { resolve } from "node:path";
import { createTestHarness } from "wrangler";

const SENKU_TOKEN = "senku-soyuz-cross-worker-test-token-000000";
const KASEKI_TOKEN = "senku-kaseki-cross-worker-test-token-000000";
const PROVIDER_KEY = "synthetic-openrouter-test-key";
const TASK_MARKER = "SYNTHETIC_TASK_PROMPT_MUST_STAY_IN_SOYUZ";
const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const senkuConfig = process.env.SENKU_WRANGLER_CONFIG;

let server: ReturnType<typeof createTestHarness> | undefined;
let originalFetch: typeof fetch | undefined;
let providerCalls = 0;
let providerRequest: Record<string, unknown> | undefined;

after(async () => {
  if (server) await server.close();
  if (originalFetch) globalThis.fetch = originalFetch;
});

test("Soyuz calls the authenticated Senku Worker over its configured Service Binding", {
  skip: senkuConfig ? false : "Set SENKU_WRANGLER_CONFIG to the Senku worktree wrangler.jsonc path.",
}, async () => {
  if (!senkuConfig) return;

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url !== OPENROUTER_URL) {
      throw new Error("The cross-worker test blocks all external requests except its OpenRouter mock.");
    }

    providerCalls += 1;
    providerRequest = await request.clone().json() as Record<string, unknown>;
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
  };

  server = createTestHarness({
    root: process.cwd(),
    workers: [
      {
        configPath: "./wrangler.jsonc",
        bindingOverrides: { SENKU: "senku" },
        vars: { SOYUZ_ENVIRONMENT: "development", SOYUZ_PUBLIC_URL: "https://soyuz.test" },
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
        secrets: {
          OPENROUTER_API_KEY: PROVIDER_KEY,
          SENKU_SOYUZ_API_TOKEN: SENKU_TOKEN,
          SENKU_KASEKI_API_TOKEN: KASEKI_TOKEN,
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
  const fixtureResponse = await oauthFixture.fetch("http://soyuz-oauth-fixture/mint");
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

  const decisionResponse = await soyuz.fetch("https://soyuz.test/dashboard/api/analysis/decisions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenBody.access_token}`,
      "content-type": "application/json",
      "cf-connecting-ip": "198.51.100.10",
    },
    body: JSON.stringify({ profileId: "run_operations_triage_v1", runId }),
  });
  const decisionBody = await decisionResponse.json() as {
    data?: { model?: string; answers?: Record<string, unknown> };
  };
  if (decisionResponse.status !== 200) console.error("Cross-Worker diagnostics", server.getLogs());
  assert.equal(decisionResponse.status, 200, JSON.stringify(decisionBody));
  assert.equal(decisionBody.data?.model, "typesafe/jev-cross-worker-test");
  assert.deepEqual(Object.keys(decisionBody.data ?? {}).sort(), ["answers", "model"]);
  assert.equal(providerCalls, 1, "the Service Binding must make exactly one provider attempt");
  assert.equal(providerRequest?.model, "~typesafe/jev-latest");
  const state = JSON.parse(String(providerRequest?.state)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(state).sort(), ["run", "source"]);
  assert.equal((state.run as Record<string, unknown>).status, "queued");
  assert.deepEqual(Object.keys(state.run as Record<string, unknown>).sort(), [
    "completedAt", "createdAt", "failureClass", "lastHeartbeatAt", "operationalHealth",
    "queuedAt", "stage", "startedAt", "status",
  ]);
  assert.equal(JSON.stringify(providerRequest).includes(TASK_MARKER), false, "raw task prompts stay inside Soyuz");
  const logs = server.getLogs();
  const successfulSenkuLogs = logs.filter((log) => log.message.includes('"event":"profile.evaluation_completed"'));
  assert.equal(successfulSenkuLogs.length, 1);
  assert.equal(successfulSenkuLogs[0].message.includes('"clientId":"soyuz"'), true);
  assert.equal(JSON.stringify(logs).includes(SENKU_TOKEN), false, "machine credentials stay out of logs");

  const afterRun = await env.DB.prepare("SELECT status, stage FROM runs WHERE id = ?").bind(runId).first();
  assert.deepEqual(afterRun, before, "advisory JEV analysis must not change run state");
});

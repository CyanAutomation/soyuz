import { pathToFileURL } from "node:url";

const ACTIVE_STATUSES = ["admitting", "queued", "claimed", "running", "cancel_requested"];
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "admission_failed"]);
const MAX_RESPONSE_BYTES = 1_000_000;
const TASK_PROMPT = "Inspect the repository root and return a short summary of its purpose. Do not modify files, install dependencies, or publish changes.";

export class SoyuzSmokeError extends Error {
  constructor(code, safeMessage) {
    super(safeMessage);
    this.name = "SoyuzSmokeError";
    this.code = code;
  }
}

export async function runProductionSmoke({
  env = process.env,
  fetchImpl = fetch,
  execute = false,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  log = (message) => console.log(message),
} = {}) {
  const config = readConfig(env, execute);
  const visibleQueueMessages = await runPreflight(config, fetchImpl, log);
  if (!execute) return { status: "preflight_passed", visibleQueueMessages };
  return runSmokeExecution(config, fetchImpl, { sleep, now, log, visibleQueueMessages });
}

async function runPreflight(config, fetchImpl, log) {
  await checkWorkerHealth(config, fetchImpl);
  await ensureNoActiveRuns(config, fetchImpl);
  const queueBase = queueApiBase(config);
  const queueHeaders = { authorization: `Bearer ${config.queueToken}` };
  await ensureSafeQueueConsumer(fetchImpl, queueBase, queueHeaders);
  const visibleQueueMessages = await countVisibleQueueMessages(fetchImpl, queueBase, queueHeaders);
  log("Preflight passed: Worker healthy, no active runs, Queue HTTP pull/DLQ configured, and Queue peek empty.");
  return visibleQueueMessages;
}

async function checkWorkerHealth(config, fetchImpl) {
  const health = await requestJson(fetchImpl, `${config.baseUrl}/health`);
  if (health.status !== "ok" || health.contractVersion !== "1") {
    throw new SoyuzSmokeError("WORKER_UNHEALTHY", "Soyuz /health did not report a healthy contract-v1 Worker.");
  }
}

async function ensureNoActiveRuns(config, fetchImpl) {
  for (const status of ACTIVE_STATUSES) {
    const page = await requestJson(fetchImpl, `${config.baseUrl}/v1/runs?status=${encodeURIComponent(status)}&limit=1`, {
      headers: { authorization: `Bearer ${config.clientToken}` },
    });
    if (!Array.isArray(page.data?.runs)) throw new SoyuzSmokeError("RUN_LIST_INVALID", "Soyuz returned an invalid active-run list.");
    if (page.data.runs.length > 0) {
      throw new SoyuzSmokeError("ACTIVE_RUNS_PRESENT", "Active Soyuz runs exist; review them before starting a smoke run.");
    }
  }
}

function queueApiBase(config) {
  return `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/queues/${config.queueId}`;
}

async function ensureSafeQueueConsumer(fetchImpl, queueBase, queueHeaders) {
  const consumerResponse = await requestJson(fetchImpl, `${queueBase}/consumers`, { headers: queueHeaders });
  if (!consumerResponse.success || !Array.isArray(consumerResponse.result)) {
    throw new SoyuzSmokeError("QUEUE_CONSUMER_READ_FAILED", "Cloudflare did not return Queue consumer configuration.");
  }
  const safePullConsumer = consumerResponse.result.some((consumer) =>
    consumer?.type === "http_pull"
    && typeof consumer.dead_letter_queue === "string"
    && consumer.dead_letter_queue.trim().length > 0);
  if (!safePullConsumer) {
    throw new SoyuzSmokeError("QUEUE_CONSUMER_UNSAFE", "Soyuz Queue needs an HTTP pull consumer with a dead-letter queue.");
  }
}

async function countVisibleQueueMessages(fetchImpl, queueBase, queueHeaders) {
  const peek = await requestJson(fetchImpl, `${queueBase}/messages/peek`, {
    method: "POST",
    headers: queueHeaders,
    body: JSON.stringify({ batch_size: 10 }),
  });
  if (!peek.success || !Array.isArray(peek.result?.messages)) {
    throw new SoyuzSmokeError("QUEUE_PEEK_FAILED", "Cloudflare Queue peek did not return a message list.");
  }
  const visibleQueueMessages = peek.result.messages.length;
  if (visibleQueueMessages > 0) {
    throw new SoyuzSmokeError("QUEUE_NOT_EMPTY", "Soyuz Queue has visible messages; review ownership before submitting a smoke run.");
  }
  return visibleQueueMessages;
}

async function runSmokeExecution(config, fetchImpl, { sleep, now, log, visibleQueueMessages }) {
  const runId = await submitSmokeRun(config, fetchImpl, log);
  return pollSmokeRun(config, fetchImpl, runId, { sleep, now, log, visibleQueueMessages });
}

async function submitSmokeRun(config, fetchImpl, log) {
  const submission = await requestJson(fetchImpl, `${config.baseUrl}/v1/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.clientToken}`,
      "content-type": "application/json",
      "idempotency-key": config.idempotencyKey,
    },
    body: JSON.stringify({
      repoUrl: config.repoUrl,
      taskPrompt: TASK_PROMPT,
      taskMode: "inspect",
      publishMode: "none",
      timeoutSeconds: config.runTimeoutSeconds,
      idempotencyKey: config.idempotencyKey,
    }),
  }, [200, 202]);
  const runId = submission.data?.id;
  if (typeof runId !== "string" || !isUuid(runId)) {
    throw new SoyuzSmokeError("RUN_ID_INVALID", "Soyuz did not return a valid run ID. Reuse the same idempotency key when checking the outcome.");
  }
  log(`Smoke run submitted: ${runId}`);
  return runId;
}

async function pollSmokeRun(config, fetchImpl, runId, { sleep, now, log, visibleQueueMessages }) {
  const deadline = now() + config.maxWaitSeconds * 1_000;
  let lastStatus = "unknown";
  while (now() < deadline) {
    const [runResponse, workerResponse] = await Promise.all([
      requestJson(fetchImpl, `${config.baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
        headers: { authorization: `Bearer ${config.clientToken}` },
      }),
      requestJson(fetchImpl, `${config.baseUrl}/v1/worker/runs/${encodeURIComponent(runId)}`, {
        headers: { authorization: `Bearer ${config.workerToken}` },
      }),
    ]);
    const run = runResponse.data;
    const workerRun = workerResponse.data;
    if (!run || typeof run.status !== "string" || workerRun?.runId !== runId) {
      throw new SoyuzSmokeError("RUN_READ_INVALID", "Soyuz returned an invalid run status response.");
    }
    lastStatus = run.status;

    if (TERMINAL_STATUSES.has(run.status) && workerRun.status === run.status) {
      if (run.status === "completed") return verifyCompletedSmokeRun(config, fetchImpl, run, runId, log, visibleQueueMessages);
      log(`Smoke run ended in ${run.status} (class=${run.failureClass ?? "unknown"}): ${runId}`);
      return { status: run.status, runId, failureClass: run.failureClass ?? null, visibleQueueMessages };
    }

    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(config.pollIntervalMs, remaining));
  }

  log(`Smoke run did not reach a terminal state before timeout (status=${lastStatus}): ${runId}. It was not cancelled; inspect canonical state before taking action.`);
  return { status: "timed_out", runId, lastStatus, visibleQueueMessages };
}

async function verifyCompletedSmokeRun(config, fetchImpl, run, runId, log, visibleQueueMessages) {
  const eventsResponse = await requestJson(fetchImpl, `${config.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events?after=0&limit=100`, {
    headers: { authorization: `Bearer ${config.clientToken}` },
  });
  const types = new Set(eventsResponse.data?.events?.map((event) => event.type));
  if (!types.has("run.started") || !types.has("run.completed")) {
    throw new SoyuzSmokeError("CALLBACKS_NOT_VERIFIED", "Run completed without both start and completion events.");
  }
  if (run.publishMode !== "none" || run.result?.publishedUrl) {
    throw new SoyuzSmokeError("UNEXPECTED_PUBLICATION", "Smoke run did not preserve the no-publication setting.");
  }
  log(`Smoke run completed: ${runId}; start/completion callbacks recorded; no publication occurred.`);
  return { status: "completed", runId, visibleQueueMessages };
}

function readConfig(env, execute) {
  const baseUrl = parseBaseUrl(required(env, "SOYUZ_BASE_URL"));
  const clientToken = requiredToken(env, "CLIENT_API_TOKEN");
  const workerToken = requiredToken(env, "SOYUZ_WORKER_API_TOKEN");
  const queueToken = requiredToken(env, "SOYUZ_QUEUE_API_TOKEN");
  const accountId = required(env, "CLOUDFLARE_ACCOUNT_ID");
  const queueId = required(env, "SOYUZ_QUEUE_ID");
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !/^[a-f0-9]{32}$/i.test(queueId)) {
    throw new SoyuzSmokeError("CONFIG_INVALID", "CLOUDFLARE_ACCOUNT_ID and SOYUZ_QUEUE_ID must be 32-character hexadecimal IDs.");
  }

  const config = { baseUrl, clientToken, workerToken, queueToken, accountId, queueId };
  return execute ? { ...config, ...readExecutionConfig(env) } : config;
}

function parseBaseUrl(baseUrlRaw) {
  try {
    const parsed = new URL(baseUrlRaw);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
      throw new Error("scheme");
    }
    if (parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("url components");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new SoyuzSmokeError("CONFIG_INVALID", "SOYUZ_BASE_URL must be an HTTPS URL without credentials, query, or fragment.");
  }
}

function readExecutionConfig(env) {
  if (env.SOYUZ_SMOKE_ACK_EXECUTION !== "yes") {
    throw new SoyuzSmokeError("EXECUTION_NOT_ACKNOWLEDGED", "Set SOYUZ_SMOKE_ACK_EXECUTION=yes only after authorizing one bounded, non-publishing run.");
  }

  const repoUrl = required(env, "DISPOSABLE_REPO_URL");
  validateRepositoryUrl(repoUrl);
  const idempotencyKey = required(env, "SMOKE_IDEMPOTENCY_KEY");
  if (!isUuid(idempotencyKey)) throw new SoyuzSmokeError("CONFIG_INVALID", "SMOKE_IDEMPOTENCY_KEY must be a UUID.");
  const runTimeoutSeconds = boundedInteger(env.SOYUZ_SMOKE_TIMEOUT_SECONDS, 180, 60, 600, "SOYUZ_SMOKE_TIMEOUT_SECONDS");
  const maxWaitSeconds = boundedInteger(env.SOYUZ_SMOKE_MAX_WAIT_SECONDS, runTimeoutSeconds + 120, runTimeoutSeconds, 1_800, "SOYUZ_SMOKE_MAX_WAIT_SECONDS");
  const pollIntervalMs = boundedInteger(env.SOYUZ_SMOKE_POLL_INTERVAL_MS, 5_000, 1_000, 30_000, "SOYUZ_SMOKE_POLL_INTERVAL_MS");
  return { repoUrl, idempotencyKey, runTimeoutSeconds, maxWaitSeconds, pollIntervalMs };
}

function validateRepositoryUrl(repoUrl) {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("url");
  } catch {
    throw new SoyuzSmokeError("CONFIG_INVALID", "DISPOSABLE_REPO_URL must be an HTTPS repository URL without embedded credentials.");
  }
}

async function requestJson(fetchImpl, url, init = {}, acceptedStatuses = [200]) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new SoyuzSmokeError("REQUEST_FAILED", "A readiness request could not reach Soyuz or Cloudflare.");
  }
  const text = await readResponseText(response);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SoyuzSmokeError("RESPONSE_INVALID", "A readiness endpoint returned invalid JSON.");
  }
  if (!acceptedStatuses.includes(response.status)) {
    const code = typeof data.error?.code === "string" ? data.error.code : `HTTP_${response.status}`;
    throw new SoyuzSmokeError("REQUEST_REJECTED", `A readiness endpoint rejected the request (${code}).`);
  }
  return data;
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new SoyuzSmokeError("CONFIG_INVALID", `${name} is required.`);
  return value;
}

function requiredToken(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length < 16 || value.length > 1_024 || value.trim() !== value) {
    throw new SoyuzSmokeError("CONFIG_INVALID", `${name} must be a non-whitespace token between 16 and 1024 characters.`);
  }
  return value;
}

async function readResponseText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the size-limit error if the response stream also fails to cancel.
        }
        throw new SoyuzSmokeError("RESPONSE_TOO_LARGE", "A readiness endpoint returned an oversized response.");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof SoyuzSmokeError) throw error;
    throw new SoyuzSmokeError("RESPONSE_INVALID", "A readiness endpoint returned an unreadable response.");
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SoyuzSmokeError("CONFIG_INVALID", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function runSmokeCli(args, { run = runProductionSmoke, writeError = (message) => console.error(message) } = {}) {
  if (args.some((argument) => argument !== "--run")) {
    writeError("Usage: node scripts/soyuz-production-smoke.mjs [--run]");
    return 2;
  }
  try {
    const result = await run({ execute: args.includes("--run") });
    return isSuccessfulSmokeResult(result) ? 0 : 1;
  } catch (error) {
    const code = error instanceof SoyuzSmokeError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof SoyuzSmokeError ? error.message : "The smoke check stopped unexpectedly.";
    writeError(`Soyuz smoke check failed (${code}): ${message}`);
    return 1;
  }
}

function isSuccessfulSmokeResult(result) {
  return result.status === "preflight_passed" || result.status === "completed";
}

async function main() {
  process.exitCode = await runSmokeCli(process.argv.slice(2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();

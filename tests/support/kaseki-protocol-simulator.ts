import { handleRequest } from "../../src/index";
import type { Env } from "../../src/env";
import { CONTRACT_VERSION, type QueuedRun } from "../../src/contracts/queue-message";
import { RunRequestSchema } from "../../src/contracts/run-request";
import { isUuid } from "../../src/lib/uuid";

export interface KasekiJobIntent {
  runId: string;
  workerId: string;
  claimCallbackId: string;
  startedCallbackId: string;
  startedAt: string;
  heartbeatEventId: string;
  heartbeatAt: string;
  completedCallbackId: string;
  completedAt: string;
  cancelledCallbackId: string;
  cancelledAt: string;
}

export interface KasekiSimulatorRequest {
  method: string;
  path: string;
  body?: unknown;
}

interface ApiResult {
  status: number;
  body: { data?: Record<string, any>; error?: { code?: string; message?: string } };
}

/**
 * A protocol-only Kaseki host used by Soyuz tests. It accepts the published
 * queue envelope and exercises worker routes, but does not run Kaseki's
 * scheduler, admission checks, containers, repository code, or publisher.
 */
export class KasekiProtocolSimulator {
  readonly requests: KasekiSimulatorRequest[] = [];

  constructor(
    private readonly env: Env,
    private readonly workerId: string,
    private readonly durableIntents: Map<string, KasekiJobIntent> = new Map(),
  ) {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(workerId)) {
      throw new Error("The simulated worker ID must be a valid stable host ID.");
    }
  }

  /**
   * Accept one queue delivery. `durableIntents` stands in for the host's
   * persistent job index so a new simulator instance can model restart.
   */
  async deliver(
    messageValue: unknown,
    options: { loseFirstClaimResponse?: boolean; stopAfterClaim?: boolean } = {},
  ): Promise<KasekiJobIntent & { status: string }> {
    const message = parseQueueMessage(messageValue);
    let intent = this.durableIntents.get(message.runId);
    if (!intent) {
      intent = createIntent(message.runId, this.workerId);
      // Persist intent before calling Soyuz, matching the handoff contract.
      this.durableIntents.set(message.runId, intent);
    }
    if (intent.workerId !== this.workerId) {
      throw new Error("A saved job intent cannot move to a different worker ID.");
    }

    const canonicalRun = await this.readWorkerRun(intent.runId);
    if (isTerminal(canonicalRun.status) || canonicalRun.status === "cancel_requested") {
      return { ...intent, status: canonicalRun.status };
    }

    const claim = {
      contractVersion: CONTRACT_VERSION,
      callbackId: intent.claimCallbackId,
      workerId: intent.workerId,
    };
    let claimResult = await this.api("POST", `/v1/worker/runs/${intent.runId}/claim`, claim);
    if (options.loseFirstClaimResponse) {
      // The first request has committed in Soyuz; the host discards its
      // response and retries the identical intent and callback ID.
      claimResult = await this.api("POST", `/v1/worker/runs/${intent.runId}/claim`, claim);
    }
    requireSuccess(claimResult, "claim");

    let workerRun = await this.readWorkerRun(intent.runId);
    if (workerRun.claimCallbackId !== intent.claimCallbackId || workerRun.workerId !== intent.workerId) {
      throw new Error("Soyuz returned a different worker claim than the saved Kaseki intent.");
    }
    if (options.stopAfterClaim) return { ...intent, status: workerRun.status };

    if (workerRun.status !== "claimed" && workerRun.status !== "running") {
      throw new Error(`Soyuz run is ${workerRun.status}; the simulator cannot start it.`);
    }

    const started = await this.api("POST", `/v1/worker/runs/${intent.runId}/started`, {
      contractVersion: CONTRACT_VERSION,
      callbackId: intent.startedCallbackId,
      claimCallbackId: intent.claimCallbackId,
      workerId: intent.workerId,
      startedAt: intent.startedAt,
      stage: "prepare",
    });
    requireSuccess(started, "started");
    workerRun = await this.readWorkerRun(intent.runId);
    return { ...intent, status: workerRun.status };
  }

  async readWorkerRun(runId: string): Promise<Record<string, any>> {
    const result = await this.api("GET", `/v1/worker/runs/${runId}`);
    requireSuccess(result, "worker read");
    return result.body.data!;
  }

  async sendHeartbeat(runId: string): Promise<void> {
    const intent = this.requireIntent(runId);
    const result = await this.api("POST", `/v1/worker/runs/${runId}/events`, {
      contractVersion: CONTRACT_VERSION,
      eventId: intent.heartbeatEventId,
      workerId: intent.workerId,
      claimCallbackId: intent.claimCallbackId,
      type: "worker.heartbeat",
      timestamp: intent.heartbeatAt,
      payload: {},
    });
    requireSuccess(result, "heartbeat");
  }

  async complete(runId: string, summary: string): Promise<void> {
    const intent = this.requireIntent(runId);
    const result = await this.api("POST", `/v1/worker/runs/${runId}/completed`, {
      contractVersion: CONTRACT_VERSION,
      callbackId: intent.completedCallbackId,
      claimCallbackId: intent.claimCallbackId,
      workerId: intent.workerId,
      completedAt: intent.completedAt,
      exitCode: 0,
      summary,
    });
    requireSuccess(result, "completion");
  }

  async pollAndConfirmCancellation(runId: string): Promise<boolean> {
    const intent = this.requireIntent(runId);
    const workerRun = await this.readWorkerRun(runId);
    if (workerRun.status !== "cancel_requested") return false;

    const result = await this.api("POST", `/v1/worker/runs/${runId}/cancelled`, {
      contractVersion: CONTRACT_VERSION,
      callbackId: intent.cancelledCallbackId,
      claimCallbackId: intent.claimCallbackId,
      workerId: intent.workerId,
      completedAt: intent.cancelledAt,
      reason: "The simulated execution host stopped the job after observing cancellation.",
    });
    requireSuccess(result, "cancellation");
    return true;
  }

  private requireIntent(runId: string): KasekiJobIntent {
    const intent = this.durableIntents.get(runId);
    if (!intent) throw new Error(`No simulated Kaseki job intent exists for ${runId}.`);
    return intent;
  }

  private async api(method: string, path: string, body?: unknown): Promise<ApiResult> {
    this.requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    const response = await handleRequest(new Request(`https://soyuz.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.env.WORKER_API_TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), this.env);
    return { status: response.status, body: await response.json() as ApiResult["body"] };
  }
}

function createIntent(runId: string, workerId: string): KasekiJobIntent {
  return {
    runId,
    workerId,
    claimCallbackId: crypto.randomUUID(),
    startedCallbackId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    heartbeatEventId: crypto.randomUUID(),
    heartbeatAt: new Date().toISOString(),
    completedCallbackId: crypto.randomUUID(),
    completedAt: new Date().toISOString(),
    cancelledCallbackId: crypto.randomUUID(),
    cancelledAt: new Date().toISOString(),
  };
}

function parseQueueMessage(value: unknown): QueuedRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Queue message must be an object.");
  }
  const message = value as Record<string, unknown>;
  if (message.contractVersion !== CONTRACT_VERSION) {
    throw new Error(`Unsupported Soyuz contract version: ${String(message.contractVersion)}.`);
  }
  if (
    typeof message.runId !== "string" || !isUuid(message.runId)
    || typeof message.correlationId !== "string" || !isUuid(message.correlationId)
    || typeof message.requestId !== "string" || !isUuid(message.requestId)
    || typeof message.createdAt !== "string" || Number.isNaN(Date.parse(message.createdAt))
    || !RunRequestSchema.safeParse(message.request).success
  ) {
    throw new Error("Queue message does not match the Soyuz contract-v1 run envelope.");
  }
  return message as unknown as QueuedRun;
}

function requireSuccess(result: ApiResult, operation: string): void {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Soyuz ${operation} failed (${result.status}): ${result.body.error?.code ?? "UNKNOWN_ERROR"}`);
  }
}

function isTerminal(status: unknown): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "admission_failed";
}

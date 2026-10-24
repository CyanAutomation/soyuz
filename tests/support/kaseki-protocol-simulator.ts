import { handleRequest } from "../../src/index";
import type { Env } from "../../src/env";
import { CONTRACT_VERSION, type QueuedRun } from "../../src/contracts/queue-message";
import { RunRequestSchema } from "../../src/contracts/run-request";
import { isUuid } from "../../src/lib/uuid";

export interface KasekiJobIntent {
  runId: string;
  workerId: string;
  claimCallbackId: string;
  claimAccepted: boolean;
  localJobPersisted: boolean;
  startedCallbackId: string;
  startedAt: string;
  startedCallbackSent: boolean;
  startAuthorized: boolean;
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

export interface KasekiPulledMessage {
  id: string;
  lease_id: string;
  timestamp_ms: number;
  attempts: number;
  body: unknown;
}

export type KasekiQueueAction =
  | { type: "ack"; id: string; leaseId: string; responseLost: boolean }
  | { type: "retry"; id: string; leaseId: string; delaySeconds: number };

export interface KasekiDeliveryResult {
  runId?: string;
  status?: string;
  intent?: KasekiJobIntent;
  startAuthorized?: boolean;
  disposition: "acknowledged" | "ack-uncertain" | "retried";
  retryDelaySeconds?: number;
  error?: string;
}

/** Records the same lease operations the host sends to Cloudflare's pull API. */
export class KasekiQueueLeaseHarness {
  readonly actions: KasekiQueueAction[] = [];

  acknowledge(message: KasekiPulledMessage, responseLost = false): void {
    this.actions.push({
      type: "ack",
      id: message.id,
      leaseId: message.lease_id,
      responseLost,
    });
  }

  retry(message: KasekiPulledMessage, delaySeconds: number): void {
    this.actions.push({
      type: "retry",
      id: message.id,
      leaseId: message.lease_id,
      delaySeconds,
    });
  }
}

interface ApiResult {
  status: number;
  body: { data?: unknown; error?: { code?: string; message?: string } };
}

/**
 * A protocol-only Kaseki host used by Soyuz tests. It accepts a Cloudflare
 * pull-lease body, persists a simulated local mapping/start authorization,
 * and exercises worker routes. It does not run Kaseki's scheduler, admission
 * checks, containers, repository code, artifacts, or publisher.
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
  async consume(
    message: KasekiPulledMessage,
    queue: KasekiQueueLeaseHarness,
    options: {
      loseFirstClaimResponse?: boolean;
      stopAfterClaim?: boolean;
      stopAfterStartedBeforeAuthorization?: boolean;
      loseAckResponse?: boolean;
    } = {},
  ): Promise<KasekiDeliveryResult> {
    const retryDelaySeconds = queueRetryDelaySeconds(message.attempts);
    let result: Omit<KasekiDeliveryResult, "disposition" | "retryDelaySeconds" | "error">;
    try {
      result = await this.deliver(message.body, options);
    } catch (error) {
      queue.retry(message, retryDelaySeconds);
      return {
        disposition: "retried",
        retryDelaySeconds,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const isAlreadyActive = (result.status === "running" || result.status === "cancel_requested")
      && (!result.intent || result.intent.startAuthorized);
    if (!isTerminal(result.status) && !isAlreadyActive && !result.startAuthorized) {
      queue.retry(message, retryDelaySeconds);
      return { ...result, disposition: "retried", retryDelaySeconds };
    }

    queue.acknowledge(message, options.loseAckResponse === true);
    return {
      ...result,
      disposition: options.loseAckResponse ? "ack-uncertain" : "acknowledged",
    };
  }

  /** Process the queue body and perform the Soyuz side of the handoff. */
  private async deliver(
    messageValue: unknown,
    options: {
      loseFirstClaimResponse?: boolean;
      stopAfterClaim?: boolean;
      stopAfterStartedBeforeAuthorization?: boolean;
    } = {},
  ): Promise<Omit<KasekiDeliveryResult, "disposition" | "retryDelaySeconds" | "error">> {
    const message = parseQueueMessage(messageValue);
    const canonicalRun = await this.readWorkerRun(message.runId);
    let intent = this.durableIntents.get(message.runId);

    // Terminal deliveries are safe to acknowledge without creating a local job.
    if (isTerminal(canonicalRun.status)) {
      return { runId: message.runId, status: canonicalRun.status, intent, startAuthorized: intent?.startAuthorized ?? false };
    }

    // Soyuz may still be finalizing admission. Keep the lease for a later retry.
    if (canonicalRun.status === "admitting") {
      return { runId: message.runId, status: canonicalRun.status, intent, startAuthorized: false };
    }

    // A duplicate delivery for already active work must never create speculative work.
    if ((canonicalRun.status === "running" || canonicalRun.status === "cancel_requested") && !intent) {
      return { runId: message.runId, status: canonicalRun.status, startAuthorized: false };
    }

    if (canonicalRun.status === "claimed" && !intent) {
      throw new Error("Soyuz has a claimed run without a durable Kaseki claim intent; refusing to start work.");
    }

    if (!intent) {
      intent = createIntent(message.runId, this.workerId);
      // Save the per-attempt identity before making the claim request.
      this.durableIntents.set(message.runId, intent);
    }
    if (intent.workerId !== this.workerId) {
      throw new Error("A saved job intent cannot move to a different worker ID.");
    }

    if (canonicalRun.status === "running" || canonicalRun.status === "cancel_requested") {
      assertIntentOwnsRun(intent, canonicalRun);
      if (intent.startAuthorized) {
        if (!intent.localJobPersisted) {
          throw new Error("Kaseki start authorization exists without a durable local job mapping.");
        }
        return { runId: message.runId, status: canonicalRun.status, intent, startAuthorized: true };
      }
      if (canonicalRun.status === "cancel_requested") {
        throw new Error("Soyuz cancellation arrived before Kaseki durably authorized execution.");
      }
      if (!intent.localJobPersisted) {
        throw new Error("Soyuz run is active without a durable Kaseki job mapping; refusing to start work.");
      }
    }

    let workerRun = canonicalRun;
    if (canonicalRun.status === "queued" || canonicalRun.status === "claimed") {
      const claim = {
        contractVersion: CONTRACT_VERSION,
        callbackId: intent.claimCallbackId,
        workerId: intent.workerId,
      };
      let claimResult = await this.api("POST", `/v1/worker/runs/${intent.runId}/claim`, claim);
      if (options.loseFirstClaimResponse) {
        // The first request committed in Soyuz; retry the saved ID exactly.
        claimResult = await this.api("POST", `/v1/worker/runs/${intent.runId}/claim`, claim);
      }
      requireSuccess(claimResult, "claim");
      intent.claimAccepted = true;
      workerRun = await this.readWorkerRun(intent.runId);
      assertIntentOwnsRun(intent, workerRun);
    }

    if (options.stopAfterClaim && workerRun.status === "claimed") {
      return { runId: message.runId, status: workerRun.status, intent, startAuthorized: false };
    }

    if (workerRun.status !== "claimed" && workerRun.status !== "running") {
      throw new Error(`Soyuz run is ${workerRun.status}; the simulator cannot start it.`);
    }

    // This models the scheduler's durable runId-to-local-job mapping, written
    // after claim succeeds and before sending /started.
    intent.localJobPersisted = true;
    const started = await this.api("POST", `/v1/worker/runs/${intent.runId}/started`, {
      contractVersion: CONTRACT_VERSION,
      callbackId: intent.startedCallbackId,
      claimCallbackId: intent.claimCallbackId,
      workerId: intent.workerId,
      startedAt: intent.startedAt,
      stage: "prepare",
    });
    requireSuccess(started, "started");
    intent.startedCallbackSent = true;
    workerRun = await this.readWorkerRun(intent.runId);
    if (options.stopAfterStartedBeforeAuthorization) {
      // Simulate an API restart after Soyuz accepted /started but before the
      // local scheduler durably opens the execution gate.
      return { runId: message.runId, status: workerRun.status, intent, startAuthorized: false };
    }
    intent.startAuthorized = true;
    return { runId: message.runId, status: workerRun.status, intent, startAuthorized: true };
  }

  async readWorkerRun(runId: string): Promise<Record<string, any>> {
    const result = await this.api("GET", `/v1/worker/runs/${runId}`);
    requireSuccess(result, "worker read");
    return requireWorkerRunData(result.body.data);
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
    claimAccepted: false,
    localJobPersisted: false,
    startedCallbackId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    startedCallbackSent: false,
    startAuthorized: false,
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

export function requireWorkerRunData(value: unknown): Record<string, any> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof (value as Record<string, unknown>).runId !== "string"
    || typeof (value as Record<string, unknown>).status !== "string"
  ) {
    throw new Error("Soyuz worker read returned a 2xx response without valid run data.");
  }
  return value as Record<string, any>;
}

function isTerminal(status: unknown): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "admission_failed";
}

function assertIntentOwnsRun(intent: KasekiJobIntent, workerRun: Record<string, any>): void {
  if (workerRun.workerId !== intent.workerId || workerRun.claimCallbackId !== intent.claimCallbackId) {
    throw new Error("Soyuz returned a different worker claim than the saved Kaseki intent.");
  }
}

function queueRetryDelaySeconds(attempts: number): number {
  return Math.min(900, Math.max(5, 5 * 2 ** Math.min(Math.max(0, attempts), 7)));
}

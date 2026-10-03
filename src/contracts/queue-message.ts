import type { RunRequest } from "./run-request";

export const CONTRACT_VERSION = "1" as const;

export interface QueuedRun {
  contractVersion: typeof CONTRACT_VERSION;
  runId: string;
  createdAt: string;
  correlationId: string;
  requestId: string;
  request: RunRequest;
}

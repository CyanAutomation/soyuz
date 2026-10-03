import { z } from "zod";
import { CONTRACT_VERSION } from "./queue-message";

const CallbackBase = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  callbackId: z.string().uuid(),
  workerId: z.string().min(1).max(200),
}).strict();

const OptionalTimestamp = z.string().datetime({ offset: true }).optional();

export const WorkerStartedSchema = CallbackBase.extend({
  startedAt: OptionalTimestamp,
  stage: z.string().min(1).max(120).optional(),
}).strict();

export const WorkerClaimSchema = CallbackBase.extend({
  leaseSeconds: z.number().int().min(30).max(300).default(120),
}).strict();

export const WorkerEventSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  eventId: z.string().uuid(),
  workerId: z.string().min(1).max(200),
  type: z.enum([
    "stage.changed",
    "step.changed",
    "progress.updated",
    "worker.heartbeat",
    "validation.completed",
    "publish.completed",
  ]),
  stage: z.string().min(1).max(120).optional(),
  step: z.string().min(1).max(160).optional(),
  timestamp: OptionalTimestamp,
  payload: z.record(z.unknown()).default({}),
}).strict().superRefine((event, context) => {
  if (event.type === "stage.changed" && !event.stage) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stage"],
      message: "stage is required for stage.changed events",
    });
  }
  if (event.type === "step.changed" && !event.step) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["step"],
      message: "step is required for step.changed events",
    });
  }
  if (new TextEncoder().encode(JSON.stringify(event.payload)).byteLength > 12_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload"],
      message: "event payload must be 12 KB or smaller",
    });
  }
});

export const WorkerCompletedSchema = CallbackBase.extend({
  completedAt: OptionalTimestamp,
  exitCode: z.literal(0).optional(),
  summary: z.string().max(2_000).optional(),
  publishedUrl: z.string().url().max(2_048).optional(),
  changedFileCount: z.number().int().min(0).max(100_000).optional(),
}).strict();

export const WorkerFailedSchema = CallbackBase.extend({
  completedAt: OptionalTimestamp,
  exitCode: z.number().int().optional(),
  failureClass: z.string().min(1).max(120),
  failureMessage: z.string().min(1).max(4_000),
}).strict();

export const WorkerCancelledSchema = CallbackBase.extend({
  completedAt: OptionalTimestamp,
  exitCode: z.number().int().optional(),
  reason: z.string().max(2_000).optional(),
}).strict();

export type WorkerStarted = z.infer<typeof WorkerStartedSchema>;
export type WorkerClaim = z.infer<typeof WorkerClaimSchema>;
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export type WorkerCompleted = z.infer<typeof WorkerCompletedSchema>;
export type WorkerFailed = z.infer<typeof WorkerFailedSchema>;
export type WorkerCancelled = z.infer<typeof WorkerCancelledSchema>;

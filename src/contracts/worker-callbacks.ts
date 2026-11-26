import { z } from "zod";
import { MAX_EVENT_PAYLOAD_BYTES } from "../persistence/retention-policy";
import { CONTRACT_VERSION } from "./queue-message";
import { isHttpUrl } from "../lib/safe-url";
import { RunOutcomeSummarySchema } from "./run-outcome";

const CallbackBase = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  callbackId: z.string().uuid(),
  workerId: z.string().min(1).max(200),
}).strict();

const FencedCallbackBase = CallbackBase.extend({
  /** Optional for older contract-v1 hosts; new hosts echo the current claim callback ID. */
  claimCallbackId: z.string().uuid().optional(),
});

const OptionalTimestamp = z.string().datetime({ offset: true }).optional();
const PublicationValidationEvidenceSchema = z.object({
  evidenceVersion: z.literal("1"),
  outcome: z.literal("passed"),
  artifactId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  runId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  repository: z.object({ owner: z.string().min(1).max(39), name: z.string().min(1).max(100) }).strict(),
  baseRef: z.string().min(1).max(128),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
const TaskAdmissionReasonCodeSchema = z.enum([
  "admitted",
  "unsafe_condition",
  "high_risk",
  "credential_signal",
  "evaluation_unavailable",
]);
const TaskAdmissionSignalSchema = z.enum([
  "contains_credentials",
  "changes_permissions",
  "crosses_security_boundary",
  "risk_level",
  "local_credential_signal",
]);
const TaskAdmissionSummarySchema = z.enum([
  "Task admission allowed after safety evaluation.",
  "Task admission rejected after a high-confidence unsafe-condition classification.",
  "Task admission rejected after a high-confidence high-risk classification.",
  "Task admission rejected by deterministic credential screening.",
  "Task admission evaluation was unavailable; the configured fail-open policy was applied.",
  "Task admission rejected after a local safety evaluation.",
  "Task admission rejected after a credential-related safety signal.",
  "Task admission rejected after a permission-change safety signal.",
  "Task admission rejected after a security-boundary safety signal.",
]);

/** Safe, bounded admission metadata; classifier answers and request text stay on Kaseki. */
const TaskAdmissionOutcomeSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["allowed", "rejected", "degraded"]),
  reasonCode: TaskAdmissionReasonCodeSchema,
  signal: TaskAdmissionSignalSchema.optional(),
  summary: TaskAdmissionSummarySchema,
  riskLevel: z.enum(["low", "review", "high"]).optional(),
  riskScore: z.number().int().min(0).max(2).optional(),
  responseTimeMs: z.number().int().min(0).max(86_400_000),
  evaluatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((result, context) => {
  if ((result.status === "degraded") !== (result.reasonCode === "evaluation_unavailable")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonCode"], message: "degraded admission results must use evaluation_unavailable" });
  }
  if (result.status === "allowed" && result.reasonCode !== "admitted") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonCode"], message: "allowed admission results must use admitted" });
  }
  if (result.status === "rejected"
    && !["unsafe_condition", "high_risk", "credential_signal"].some((reasonCode) => reasonCode === result.reasonCode)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonCode"], message: "rejected admission results need a rejection reason" });
  }
  if (result.riskScore !== undefined && result.riskLevel !== undefined
    && result.riskScore !== { low: 0, review: 1, high: 2 }[result.riskLevel]) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["riskScore"], message: "riskScore must match riskLevel" });
  }
});
export type TaskAdmissionOutcome = z.infer<typeof TaskAdmissionOutcomeSchema>;

const TerminalOutcomeFields = {
  summary: z.string().max(2_000).optional(),
  publishedUrl: z.string().url().max(2_048).refine(isHttpUrl, "publishedUrl must use HTTP or HTTPS").optional(),
  changedFileCount: z.number().int().min(0).max(100_000).optional(),
  outcomeSummary: RunOutcomeSummarySchema.optional(),
  taskAdmission: TaskAdmissionOutcomeSchema.optional(),
};

export const WorkerStartedSchema = FencedCallbackBase.extend({
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
  claimCallbackId: z.string().uuid().optional(),
  type: z.enum([
    "stage.changed",
    "step.changed",
    "progress.updated",
    "worker.heartbeat",
    "validation.completed",
    "publish.completed",
    "artifacts.uploaded",
  ]),
  stage: z.string().min(1).max(120).optional(),
  step: z.string().min(1).max(160).optional(),
  timestamp: OptionalTimestamp,
  payload: z.record(z.string(), z.unknown()).default({}),
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
  if (event.type === "validation.completed" && event.payload.publicationEvidence !== undefined) {
    const evidence = PublicationValidationEvidenceSchema.safeParse(event.payload.publicationEvidence);
    if (!evidence.success || !event.claimCallbackId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "publicationEvidence"],
        message: "Publication validation evidence requires its versioned shape and current claim callback ID",
      });
    }
  }
  if (new TextEncoder().encode(JSON.stringify(event.payload)).byteLength > MAX_EVENT_PAYLOAD_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload"],
      message: "event payload must be 12 KB or smaller",
    });
  }
});

export const WorkerCompletedSchema = FencedCallbackBase.extend({
  completedAt: OptionalTimestamp,
  exitCode: z.literal(0).optional(),
  ...TerminalOutcomeFields,
}).strict();

export const WorkerFailedSchema = FencedCallbackBase.extend({
  completedAt: OptionalTimestamp,
  exitCode: z.number().int().optional(),
  failureClass: z.string().min(1).max(120),
  failureMessage: z.string().min(1).max(4_000),
  ...TerminalOutcomeFields,
}).strict();

export const WorkerCancelledSchema = FencedCallbackBase.extend({
  completedAt: OptionalTimestamp,
  exitCode: z.number().int().optional(),
  reason: z.string().max(2_000).optional(),
  ...TerminalOutcomeFields,
}).strict();

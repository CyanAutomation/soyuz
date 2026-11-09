import { z } from "zod";
import { RUN_STATUSES } from "../domain/run-state-machine";
import { AgentCreateRunInputSchema } from "./run-request";

const RunStatusSchema = z.enum(RUN_STATUSES);
const DateTimeSchema = z.string().datetime({ offset: true });

export const AgentCreateRunToolInputSchema = z.object({
  body: AgentCreateRunInputSchema.describe("JSON body for asynchronous run admission."),
}).strict();

export const AgentListRunsInputSchema = z.object({
  status: RunStatusSchema.optional().describe("Optional lifecycle status filter."),
  limit: z.number().int().min(1).max(30).optional().describe("Runs per page, from 1 to 30; defaults to 30."),
  cursor: z.string().max(512).optional().describe("Opaque cursor returned as nextCursor by the preceding page."),
}).strict();

export const AgentRunIdInputSchema = z.object({
  runId: z.string().uuid().describe("Canonical Soyuz UUID. Do not use the human-facing displayId in API paths."),
}).strict();

export const AgentRunEventsInputSchema = z.object({
  runId: z.string().uuid().describe("Canonical Soyuz UUID."),
  after: z.number().int().min(0).optional().describe("Return events after this sequence number; defaults to 0."),
  limit: z.number().int().min(1).max(200).optional().describe("Events per page, from 1 to 200; defaults to 100."),
}).strict();

const AgentRunSummarySchema = z.object({
  runId: z.string().uuid(),
  displayId: z.string().regex(/^soyuz-\d+$/),
  status: RunStatusSchema,
  createdAt: DateTimeSchema,
  repoUrl: z.string().max(2_048).describe("Repository URL with credentials, query, and fragment removed."),
  ref: z.string().max(512),
  publishMode: z.enum(["auto", "none", "branch", "pr"]),
}).strict();

const AgentRunListItemSchema = z.object({
  runId: z.string().uuid(),
  displayId: z.string().regex(/^soyuz-\d+$/),
  repoUrl: z.string().max(2_048).describe("Repository URL with credentials, query, and fragment removed."),
  ref: z.string().max(512),
  status: RunStatusSchema,
  stage: z.string().max(120).nullable(),
  taskMode: z.enum(["patch", "inspect"]),
  publishMode: z.enum(["auto", "none", "branch", "pr"]),
  createdAt: DateTimeSchema,
  queuedAt: DateTimeSchema.nullable(),
  startedAt: DateTimeSchema.nullable(),
  completedAt: DateTimeSchema.nullable(),
}).strict();

const AgentRunDetailSchema = AgentRunListItemSchema.extend({
  updatedAt: DateTimeSchema,
  outcomeSummary: z.string().max(2_000).nullable(),
  publishedUrl: z.string().max(2_048).nullable(),
  changedFileCount: z.number().int().nullable(),
  failureClass: z.string().max(120).nullable(),
  cancellation: z.object({
    state: z.enum(["none", "requested", "cancelled"]),
    requestedAt: DateTimeSchema.nullable(),
  }).strict(),
}).strict();

const AgentRunEventSchema = z.object({
  sequence: z.number().int(),
  eventId: z.string().max(256),
  type: z.string().max(80),
  stage: z.string().max(120).nullable(),
  step: z.string().max(160).nullable(),
  timestamp: DateTimeSchema,
  payload: z.record(z.string(), z.union([z.string().max(160), z.number(), z.boolean()])),
}).strict();

function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data, requestId: z.string().uuid() }).strict();
}

export const AgentCreateRunOutputSchema = successEnvelope(AgentRunSummarySchema);
export const AgentListRunsOutputSchema = successEnvelope(z.object({
  runs: z.array(AgentRunListItemSchema).max(30),
  nextCursor: z.string().nullable(),
}).strict());
export const AgentGetRunOutputSchema = successEnvelope(AgentRunDetailSchema);
export const AgentGetRunEventsOutputSchema = successEnvelope(z.object({
  runId: z.string().uuid(),
  displayId: z.string().regex(/^soyuz-\d+$/),
  events: z.array(AgentRunEventSchema).max(200),
  nextAfter: z.number().int().min(0),
  hasMore: z.boolean(),
}).strict());
export const AgentCancelRunOutputSchema = successEnvelope(AgentRunDetailSchema);

export const AgentHttpErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().uuid(),
    details: z.unknown().optional(),
  }).strict(),
}).strict();

export type AgentCreateRunInput = z.infer<typeof AgentCreateRunInputSchema>;

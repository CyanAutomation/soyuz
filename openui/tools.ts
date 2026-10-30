import { z } from "zod";
import type { ToolSpec } from "@openuidev/lang-core";
import { RUN_STATUSES } from "../src/domain/run-state-machine";
import { JevDecisionResultSchema } from "../src/jev/contracts";
import { JevProfileIdSchema } from "../src/jev/profile-ids";

const runId = z.string().uuid();
const status = z.enum(RUN_STATUSES);
const queryStatus = z.enum([...RUN_STATUSES, "all"] as const);

export const toolInputSchemas = {
  list_runs: z.object({
    limit: z.number().int().min(1).max(30).optional(),
    status: queryStatus.optional(),
    cursor: z.string().max(500).optional(),
  }).strict(),
  get_run: z.object({ runId }).strict(),
  get_run_events: z.object({
    runId,
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }).strict(),
  get_run_artifacts: z.object({ runId }).strict(),
  jev_decisions: z.object({ profileId: JevProfileIdSchema, runId }).strict(),
} as const;

const runSummary = z.object({
  runId,
  displayId: z.string().max(32),
  status,
  repoUrl: z.string().max(500),
  ref: z.string().max(500),
  stage: z.string().max(100).nullable(),
  operationalHealth: z.enum(["unknown", "healthy", "suspect_stalled"]),
  failureClass: z.string().max(100).nullable(),
  createdAt: z.string().max(40),
  queuedAt: z.string().max(40).nullable(),
  startedAt: z.string().max(40).nullable(),
  completedAt: z.string().max(40).nullable(),
}).passthrough();

const event = z.object({
  sequence: z.number().int().nonnegative(),
  eventId: z.string().max(100),
  type: z.string().max(100),
  stage: z.string().max(100).nullable(),
  step: z.string().max(100).nullable(),
  timestamp: z.string().max(40),
  payload: z.record(z.string(), z.union([z.string().max(160), z.number().finite(), z.boolean()])),
}).passthrough();

const artifact = z.object({
  id: z.string().uuid(),
  name: z.string().max(255),
  size: z.number().int().nonnegative(),
}).passthrough();

export const toolOutputSchemas = {
  list_runs: z.object({
    runs: z.array(runSummary).max(30),
    nextCursor: z.string().max(500).nullable(),
  }),
  get_run: runSummary.passthrough(),
  get_run_events: z.object({
    events: z.array(event).max(50),
    nextAfter: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }),
  get_run_artifacts: z.object({ artifacts: z.array(artifact).max(100) }),
  jev_decisions: JevDecisionResultSchema,
} as const;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>;
}

export const soyuzOpenUITools: ToolSpec[] = [
  {
    name: "list_runs",
    description: "List up to 30 retained Soyuz run summaries, newest first. Optional status filters use a Soyuz lifecycle status.",
    inputSchema: jsonSchema(toolInputSchemas.list_runs),
    outputSchema: jsonSchema(toolOutputSchemas.list_runs),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_run",
    description: "Read one retained Soyuz run by UUID.",
    inputSchema: jsonSchema(toolInputSchemas.get_run),
    outputSchema: jsonSchema(toolOutputSchemas.get_run),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_run_events",
    description: "Read up to 50 bounded operational events for one retained run.",
    inputSchema: jsonSchema(toolInputSchemas.get_run_events),
    outputSchema: jsonSchema(toolOutputSchemas.get_run_events),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_run_artifacts",
    description: "List safe metadata for the retained artifacts of one run. This does not download artifact content.",
    inputSchema: jsonSchema(toolInputSchemas.get_run_artifacts),
    outputSchema: jsonSchema(toolOutputSchemas.get_run_artifacts),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

export type SoyuzToolName = keyof typeof toolInputSchemas;

export function isSoyuzToolName(value: unknown): value is SoyuzToolName {
  return typeof value === "string" && Object.hasOwn(toolInputSchemas, value);
}

import { z } from "zod";

const RepoUrlSchema = z.string().url().max(2_048);
const TaskPromptSchema = z.string().min(10).max(32_000);
const RefSchema = z.string().min(1).max(512);
const ValidationCommandsSchema = z.array(z.string().min(1).max(2_048)).max(50);
const TaskModeSchema = z.enum(["patch", "inspect"]);
const PublishModeSchema = z.enum(["auto", "none", "branch", "pr"]);
const OptionalTimeout = z.number().int().min(60).max(10_800).optional();
const OptionalModel = z.string().min(1).max(200).optional();

const AutoLintCleanupSchema = z.object({
  enabled: z.boolean().optional(),
  commands: z.array(z.string().min(1).max(2_048)).max(50).optional(),
}).strict();

const TracingSchema = z.object({
  correlationId: z.string().uuid().optional(),
  requestId: z.string().uuid().optional(),
}).strict();

export const IdempotencyKeySchema = z.string().uuid();

const RunRequestShape = z.object({
  repoUrl: RepoUrlSchema,
  projectName: z.string().min(1).max(200).optional(),
  ref: RefSchema.default("main"),
  taskPrompt: TaskPromptSchema.optional(),
  changedFilesAllowlist: z.array(z.string().min(1).max(512)).max(500).optional(),
  allowlist: z.object({
    include: z.array(z.string().min(1).max(512)).max(500).optional(),
  }).strict().optional(),
  maxDiffBytes: z.number().int().positive().max(100_000_000).optional(),
  validationCommands: ValidationCommandsSchema.optional(),
  autoLintCleanup: AutoLintCleanupSchema.optional(),
  validation: z.object({
    commands: z.array(z.string().min(1).max(2_048)).max(50).optional(),
    autoLintCleanup: AutoLintCleanupSchema.optional(),
  }).strict().optional(),
  goalSetting: z.object({
    enabled: z.boolean().optional(),
    model: OptionalModel,
    timeoutSeconds: OptionalTimeout,
  }).strict().optional(),
  scouting: z.object({
    enabled: z.boolean().optional(),
    model: OptionalModel,
    timeoutSeconds: OptionalTimeout,
  }).strict().optional(),
  goalCheck: z.object({
    enabled: z.boolean().optional(),
    maxRetries: z.number().int().min(0).max(5).optional(),
    model: OptionalModel,
    timeoutSeconds: OptionalTimeout,
  }).strict().optional(),
  runEvaluation: z.object({
    enabled: z.boolean().optional(),
    model: OptionalModel,
    timeoutSeconds: OptionalTimeout,
  }).strict().optional(),
  taskMode: TaskModeSchema.default("patch"),
  publishMode: PublishModeSchema.default("pr"),
  startupCheck: z.boolean().optional(),
  startupCheckMode: z.enum(["boot", "baseline-validation"]).optional(),
  tracing: TracingSchema.optional(),
  idempotencyKey: IdempotencyKeySchema.optional(),
  timeoutSeconds: OptionalTimeout,
}).strict();

function normalizeRunRequestAliases(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;

  const request = { ...(input as Record<string, unknown>) };
  const aliases: Array<[string, string]> = [
    ["repo_url", "repoUrl"],
    ["project_name", "projectName"],
    ["git_ref", "ref"],
    ["task_prompt", "taskPrompt"],
    ["changed_files_allowlist", "changedFilesAllowlist"],
    ["max_diff_bytes", "maxDiffBytes"],
    ["validation_commands", "validationCommands"],
    ["auto_lint_cleanup", "autoLintCleanup"],
    ["scouting_config", "scouting"],
    ["goal_setting", "goalSetting"],
    ["goal_check", "goalCheck"],
    ["run_evaluation", "runEvaluation"],
    ["task_mode", "taskMode"],
    ["publish_mode", "publishMode"],
    ["startup_check", "startupCheck"],
    ["startup_check_mode", "startupCheckMode"],
    ["idempotency_key", "idempotencyKey"],
    ["timeout_seconds", "timeoutSeconds"],
  ];

  for (const [snakeCase, camelCase] of aliases) {
    if (request[camelCase] === undefined && request[snakeCase] !== undefined) {
      request[camelCase] = request[snakeCase];
    }
    delete request[snakeCase];
  }
  return request;
}

export const RunRequestSchema = z.preprocess(
  normalizeRunRequestAliases,
  RunRequestShape.superRefine((request, context) => {
    if (!request.taskPrompt && request.startupCheck !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["taskPrompt"],
        message: "taskPrompt is required unless startupCheck is true",
      });
    }
  }),
);

// The MCP adapter intentionally accepts a small, agent-facing subset of the
// REST contract. Field validators are shared with RunRequestShape so limits
// and accepted enum values stay in sync.
export const McpCreateRunInputSchema = z.object({
  repoUrl: RepoUrlSchema,
  taskPrompt: TaskPromptSchema,
  ref: RefSchema.optional(),
  taskMode: TaskModeSchema.optional(),
  publishMode: PublishModeSchema.optional(),
  validationCommands: ValidationCommandsSchema.optional(),
  timeoutSeconds: OptionalTimeout,
  idempotencyKey: IdempotencyKeySchema.optional(),
}).strict();

export type RunRequest = z.infer<typeof RunRequestSchema>;

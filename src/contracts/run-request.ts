import { z } from "zod";

export function isHttpsRepositoryUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const RepoUrlSchema = z.string().url().max(2_048).refine(isHttpsRepositoryUrl, "repoUrl must use HTTPS");
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

// Agent callers receive a smaller input surface than general REST clients.
// Validators are shared with RunRequestShape so limits and accepted values
// stay in sync while publication can retain the safer agent-specific default.
export const AgentCreateRunInputSchema = z.object({
  repoUrl: RepoUrlSchema.describe("Absolute HTTPS repository URL. Credentials, query parameters, and fragments are removed from Soyuz read responses."),
  taskPrompt: TaskPromptSchema.describe("Work Kaseki should perform. Must contain 10–32,000 characters."),
  ref: RefSchema.optional().describe("Git reference to check out. Defaults to main."),
  taskMode: TaskModeSchema.optional().describe("patch edits the repository; inspect performs analysis without edits. Defaults to patch."),
  publishMode: PublishModeSchema.optional().describe("Publication behavior. Defaults to none for agent-created work; choose branch or pr only when publication is intended."),
  validationCommands: ValidationCommandsSchema.optional().describe("Validation commands Kaseki should run after the task."),
  timeoutSeconds: OptionalTimeout.describe("Execution timeout from 60 to 10,800 seconds."),
  idempotencyKey: IdempotencyKeySchema.optional().describe("UUID to prevent duplicate admission. Reuse it with the same request after an uncertain response."),
}).strict();

export type RunRequest = z.infer<typeof RunRequestSchema>;

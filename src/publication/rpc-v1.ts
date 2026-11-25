import { z } from "zod";
import { UUID7 } from "./contract-v1";

const Repository = z.object({ owner: z.string().min(1).max(39), name: z.string().min(1).max(100) }).strict();
const ErrorCode = z.enum([
  "INVALID_REQUEST", "UNSUPPORTED_VERSION", "UNAUTHORIZED_CALLER",
  "APP_NOT_INSTALLED", "GITHUB_PERMISSION_DENIED", "ARTIFACT_INVALID", "ARTIFACT_DIGEST_MISMATCH",
  "ARTIFACT_PROVENANCE_MISMATCH", "BASE_MOVED", "BASE_TREE_CONFLICT", "BRANCH_CONFLICT",
  "PULL_REQUEST_CONFLICT", "NO_CHANGES", "UNSUPPORTED_GIT_OBJECT", "GITHUB_AUTH_UNAVAILABLE",
  "GITHUB_AUTH_INVALID", "GITHUB_RATE_LIMITED", "GITHUB_UNAVAILABLE", "GITHUB_TIMEOUT",
  "RECONCILIATION_REQUIRED", "PUBLISHING_UNAVAILABLE", "INTERNAL_ERROR",
]);
const ErrorClass = z.enum(["invalid", "policy", "conflict", "retryable", "internal"]);
export const KirisameErrorSchema = z.object({
  code: ErrorCode,
  classification: ErrorClass,
  message: z.string().min(1).max(500),
  requestId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional(),
  retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
}).strict().superRefine((error, context) => {
  if (error.retryAfterSeconds !== undefined && error.classification !== "retryable") {
    context.addIssue({ code: "custom", path: ["retryAfterSeconds"], message: "Retry-After is only valid for retryable errors" });
  }
});

export const PublicationIntentSchema = z.object({
  contractVersion: z.literal("1"),
  artifactId: z.string().regex(UUID7),
  artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  mode: z.enum(["branch", "pr"]),
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(10_000).optional(),
}).strict().superRefine((intent, context) => {
  if (intent.mode === "pr" && (!intent.title || intent.body === undefined)) {
    context.addIssue({ code: "custom", message: "PR publication requires a title and body" });
  }
  if (intent.mode === "branch" && (intent.title !== undefined || intent.body !== undefined)) {
    context.addIssue({ code: "custom", message: "Branch publication does not accept PR metadata" });
  }
});

export const PublicationResultSchema = z.object({
  contractVersion: z.literal("1"),
  publicationId: z.string().regex(UUID7),
  runId: z.string().regex(UUID7),
  repository: Repository,
  mode: z.enum(["branch", "pr"]),
  outcome: z.enum(["branch_published", "pr_published", "retryable_failure", "blocked"]),
  retryable: z.boolean(),
  reconciliation: z.enum(["not_needed", "confirmed_absent", "branch_confirmed", "pull_request_confirmed", "conflict", "unknown"]),
  branch: z.object({
    ref: z.string().regex(/^kirisame\/p\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    reused: z.boolean().optional(),
  }).strict().optional(),
  pullRequest: z.object({
    number: z.number().int().min(1).max(2_147_483_647),
    url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/),
    state: z.enum(["open", "closed", "merged"]),
  }).strict().optional(),
  error: KirisameErrorSchema.optional(),
}).strict().superRefine((result, context) => {
  if (result.outcome === "branch_published"
    && (result.mode !== "branch" || result.retryable || !result.branch || result.pullRequest || result.error)) {
    context.addIssue({ code: "custom", message: "Branch publication result is inconsistent" });
  }
  if (result.outcome === "pr_published"
    && (result.mode !== "pr" || result.retryable || !result.branch || result.pullRequest?.state !== "open" || result.error)) {
    context.addIssue({ code: "custom", message: "PR publication result is inconsistent" });
  }
  if ((result.outcome === "retryable_failure" || result.outcome === "blocked") && !result.error) {
    context.addIssue({ code: "custom", message: "Failure result requires a structured error" });
  }
  if (result.error) {
    const retryable = result.error.classification === "retryable";
    if (result.retryable !== retryable || result.outcome !== (retryable ? "retryable_failure" : "blocked")) {
      context.addIssue({ code: "custom", message: "Failure classification does not match result state" });
    }
  }
});

export type PublicationResult = z.infer<typeof PublicationResultSchema>;
export type KirisameError = z.infer<typeof KirisameErrorSchema>;
export type PublisherEntrypoint = { publish(requestJson: string, callerId: string, apiKey: string): Promise<unknown> };

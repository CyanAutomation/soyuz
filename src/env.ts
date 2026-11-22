import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  RUN_QUEUE: Queue;
  OAUTH_REGISTRATION_LIMITER: RateLimit;
  ANALYSIS_GENERATION_LIMITER: RateLimit;
  JEV_DECISION_LIMITER: RateLimit;
  SENKU: Fetcher;
  CLIENT_API_TOKEN: string;
  /** Optional one-time previous client key during a bounded rotation. */
  CLIENT_API_TOKEN_PREVIOUS?: string;
  CLIENT_API_TOKEN_PREVIOUS_EXPIRES_AT?: string;
  /** Separate Kaseki submission credential; accepted only on run create/retry/cancel routes. */
  KASEKI_SUBMISSION_API_TOKEN?: string;
  KASEKI_SUBMISSION_API_TOKEN_PREVIOUS?: string;
  KASEKI_SUBMISSION_API_TOKEN_PREVIOUS_EXPIRES_AT?: string;
  /** Trusted deployment label recorded for submissions authenticated with the Kaseki credential. */
  KASEKI_SUBMISSION_IDENTITY?: string;
  WORKER_API_TOKEN: string;
  /** Optional one-time previous worker key during a bounded rotation. */
  WORKER_API_TOKEN_PREVIOUS?: string;
  WORKER_API_TOKEN_PREVIOUS_EXPIRES_AT?: string;
  ARTIFACTS?: R2Bucket;
  ASSETS?: Fetcher;
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  /** Must be "development" to publish an explicitly configured loopback UTCP origin. */
  SOYUZ_ENVIRONMENT?: "development" | "production";
  SOYUZ_PUBLIC_URL?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  SOYUZ_OAUTH_ALLOWED_GITHUB_IDS?: string;
  /** Full HTTPS OpenAI-compatible chat completions endpoint for A2UI generation. */
  ANALYSIS_PROVIDER_URL?: string;
  /** Server-side credential for the configured model provider or AI Gateway. */
  ANALYSIS_PROVIDER_API_KEY?: string;
  /** Provider model identifier. */
  ANALYSIS_MODEL?: string;
  /** Explicit opt-in deterministic local fixture mode; keep disabled in production. */
  ANALYSIS_DEMO_MODE?: string;
  /** Machine identity for Soyuz-to-Senku decision requests. Store as a Worker secret. */
  SENKU_SOYUZ_API_TOKEN?: string;
  /** Optional private RPC binding. Keep absent until Phase 2C is separately commissioned. */
  KIRISAME?: { publish(requestJson: string): Promise<unknown> };
  /** Durable publication dispatch remains off unless explicitly enabled. */
  PUBLICATION_DISPATCH_ENABLED?: string;
  /** JSON exact destination rules; absent or malformed configuration denies new intents. */
  PUBLICATION_REPOSITORY_ALLOWLIST?: string;
}

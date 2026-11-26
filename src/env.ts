import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  RUN_QUEUE: Queue;
  OAUTH_REGISTRATION_LIMITER: RateLimit;
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
  /** Machine identity for Soyuz-to-Senku decision requests. Store as a Worker secret. */
  SENKU_SOYUZ_API_TOKEN?: string;
  /** Private RPC binding. The API key is passed outside the immutable request JSON. */
  KIRISAME?: {
    publish(requestJson: string, callerId: string, apiKey: string): Promise<unknown>;
    verifyCanaryAuthorization(callerId: string, apiKey: string): Promise<unknown>;
  };
  KIRISAME_CALLER_ID?: string;
  /** Kirisame caller credential; configure with the Cloudflare Worker secret command. */
  KIRISAME_API_KEY?: string;
  /** Separate operator-only credential for the read-only Kirisame authorization preflight. */
  SOYUZ_OPERATOR_API_TOKEN?: string;
  /** Durable publication dispatch remains off unless explicitly enabled. */
  PUBLICATION_DISPATCH_ENABLED?: string;
  /** JSON exact destination rules; absent or malformed configuration denies new intents. */
  PUBLICATION_REPOSITORY_ALLOWLIST?: string;
}

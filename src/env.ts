import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  RUN_QUEUE: Queue;
  CLIENT_API_TOKEN: string;
  /** Separate Kaseki submission credential; accepted only on run create/retry/cancel routes. */
  KASEKI_SUBMISSION_API_TOKEN?: string;
  /** Trusted deployment label recorded for submissions authenticated with the Kaseki credential. */
  KASEKI_SUBMISSION_IDENTITY?: string;
  WORKER_API_TOKEN: string;
  ARTIFACTS?: R2Bucket;
  ASSETS?: Fetcher;
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  SOYUZ_PUBLIC_URL?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  SOYUZ_OAUTH_ALLOWED_GITHUB_IDS?: string;
}

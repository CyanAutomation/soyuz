export const RETENTION_POLICY_VERSION = 1 as const;
export const MAXIMUM_RETENTION_DAYS = 90;
const RETENTION_WINDOW_MS = MAXIMUM_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const DEFAULT_RUN_PAGE_SIZE = 30;
export const MAX_RUN_PAGE_SIZE = 100;
export const MAX_ARTIFACT_BYTES = 25_000_000;
export const MAX_ARTIFACTS_PER_RUN = 100;
export const MAX_ARTIFACT_BYTES_PER_RUN = 100_000_000;
export const MAX_EVENT_PAYLOAD_BYTES = 12_000;

/** Compute a UTC deadline from the canonical run creation timestamp. */
export function retentionExpiry(createdAt: string): string {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) throw new TypeError("createdAt must be a valid timestamp");
  return new Date(createdAtMs + RETENTION_WINDOW_MS).toISOString();
}

export function isWithinRetention(expiresAt: string | null | undefined, at = new Date()): boolean {
  return Boolean(expiresAt && Date.parse(expiresAt) > at.getTime());
}

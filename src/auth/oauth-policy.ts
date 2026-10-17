export const SOYUZ_READ_SCOPE = "soyuz:read";
export const SOYUZ_WRITE_SCOPE = "soyuz:write";

export interface OAuthProps {
  githubUserId: string;
  githubLogin: string;
}

export function allowedGithubUserIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  const entries = raw.split(",").map((value) => value.trim());
  if (entries.length === 0 || entries.some((value) => !/^\d{1,20}$/.test(value))) return new Set();
  return new Set(entries);
}

export function isAllowedGithubUser(userId: unknown, rawAllowlist: string | undefined): boolean {
  if (typeof userId !== "string" && (typeof userId !== "number" || !Number.isSafeInteger(userId))) return false;
  return allowedGithubUserIds(rawAllowlist).has(String(userId));
}

import type { Env } from "../env";

interface PublicationRule {
  owner: string;
  name: string;
  modes: Array<"branch" | "pr">;
  baseRefs: string[];
}

/** Exact, fail-closed policy. There is intentionally no production default allowlist. */
export function isPublicationAllowed(
  env: Env,
  destination: { owner: string; name: string },
  baseRef: string,
  mode: "branch" | "pr",
): boolean {
  const raw = env.PUBLICATION_REPOSITORY_ALLOWLIST?.trim();
  if (!raw || raw.length > 32_000) return false;
  try {
    const input: unknown = JSON.parse(raw);
    if (!Array.isArray(input) || input.length > 100) return false;
    const rules = input.map(parseRule);
    if (rules.some((rule) => !rule)) return false;
    return (rules as PublicationRule[]).some((rule) =>
      rule.owner.toLowerCase() === destination.owner.toLowerCase()
      && rule.name.toLowerCase() === destination.name.toLowerCase()
      && rule.modes.includes(mode)
      && rule.baseRefs.includes(baseRef));
  } catch {
    return false;
  }
}

function parseRule(value: unknown): PublicationRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "baseRefs,modes,name,owner") return null;
  if (typeof row.owner !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(row.owner)) return null;
  if (typeof row.name !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,97}[a-z0-9])?$/i.test(row.name)) return null;
  if (!Array.isArray(row.modes) || row.modes.length === 0 || row.modes.some((mode) => mode !== "branch" && mode !== "pr")) return null;
  if (!Array.isArray(row.baseRefs) || row.baseRefs.length === 0 || row.baseRefs.some((ref) => typeof ref !== "string" || ref.length > 128)) return null;
  return { owner: row.owner, name: row.name, modes: row.modes as PublicationRule["modes"], baseRefs: row.baseRefs as string[] };
}

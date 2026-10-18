async function tokenDigest(token: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

async function constantTimeTokenMatch(expected: string, provided: string): Promise<boolean> {
  if (!expected || !provided) return false;
  if (expected.length < 16 || provided.length > 1_024) return false;
  const [expectedDigest, providedDigest] = await Promise.all([
    tokenDigest(expected),
    tokenDigest(provided),
  ]);

  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= expectedDigest[index] ^ providedDigest[index];
  }
  return difference === 0;
}

export interface BearerTokenRotation {
  previousToken?: string;
  previousTokenExpiresAt?: string;
  now?: Date;
}

const MAX_PREVIOUS_TOKEN_GRACE_MS = 14 * 24 * 60 * 60 * 1_000;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export async function hasBearerToken(
  request: Request,
  expectedToken: string | undefined,
  rotation: BearerTokenRotation = {},
): Promise<boolean> {
  if (!isBearerTokenConfigured(expectedToken)) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  const separator = authorization.indexOf(" ");
  if (separator <= 0 || authorization.slice(0, separator).toLowerCase() !== "bearer") return false;
  const provided = authorization.slice(separator + 1);
  if (!provided || provided.trim() !== provided) return false;
  if (await constantTimeTokenMatch(expectedToken, provided)) return true;

  const previousToken = rotation.previousToken;
  if (!isBearerTokenConfigured(previousToken) || previousToken === expectedToken) return false;
  const expiresAt = parseUtcTimestamp(rotation.previousTokenExpiresAt);
  if (expiresAt === null) return false;
  const graceMs = expiresAt - (rotation.now ?? new Date()).getTime();
  if (graceMs <= 0 || graceMs > MAX_PREVIOUS_TOKEN_GRACE_MS) return false;
  return constantTimeTokenMatch(previousToken, provided);
}

function parseUtcTimestamp(value: string | undefined): number | null {
  if (!value || !UTC_TIMESTAMP_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = value.includes(".")
    ? new Date(milliseconds).toISOString()
    : new Date(milliseconds).toISOString().replace(".000Z", "Z");
  return canonical === value ? milliseconds : null;
}

export function isBearerTokenConfigured(token: string | undefined): token is string {
  return typeof token === "string" && token.length >= 16 && token.trim() === token;
}

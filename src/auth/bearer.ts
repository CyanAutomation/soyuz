async function tokenDigest(token: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

async function constantTimeTokenMatch(expected: string, provided: string): Promise<boolean> {
  if (expected.length < 32 || provided.length > 1_024) return false;
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

export async function hasBearerToken(request: Request, expectedToken: string | undefined): Promise<boolean> {
  if (!expectedToken) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  const separator = authorization.indexOf(" ");
  if (separator <= 0 || authorization.slice(0, separator).toLowerCase() !== "bearer") return false;
  const provided = authorization.slice(separator + 1);
  if (!provided || provided.trim() !== provided) return false;
  return constantTimeTokenMatch(expectedToken, provided);
}

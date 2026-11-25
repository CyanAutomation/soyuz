export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value).buffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

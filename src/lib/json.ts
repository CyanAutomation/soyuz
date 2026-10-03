export function stableStringify(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (ancestors.has(value)) throw new TypeError("Circular reference detected");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item, ancestors)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

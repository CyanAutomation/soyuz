import { describe, expect, it } from "vitest";
import { stableStringify } from "../src/lib/canonical-json";
import { sha256Hex } from "../src/lib/sha256";

describe("stableStringify", () => {
  it("[SERIALIZE-CYCLE-01] rejects circular object and array references", () => {
    const object: Record<string, unknown> = {};
    object.self = object;
    const array: unknown[] = [];
    array.push(array);

    expect(() => stableStringify(object)).toThrowError("Circular reference detected");
    expect(() => stableStringify(array)).toThrowError("Circular reference detected");
  });

  it("[SERIALIZE-SHARED-01] allows the same object to appear in separate branches", () => {
    const shared = { value: 1 };
    expect(stableStringify({ right: shared, left: shared })).toBe(
      '{"left":{"value":1},"right":{"value":1}}',
    );
  });

  it("[SERIALIZE-ARRAY-01] serializes nested array values and objects deterministically", () => {
    expect(stableStringify([{ z: 1, a: 2 }, null, [true, "value"]])).toBe(
      '[{"a":2,"z":1},null,[true,"value"]]',
    );
  });

  it("[SERIALIZE-PRIMITIVE-01] serializes primitive values and maps undefined to null", () => {
    expect([null, true, 42, "value", undefined].map((value) => stableStringify(value))).toEqual([
      "null",
      "true",
      "42",
      '"value"',
      "null",
    ]);
  });

  it("[SERIALIZE-SHA256-01] returns a SHA-256 hex digest", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

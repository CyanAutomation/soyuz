import { describe, expect, it } from "vitest";
import { stableStringify } from "../src/lib/json";

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
});

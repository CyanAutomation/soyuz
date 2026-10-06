import { describe, expect, it } from "vitest";
import { createRunId } from "../src/lib/uuidv7";

describe("UUIDv7 run IDs", () => {
  it("[RUN-ID-UUIDV7-01] encodes the timestamp and sorts across millisecond boundaries", () => {
    const earlierTimestamp = 1_800_000_000_000;
    const earlier = createRunId(earlierTimestamp);
    const later = createRunId(earlierTimestamp + 1);
    const encodedTimestamp = Number.parseInt(earlier.replaceAll("-", "").slice(0, 12), 16);

    expect(earlier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(encodedTimestamp).toBe(earlierTimestamp);
    expect(later > earlier).toBe(true);
  });

  it("[RUN-ID-BOUNDS-01] rejects timestamps outside the UUIDv7 field", () => {
    expect(() => createRunId(-1)).toThrow(RangeError);
    expect(() => createRunId(2 ** 48)).toThrow(RangeError);
  });
});

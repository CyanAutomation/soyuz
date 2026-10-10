import { describe, expect, it } from "vitest";
import { isUuid } from "../src/lib/uuid";
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

    const firstTimestampId = createRunId(0);
    const encodedTimestamp = Number.parseInt(firstTimestampId.replaceAll("-", "").slice(0, 12), 16);
    expect(encodedTimestamp).toBe(0);
  });
});

describe("isUuid", () => {
  it("accepts UUID versions 1 through 8 and rejects malformed variants", () => {
    const valid = "00000000-0000-4000-8000-000000000000";
    expect(isUuid(valid)).toBe(true);
    expect(isUuid("00000000-0000-7000-8000-000000000000")).toBe(true);
    expect(isUuid("00000000-0000-9000-8000-000000000000")).toBe(false);
    expect(isUuid("00000000-0000-4000-0000-000000000000")).toBe(false);
    expect(isUuid(`x${valid}`)).toBe(false);
    expect(isUuid(`${valid}x`)).toBe(false);
    expect(isUuid(valid.replace("00000000", "0000000"))).toBe(false);
    expect(isUuid(valid.replace("-0000-", "-000-"))).toBe(false);
    expect(isUuid(valid.replace("-000000000000", "-00000000000"))).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});

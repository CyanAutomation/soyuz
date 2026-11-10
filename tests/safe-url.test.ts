import { describe, expect, it } from "vitest";
import { isHttpUrl, safeHttpUrlForDisplay } from "../src/lib/safe-url";

describe("safe HTTP URL display", () => {
  it("keeps web URLs while stripping credentials and request-specific data", () => {
    expect(safeHttpUrlForDisplay("https://user:secret@example.com/path?token=secret#section"))
      .toBe("https://example.com/path");
    expect(safeHttpUrlForDisplay("http://example.com/path")).toBe("http://example.com/path");
  });

  it("rejects active schemes and malformed values", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "not a URL"]) {
      expect(isHttpUrl(value), value).toBe(false);
      expect(safeHttpUrlForDisplay(value), value).toBeNull();
    }
  });
});

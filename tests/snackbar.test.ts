import { afterEach, describe, expect, it, vi } from "vitest";
import { createSnackBarController } from "../dashboard/snackbar";

describe("snack bar controller", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a contextual message and clears it after the configured duration", () => {
    vi.useFakeTimers();
    const element = { hidden: true, textContent: "", className: "snackbar" };
    const snackbar = createSnackBarController(element, 5000);

    snackbar.show("Run ID copied", "success");
    expect(element).toMatchObject({ hidden: false, textContent: "Run ID copied", className: "snackbar snackbar--success" });

    vi.advanceTimersByTime(4999);
    expect(element.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(element).toMatchObject({ hidden: true, textContent: "", className: "snackbar" });
  });

  it("replaces the current message and restarts its timeout", () => {
    vi.useFakeTimers();
    const element = { hidden: true, textContent: "", className: "snackbar" };
    const snackbar = createSnackBarController(element, 5000);

    snackbar.show("First message", "success");
    vi.advanceTimersByTime(4000);
    snackbar.show("Second message", "info");
    vi.advanceTimersByTime(4000);
    expect(element.textContent).toBe("Second message");
    expect(element.hidden).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(element.hidden).toBe(true);
  });
});

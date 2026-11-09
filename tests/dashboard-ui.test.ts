import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { createBadge, setButtonBusy, setNotice } from "../dashboard/ui/components";

function createDocument() {
  return parseHTML("<!doctype html><html><body></body></html>").document;
}

describe("shared dashboard UI components", () => {
  it("renders a tone-aware notice and hides it when cleared", () => {
    const notice = createDocument().createElement("p");

    setNotice(notice, "Run list updated.", "success");
    expect(notice).toMatchObject({
      hidden: false,
      textContent: "Run list updated.",
      className: "notice notice--success",
    });

    setNotice(notice, "", "info");
    expect(notice).toMatchObject({ hidden: true, textContent: "", className: "notice notice--info" });
  });

  it("announces a busy button with an action label and restores its idle state", () => {
    const button = createDocument().createElement("button");
    button.textContent = "Refresh runs";

    setButtonBusy(button, true, "Refreshing runs…");
    expect(button).toMatchObject({ disabled: true, textContent: "Refreshing runs…" });
    expect(button.classList.contains("button--busy")).toBe(true);

    setButtonBusy(button, false);
    expect(button).toMatchObject({ disabled: false, textContent: "Refresh runs" });
    expect(button.classList.contains("button--busy")).toBe(false);
  });

  it("creates a text-safe reusable status badge", () => {
    const document = createDocument();
    const badge = createBadge("Status: queued", "active", document);

    expect(badge.tagName).toBe("SPAN");
    expect(badge.textContent).toBe("Status: queued");
    expect(badge.className).toBe("badge badge--active");
  });

});

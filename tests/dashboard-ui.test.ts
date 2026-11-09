import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { createBadge, createCard, createDefinitionList, setButtonBusy, setNotice } from "../dashboard/ui/components";

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

  it("creates a reusable article card with semantic header, body, and footer slots", () => {
    const document = createDocument();
    const { element, header, body, footer } = createCard({ className: "run-card" }, document);

    expect(element.tagName).toBe("ARTICLE");
    expect(element.className).toBe("card card--structured run-card");
    expect(header.tagName).toBe("HEADER");
    expect(header.className).toBe("card__header");
    expect(body.className).toBe("card__body");
    expect(footer.tagName).toBe("FOOTER");
    expect(footer.className).toBe("card__footer");
    expect(element.children).toHaveLength(3);
    expect(element.children[0]).toBe(header);
    expect(element.children[1]).toBe(body);
    expect(element.children[2]).toBe(footer);
  });

  it("creates a semantic definition list for reusable labelled facts", () => {
    const document = createDocument();
    const list = createDefinitionList(
      [["Repository", "CyanAutomation/soyuz"], ["Status", "Running"]],
      "data-list run-facts",
      document,
    );

    expect(list.tagName).toBe("DL");
    expect(list.className).toBe("data-list run-facts");
    expect([...list.children].map((item) => [item.children[0]?.tagName, item.children[0]?.textContent, item.children[1]?.tagName, item.children[1]?.textContent]))
      .toEqual([
        ["DT", "Repository", "DD", "CyanAutomation/soyuz"],
        ["DT", "Status", "DD", "Running"],
      ]);
  });

});

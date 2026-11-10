import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { createBadge, createCard, createDefinitionList, createField, setButtonBusy, setNotice } from "../dashboard/ui/components";
import { createRunCard } from "../dashboard/run-card";

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

  it("creates an accessible reusable field with associated help and recovery text", () => {
    const document = createDocument();
    const control = document.createElement("input");
    control.setAttribute("aria-describedby", "existing-help");

    const field = createField({
      id: "run-filter",
      label: "Filter runs",
      control,
      helpText: "Search retained runs.",
      errorText: "Enter a repository or run ID.",
      className: "toolbar-field",
    }, document);

    expect(field.element.className).toBe("field toolbar-field");
    expect(field.label.htmlFor).toBe("run-filter");
    expect(field.label.textContent).toBe("Filter runs");
    expect(field.control.id).toBe("run-filter");
    expect(field.control.getAttribute("aria-describedby")).toBe("existing-help run-filter-help run-filter-error");
    expect(field.control.getAttribute("aria-invalid")).toBe("true");
    expect(field.help?.textContent).toBe("Search retained runs.");
    expect(field.error?.textContent).toBe("Enter a repository or run ID.");
  });

  it("keeps the run creation time visible while technical details remain disclosed", () => {
    const document = createDocument();
    const run = {
      status: "completed",
      runId: "00000000-0000-4000-8000-000000000012",
      displayId: "soyuz-12",
      repoUrl: "https://github.com/cyan/Orion",
      ref: "main",
      origin: { type: "api_client", id: "client-api" },
      retryOf: null,
      createdAt: "2026-11-03T12:00:00.000Z",
      queuedAt: "2026-11-03T12:00:05.000Z",
      startedAt: "2026-11-03T12:01:00.000Z",
      completedAt: "2026-11-03T12:03:00.000Z",
      stage: null,
      operationalHealth: "unknown" as const,
      lastHeartbeatAt: null,
    };
    const onCopyId = vi.fn();
    const onDetailsToggle = vi.fn();

    const card = createRunCard(run, { ownerDocument: document, onCopyId, onDetailsToggle });
    const visibleCreated = card.querySelector(".run-card__created time");
    const metadata = card.querySelector<HTMLDetailsElement>(".run-card__metadata");

    expect(card.tagName).toBe("ARTICLE");
    expect(visibleCreated?.getAttribute("datetime")).toBe(run.createdAt);
    expect(visibleCreated?.textContent).toBe(new Date(run.createdAt).toLocaleString());
    expect(visibleCreated?.closest("details")).toBeNull();
    expect(metadata?.hasAttribute("open")).toBe(false);
    expect(metadata?.textContent).toContain(run.runId);
    expect(metadata?.textContent).toContain("Started");

    card.querySelector<HTMLButtonElement>(".run-card__copy-id")?.click();
    expect(onCopyId).toHaveBeenCalledWith(run.runId);

    const details = card.querySelector<HTMLDetailsElement>(".run-card__details");
    details!.open = true;
    details!.dispatchEvent(new document.defaultView!.Event("toggle"));
    expect(onDetailsToggle).toHaveBeenCalledWith(run, details, expect.anything(), true);
  });
});

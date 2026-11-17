import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { createBadge, createCard, createDefinitionList, createField, setButtonBusy, setNotice } from "../dashboard/ui/components";
import { createRunCard } from "../dashboard/run-card";

function createDocument() {
  return parseHTML("<!doctype html><html><body></body></html>").document;
}

describe("shared dashboard UI components", () => {
  it("[DASHBOARD-NOTICE-01] shows a notice message and hides it when cleared", () => {
    const notice = createDocument().createElement("p");

    setNotice(notice, "Run list updated.", "success");
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe("Run list updated.");

    setNotice(notice, "", "info");
    expect(notice.hidden).toBe(true);
    expect(notice.textContent).toBe("");
  });

  it("[DASHBOARD-BUSY-CONTROL-01] disables a busy button with an action label and restores it when idle", () => {
    const button = createDocument().createElement("button");
    button.textContent = "Refresh runs";

    setButtonBusy(button, true, "Refreshing runs…");
    expect(button).toMatchObject({ disabled: true, textContent: "Refreshing runs…" });

    setButtonBusy(button, false);
    expect(button).toMatchObject({ disabled: false, textContent: "Refresh runs" });
  });

  it("[DASHBOARD-STATUS-TEXT-01] displays untrusted status text without parsing markup", () => {
    const document = createDocument();
    const label = "Status: queued <img src=x onerror=alert(1)>";
    const badge = createBadge(label, "active", document);

    expect(badge.textContent).toBe(label);
    expect(badge.querySelector("img")).toBeNull();
  });

  it("[DASHBOARD-CARD-SEMANTICS-01] exposes an article with associated header, body, and footer content", () => {
    const document = createDocument();
    const { element, header, body, footer } = createCard({}, document);
    header.textContent = "Run summary";
    body.textContent = "Run is queued";
    footer.textContent = "Copy run ID";

    expect(header.tagName).toBe("HEADER");
    expect(footer.tagName).toBe("FOOTER");
    expect(element.tagName).toBe("ARTICLE");
    expect(element.querySelector("header")?.textContent).toBe("Run summary");
    expect(element.textContent).toContain("Run is queued");
    expect(element.querySelector("footer")?.textContent).toBe("Copy run ID");
  });

  it("[DASHBOARD-FACTS-SEMANTICS-01] presents labelled facts as definition pairs", () => {
    const document = createDocument();
    const list = createDefinitionList(
      [["Repository", "CyanAutomation/soyuz"], ["Status", "Running"]],
      "data-list",
      document,
    );

    expect(list.tagName).toBe("DL");
    expect([...list.children].map((item) => [item.children[0]?.tagName, item.children[0]?.textContent, item.children[1]?.tagName, item.children[1]?.textContent]))
      .toEqual([
        ["DT", "Repository", "DD", "CyanAutomation/soyuz"],
        ["DT", "Status", "DD", "Running"],
      ]);
  });

  it("[DASHBOARD-FIELD-A11Y-01] associates a control with its label, help, and recovery text", () => {
    const document = createDocument();
    const control = document.createElement("input");
    control.setAttribute("aria-describedby", "existing-help");

    const field = createField({
      id: "run-filter",
      label: "Filter runs",
      control,
      helpText: "Search retained runs.",
      errorText: "Enter a repository or run ID.",
    }, document);

    expect(field.label.htmlFor).toBe("run-filter");
    expect(field.label.textContent).toBe("Filter runs");
    expect(field.control.id).toBe("run-filter");
    expect(field.control.getAttribute("aria-describedby")).toBe("existing-help run-filter-help run-filter-error");
    expect(field.control.getAttribute("aria-invalid")).toBe("true");
    expect(field.help?.textContent).toBe("Search retained runs.");
    expect(field.error?.textContent).toBe("Enter a repository or run ID.");
  });

  it("[DASHBOARD-RUN-CARD-METADATA-01] keeps creation time visible and technical details collapsed by default", () => {
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
    const visibleCreated = card.querySelector("time[datetime]");
    const disclosures = [...card.querySelectorAll<HTMLDetailsElement>("details")];
    const metadata = disclosures.find((details) => details.querySelector("summary")?.textContent?.includes("technical ID and timestamps"));

    expect(card.tagName).toBe("ARTICLE");
    expect(visibleCreated?.getAttribute("datetime")).toBe(run.createdAt);
    expect(visibleCreated?.textContent).toBeTruthy();
    expect(visibleCreated?.closest("details")).toBeNull();
    expect(metadata?.hasAttribute("open")).toBe(false);
    expect(metadata?.textContent).toContain(run.runId);
    expect(metadata?.textContent).toContain("Started");

    card.querySelector<HTMLButtonElement>('button[aria-label="Copy technical run ID"]')?.click();
    expect(onCopyId).toHaveBeenCalledWith(run.runId);

    const details = disclosures.find((item) => item.querySelector("summary")?.textContent === "View outcome, activity, and files")!;
    details!.open = true;
    details!.dispatchEvent(new document.defaultView!.Event("toggle"));
    expect(onDetailsToggle).toHaveBeenCalledWith(run, details, expect.anything(), true);
  });
});

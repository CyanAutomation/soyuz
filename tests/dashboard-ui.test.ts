import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { createActionButton, createBadge, createCard, createDefinitionList, createField, createMetricGrid, createSummaryList, setButtonBusy, setNotice } from "../dashboard/ui/components";
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

  it("[DASHBOARD-ACTION-BUTTON-01] creates a reusable text-safe action button", () => {
    const document = createDocument();
    const onClick = vi.fn();
    const button = createActionButton("<script>Assess</script>", onClick, { variant: "primary", ownerDocument: document });

    expect(button.type).toBe("button");
    expect(button.textContent).toBe("<script>Assess</script>");
    expect(button.querySelector("script")).toBeNull();
    expect(button.className).toContain("button--primary");
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
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

  it("[DASHBOARD-METRICS-PRIMITIVE-01] creates reusable text-safe metric cards", () => {
    const document = createDocument();
    const grid = createMetricGrid([
      { label: "Helpful ratings", value: "8", detail: "Across retained runs" },
      { label: "Not helpful", value: "2" },
    ], "jev-feedback-metrics", document);

    expect(grid.className).toContain("ui-metric-grid");
    expect(grid.className).toContain("jev-feedback-metrics");
    expect([...grid.querySelectorAll(".ui-metric")].map((metric) => metric.textContent)).toEqual([
      "Helpful ratings8Across retained runs",
      "Not helpful2",
    ]);
    expect(grid.querySelector("script")).toBeNull();
  });

  it("[DASHBOARD-SUMMARY-LIST-PRIMITIVE-01] creates a reusable titled summary list", () => {
    const document = createDocument();
    const list = createSummaryList("Common improvement areas", ["Validation · Medium · 6", "Retry behavior · Low · 2"], document);

    expect(list.querySelector("h3")?.textContent).toBe("Common improvement areas");
    expect([...list.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Validation · Medium · 6", "Retry behavior · Low · 2",
    ]);
  });

  it("[DASHBOARD-RUN-METRICS-01] shows computed timings as distinct facts and keeps publication separate from execution", () => {
    const document = createDocument();
    const run = {
      status: "completed",
      runId: "00000000-0000-4000-8000-000000000111",
      displayId: "soyuz-111",
      repoUrl: "https://github.com/example/project",
      ref: "main",
      origin: { type: "api_client", id: "client" },
      retryOf: null,
      createdAt: "2026-11-22T12:00:00.000Z",
      queuedAt: "2026-11-22T12:00:10.000Z",
      startedAt: "2026-11-22T12:01:00.000Z",
      completedAt: "2026-11-22T12:04:00.000Z",
      stage: null,
      operationalHealth: "unknown" as const,
      lastHeartbeatAt: null,
      outcomeSummary: "Updated docs safely.",
      publication: { state: "retryable_failure", attemptCount: 2, nextAttemptAt: "2026-11-22T12:15:00.000Z" },
    };
    const card = createRunCard(run, { ownerDocument: document, now: Date.parse("2026-11-22T12:10:00.000Z") });
    const metrics = card.querySelector(".run-card__metrics");
    const badges = [...card.querySelectorAll(".badge")].map((badge) => badge.textContent);

    expect(metrics?.textContent).toContain("Run age");
    expect(metrics?.textContent).toContain("4m");
    expect(metrics?.textContent).toContain("Queue");
    expect(metrics?.textContent).toContain("50s");
    expect(metrics?.textContent).toContain("Execution");
    expect(metrics?.textContent).toContain("3m");
    expect(metrics?.textContent).toContain("Not reported");
    expect(badges).toContain("Status: Completed");
    expect(badges).toContain("Publication: Retryable failure");
    expect(card.textContent).toContain("Updated docs safely.");
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

  it("[DASHBOARD-RUN-HEALTH-01] distinguishes suspect liveness from lifecycle and explains safe callback recovery", () => {
    const document = createDocument();
    const run = {
      status: "running",
      runId: "00000000-0000-4000-8000-000000000013",
      displayId: "soyuz-13",
      repoUrl: "https://github.com/cyan/Orion",
      ref: "main",
      origin: { type: "api_client", id: "client-api" },
      retryOf: null,
      createdAt: "2026-11-03T12:00:00.000Z",
      queuedAt: "2026-11-03T12:00:05.000Z",
      startedAt: "2026-11-03T12:01:00.000Z",
      completedAt: null,
      stage: null,
      operationalHealth: "suspect_stalled" as const,
      lastHeartbeatAt: "2026-11-03T12:02:00.000Z",
    };

    const card = createRunCard(run, { ownerDocument: document });
    const badges = [...card.querySelectorAll(".badge")].map((badge) => badge.textContent);
    const warning = card.querySelector<HTMLElement>(".run-card__health");

    expect(badges).toContain("Status: Running");
    expect(badges).toContain("Health: Suspect stalled");
    expect(warning?.hidden).toBe(false);
    expect(warning?.textContent).toContain("Soyuz still records this run as running because no terminal callback is recorded.");
    expect(warning?.textContent).toContain("Check Kaseki's local job and callback outbox.");
    expect(warning?.textContent).toContain("Confirm execution has stopped before retrying a blocked callback or attempting recovery.");
  });

  it("[DASHBOARD-RUN-HEALTH-02] hides active-stall warnings after a terminal callback", () => {
    const document = createDocument();
    const run = {
      status: "failed",
      runId: "00000000-0000-4000-8000-000000000014",
      displayId: "soyuz-14",
      repoUrl: "https://github.com/cyan/Orion",
      ref: "main",
      origin: { type: "api_client", id: "client-api" },
      retryOf: null,
      createdAt: "2026-11-03T12:00:00.000Z",
      queuedAt: "2026-11-03T12:00:05.000Z",
      startedAt: "2026-11-03T12:01:00.000Z",
      completedAt: "2026-11-03T12:03:00.000Z",
      stage: null,
      operationalHealth: "suspect_stalled" as const,
      lastHeartbeatAt: "2026-11-03T12:02:00.000Z",
      failureClass: "validation_failed",
      failureMessage: "Validation failed.",
    };

    const card = createRunCard(run, { ownerDocument: document });
    const badges = [...card.querySelectorAll(".badge")].map((badge) => badge.textContent);
    const warning = card.querySelector<HTMLElement>(".run-card__health");

    expect(badges).toContain("Status: Failed");
    expect(badges).not.toContain("Health: Suspect stalled");
    expect(warning?.hidden).toBe(true);
  });
});

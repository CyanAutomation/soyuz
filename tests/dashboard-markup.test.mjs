import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readDashboardPage(path) {
  return parseHTML(readFileSync(resolve(projectRoot, path), "utf8")).document;
}

describe("dashboard page composition", () => {
  it.each([
    ["public/dashboard/index.html", "Recent runs", "/dashboard/"],
    ["public/dashboard/analysis/index.html", "Run analysis", "/dashboard/analysis/"],
  ])("[DASHBOARD-PAGE-SEMANTICS-01] uses one in-main page header and identifies the current destination in %s", (path, title, currentHref) => {
    const document = readDashboardPage(path);
    const main = document.querySelector("main");
    const headers = document.querySelectorAll("main > header");
    const headings = document.querySelectorAll("main h1");
    const currentLinks = document.querySelectorAll('nav[aria-label="Soyuz dashboards"] a[aria-current="page"]');

    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(headers).toHaveLength(1);
    expect(headings).toHaveLength(1);
    expect(headers[0].contains(headings[0])).toBe(true);
    expect(headings[0].textContent).toBe(title);
    expect(headings[0].getAttribute("aria-describedby")).toBe("page-description");
    expect(main.querySelector("#page-description")).not.toBeNull();
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0].getAttribute("href")).toBe(currentHref);
  });

  it("[DASHBOARD-RUN-CONTROLS-01] groups run search, filters, and actions while retaining labelled native controls", () => {
    const document = readDashboardPage("public/dashboard/index.html");
    const toolbar = document.querySelector("#run-controls");

    expect(toolbar.getAttribute("role")).toBe("group");
    expect(toolbar.querySelector('[aria-label="Search retained runs"]')).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Sort and filter runs"]')).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Run list actions"]')).not.toBeNull();
    expect(toolbar.querySelector('label[for="run-search"]')).not.toBeNull();
    expect(toolbar.querySelector('label[for="run-search"]').textContent).toBe("Search retained runs");
    expect(toolbar.querySelector("#run-search-help").textContent).toContain("newest 30 runs retained by Soyuz");
    expect(toolbar.querySelector('label[for="run-sort"]')).not.toBeNull();
    expect(toolbar.querySelector('label[for="status-filter"]')).not.toBeNull();
    expect(toolbar.querySelector("#run-count").getAttribute("aria-live")).toBe("polite");
  });

  it("[DASHBOARD-ANALYSIS-FORM-01] gives analysis and JEV fields accessible labels and help", () => {
    const document = readDashboardPage("public/dashboard/analysis/index.html");
    const question = document.querySelector("#analysis-question");
    const profile = document.querySelector("#analysis-jev-profile");
    const runId = document.querySelector("#analysis-jev-run-id");

    expect(document.querySelector('label[for="analysis-question"]')?.textContent).toBe("What would you like to know?");
    expect(question.hasAttribute("required")).toBe(true);
    expect(question.getAttribute("aria-describedby")).toBe("analysis-question-help");
    expect(document.querySelector("#analysis-question-help")?.textContent).toContain("generated view is read-only");

    expect(document.querySelector('label[for="analysis-jev-profile"]')?.textContent).toBe("Decision profile");
    expect(document.querySelector('label[for="analysis-jev-run-id"]')?.textContent).toBe("Run to assess");
    expect(runId.hasAttribute("required")).toBe(true);
    expect(runId.getAttribute("aria-describedby")).toBe("analysis-jev-run-help");
    expect(document.querySelector("#analysis-jev-run-help")?.textContent).toContain("enter its retained run UUID");
    expect(document.querySelector("#analysis-jev-disclosure > summary")?.textContent).toBe("Decision support with JEV");
    expect(profile.tagName).toBe("SELECT");
  });
});

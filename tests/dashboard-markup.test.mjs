import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readDashboardPage(path) {
  return parseHTML(readFileSync(resolve(projectRoot, path), "utf8")).document;
}

function readProjectFile(path) {
  return readFileSync(resolve(projectRoot, path), "utf8");
}

describe("dashboard page composition", () => {
  it("[DASHBOARD-PAGE-SEMANTICS-01] keeps run operations on one dashboard page", () => {
    const document = readDashboardPage("public/dashboard/index.html");
    const main = document.querySelector("main");
    const headers = document.querySelectorAll("main > header");
    const headings = document.querySelectorAll("main h1");
    const currentLinks = document.querySelectorAll('nav[aria-label="Soyuz dashboards"] a[aria-current="page"]');

    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(headers).toHaveLength(1);
    expect(headings).toHaveLength(1);
    expect(headers[0].contains(headings[0])).toBe(true);
    expect(headings[0].textContent).toBe("Recent runs");
    expect(headings[0].getAttribute("aria-describedby")).toBe("page-description");
    expect(main.querySelector("#page-description")).not.toBeNull();
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0].getAttribute("href")).toBe("/dashboard/");
    expect(document.querySelectorAll('nav a[href^="/dashboard/"]')).toHaveLength(1);
    expect(document.querySelector("#analysis-question")).toBeNull();
    expect(document.querySelector("#run-intelligence")).not.toBeNull();
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
    expect(toolbar.querySelector("#refresh").textContent).toBe("Refresh runs");
    expect(toolbar.querySelector("#refresh").getAttribute("aria-describedby")).toBe("refresh-help updated");
    expect(toolbar.querySelector("#refresh-help").textContent).toContain("Automatic refresh runs hourly");
    expect(toolbar.querySelector("#updated").getAttribute("aria-live")).toBe("polite");
  });

  it("[DASHBOARD-APP-CONTRACT-01] keeps app-required elements and run-card styles in sync with the page", () => {
    const document = readDashboardPage("public/dashboard/index.html");
    const app = readProjectFile("dashboard/app.ts");
    const stylesheet = readProjectFile("public/dashboard/style.css");
    const requiredIds = [...app.matchAll(/requiredElement<[^>]+>\("#([^"]+)"\)/g)].map((match) => match[1]);
    const styledRunCardClasses = [
      "run-card",
      "run-card__header",
      "run-card__identity",
      "run-card__statuses",
      "run-card__ref",
      "run-card__id",
      "run-card__technical-id",
      "run-card__copy-id",
      "run-card__identifiers",
      "run-card__metrics",
      "run-card__outcome",
      "run-card__progress",
      "run-card__health",
      "run-card__metadata",
    ];

    expect(requiredIds.length).toBeGreaterThan(0);
    for (const id of requiredIds) expect(document.getElementById(id), `missing #${id}`).not.toBeNull();
    for (const className of styledRunCardClasses) {
      expect(stylesheet, `missing .${className} style`).toMatch(new RegExp(`\\.${className}(?![\\w-])`));
    }
  });

});

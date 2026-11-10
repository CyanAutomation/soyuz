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
  ])("uses one in-main page header and identifies the current destination in %s", (path, title, currentHref) => {
    const document = readDashboardPage(path);
    const main = document.querySelector("main");
    const headers = document.querySelectorAll("main .page-header");
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

  it("groups run search, filters, and actions while retaining labelled native controls", () => {
    const document = readDashboardPage("public/dashboard/index.html");
    const toolbar = document.querySelector("#run-controls");

    expect(toolbar.className.split(/\s+/)).toContain("toolbar");
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

  it("uses the shared padded-card primitive for analysis and advisory forms", () => {
    const document = readDashboardPage("public/dashboard/analysis/index.html");

    expect(document.querySelector("#analysis-form").className.split(/\s+/)).toEqual(
      expect.arrayContaining(["card", "card--padded", "analysis-form"]),
    );
    expect(document.querySelector("#analysis-jev-controls").className.split(/\s+/)).toEqual(
      expect.arrayContaining(["card", "card--padded"]),
    );
    expect(document.querySelector("#analysis-jev-disclosure > summary").textContent).toBe("Decision support with JEV");
  });

  it("loads the shared theme tokens before dashboard component rules", () => {
    const stylesheet = readFileSync(resolve(projectRoot, "public/dashboard/style.css"), "utf8");
    const tokens = readFileSync(resolve(projectRoot, "public/dashboard/tokens.css"), "utf8");

    expect(stylesheet.startsWith('@import url("./tokens.css");')).toBe(true);
    expect(tokens).toContain("--color-page:");
    expect(tokens).toContain("--color-primary:");
    expect(tokens).toContain("--space-4:");
    expect(tokens).toContain("prefers-color-scheme: dark");
    expect(stylesheet).toContain(".page-header__title");
    expect(stylesheet).toContain(".toolbar__group--filters");
    expect(stylesheet).toContain(".card--structured");
    expect(stylesheet).toContain(".card__title");
    expect(stylesheet).toMatch(/\.field__control\s*\{[^}]*min-height:\s*3rem/);
    expect(stylesheet).toMatch(/\.button\s*\{[^}]*min-height:\s*3rem/);
    expect(stylesheet).toMatch(/\.run-card__copy-id\s*\{[^}]*min-height:\s*2\.75rem/);
    expect(stylesheet).toContain(".ui-timestamp__label");
  });
});

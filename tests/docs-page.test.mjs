import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("API reference page composition", () => {
  it("uses semantic landmarks and a labelled native operation filter", () => {
    const source = readFileSync(resolve(root, "public/docs/index.html"), "utf8");
    const document = parseHTML(source).document;

    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("#api-version")).not.toBeNull();
    expect(document.querySelector('a.skip-link[href="#api-content"]')).not.toBeNull();
    expect(document.querySelector('label[for="api-search"]')).not.toBeNull();
    expect(document.querySelector('nav[aria-label="API sections"]')).not.toBeNull();
    expect(document.querySelector('script[type="module"][src="/docs/app.js"]')).not.toBeNull();
  });
});

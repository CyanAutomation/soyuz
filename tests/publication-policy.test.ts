import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { isPublicationAllowed } from "../src/publication/policy";

function environment(allowlist: string | undefined): Env {
  return { PUBLICATION_REPOSITORY_ALLOWLIST: allowlist } as Env;
}

describe("publication repository policy", () => {
  it("matches owner and repository case-insensitively while keeping mode and base ref exact", () => {
    const env = environment(JSON.stringify([
      { owner: "Example", name: "Project", modes: ["branch", "pr"], baseRefs: ["main", "release/next"] },
    ]));

    expect(isPublicationAllowed(env, { owner: "example", name: "PROJECT" }, "main", "branch")).toBe(true);
    expect(isPublicationAllowed(env, { owner: "EXAMPLE", name: "project" }, "release/next", "pr")).toBe(true);
    expect(isPublicationAllowed(env, { owner: "example", name: "project" }, "Main", "branch")).toBe(false);
    expect(isPublicationAllowed(env, { owner: "example", name: "project" }, "main", "pr")).toBe(true);
    expect(isPublicationAllowed(env, { owner: "other", name: "project" }, "main", "branch")).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["malformed JSON", "{"],
    ["non-array", JSON.stringify({ owner: "example" })],
    ["too many rules", JSON.stringify(Array.from({ length: 101 }, () => ({
      owner: "example", name: "project", modes: ["branch"], baseRefs: ["main"],
    })))],
    ["unknown fields", JSON.stringify([{ owner: "example", name: "project", modes: ["branch"], baseRefs: ["main"], extra: true }])],
    ["empty modes", JSON.stringify([{ owner: "example", name: "project", modes: [], baseRefs: ["main"] }])],
    ["invalid repository owner", JSON.stringify([{ owner: "../example", name: "project", modes: ["branch"], baseRefs: ["main"] }])],
  ])("fails closed for a %s allowlist", (_case, allowlist) => {
    expect(isPublicationAllowed(environment(allowlist), { owner: "example", name: "project" }, "main", "branch"))
      .toBe(false);
  });
});

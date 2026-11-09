import { describe, expect, it } from "vitest";
import { filterAndSortRuns, type SearchableRun, type RunSortOrder } from "../dashboard/run-list";

const runs: SearchableRun[] = [
  {
    displayId: "soyuz-12",
    runId: "00000000-0000-4000-8000-000000000012",
    repoUrl: "https://github.com/cyan/Orion",
    ref: "feature/Cache-Fix",
    status: "completed",
    createdAt: "2026-11-03T12:00:00.000Z",
  },
  {
    displayId: "soyuz-9",
    runId: "00000000-0000-4000-8000-000000000009",
    repoUrl: "https://github.com/cyan/Apollo",
    ref: "main",
    status: "running",
    createdAt: "2026-11-05T12:00:00.000Z",
  },
  {
    displayId: "soyuz-10",
    runId: "00000000-0000-4000-8000-000000000010",
    repoUrl: "https://github.com/cyan/Zephyr",
    ref: "release/v2",
    status: "failed",
    createdAt: "2026-11-04T12:00:00.000Z",
  },
];

describe("run list search and sorting", () => {
  it.each([
    ["apollo", "soyuz-9"],
    ["FEATURE/cache", "soyuz-12"],
    ["00000000-0000-4000-8000-000000000010", "soyuz-10"],
    ["failed", "soyuz-10"],
  ])("finds runs by a case-insensitive query in repository, ref, ID, or status", (query, displayId) => {
    expect(filterAndSortRuns(runs, query, "newest").map((run) => run.displayId)).toEqual([displayId]);
  });

  it("trims the search and returns a new array without changing the source", () => {
    const result = filterAndSortRuns(runs, "  main  ", "newest");

    expect(result.map((run) => run.displayId)).toEqual(["soyuz-9"]);
    expect(runs.map((run) => run.displayId)).toEqual(["soyuz-12", "soyuz-9", "soyuz-10"]);
  });

  it.each<RunSortOrder>(["newest", "oldest", "repository", "status"])("sorts by %s with stable date ordering", (order) => {
    const expected: Record<RunSortOrder, string[]> = {
      newest: ["soyuz-9", "soyuz-10", "soyuz-12"],
      oldest: ["soyuz-12", "soyuz-10", "soyuz-9"],
      repository: ["soyuz-9", "soyuz-12", "soyuz-10"],
      status: ["soyuz-12", "soyuz-10", "soyuz-9"],
    };

    expect(filterAndSortRuns(runs, "", order).map((run) => run.displayId)).toEqual(expected[order]);
  });
});

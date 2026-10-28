import { describe, expect, it } from "vitest";
import { McpCreateRunInputSchema, RunRequestSchema } from "../src/contracts/run-request";

describe("run repository URL policy", () => {
  it("[RUN-REPO-HTTPS-01] accepts HTTPS repository URLs for REST and MCP submissions", () => {
    const httpsRepository = "https://github.com/example/project.git";

    expect(RunRequestSchema.safeParse({
      repoUrl: httpsRepository,
      taskPrompt: "Update the project documentation.",
    }).success).toBe(true);
    expect(McpCreateRunInputSchema.safeParse({
      repoUrl: httpsRepository,
      taskPrompt: "Update the project documentation.",
    }).success).toBe(true);
  });

  it.each([
    "http://github.com/example/project.git",
    "ssh://git@github.com/example/project.git",
    "file:///etc/passwd",
  ])("[RUN-REPO-HTTPS-01] rejects non-HTTPS repository URL %s for REST and MCP submissions", (repoUrl) => {
    const request = { repoUrl, taskPrompt: "Update the project documentation." };

    expect(RunRequestSchema.safeParse(request).success).toBe(false);
    expect(McpCreateRunInputSchema.safeParse(request).success).toBe(false);
  });
});

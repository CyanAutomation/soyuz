import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/json.test.ts",
      "tests/state-machine.test.ts",
      "tests/uuidv7.test.ts",
      "tests/a2ui.test.ts",
      "tests/a2ui-renderer.test.ts",
      "tests/jev-renderer.test.ts",
      "tests/jev.test.ts",
      "tests/jev-selection.test.ts",
      "tests/run-list.test.ts",
      "tests/worker-callback-contract.test.ts",
      "tests/dashboard-ui.test.ts",
      "tests/run-metrics.test.ts",
      "tests/run-operations.test.ts",
      "tests/jev-panel.test.ts",
      "tests/dashboard-refresh.test.ts",
      "tests/publication-policy.test.ts",
      "tests/verify-production-migrations.test.ts",
      "tests/worker-entry.test.ts",
      "tests/dashboard-markup.test.mjs",
    ],
  },
});

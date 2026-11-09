import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/json.test.ts",
      "tests/state-machine.test.ts",
      "tests/uuidv7.test.ts",
      "tests/openui.test.ts",
      "tests/openui-generation.test.ts",
      "tests/jev.test.ts",
      "tests/jev-selection.test.ts",
      "tests/run-list.test.ts",
      "tests/dashboard-ui.test.ts",
      "tests/dashboard-markup.test.mjs",
    ],
  },
});

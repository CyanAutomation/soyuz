import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/json.test.ts",
      "tests/state-machine.test.ts",
      "tests/uuidv7.test.ts",
    ],
  },
});

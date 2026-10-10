export default {
  mutate: [
    "src/domain/run-state-machine.ts",
    "src/lib/canonical-json.ts",
    "src/lib/sha256.ts",
    "src/lib/uuid.ts",
    "src/lib/uuidv7.ts",
  ],
  // Stryker resolves these plugin names dynamically to the matching packages.
  testRunner: "vitest",
  testFiles: [
    "tests/json.test.ts",
    "tests/state-machine.test.ts",
    "tests/uuidv7.test.ts",
  ],
  vitest: {
    configFile: "vitest.unit.config.ts",
    related: true,
  },
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "html", "progress"],
  concurrency: 2,
  thresholds: {
    high: 80,
    low: 60,
    break: 0,
  },
};

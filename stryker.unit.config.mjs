export default {
  mutate: [
    "src/domain/run-state-machine.ts",
    "src/lib/json.ts",
    "src/lib/uuidv7.ts",
  ],
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

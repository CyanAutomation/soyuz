import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CLIENT_API_TOKEN: "client-test-token-value-long-enough",
          WORKER_API_TOKEN: "worker-test-token-value-long-enough",
          TEST_MIGRATIONS: await readD1Migrations(path.join(projectRoot, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/apply-migrations.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});

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
        kvNamespaces: ["OAUTH_KV"],
          serviceBindings: {
            SENKU: async () => new Response(JSON.stringify({
              error: { code: "PROVIDER_UNAVAILABLE", message: "Senku is not part of this test fixture." },
            }), { status: 503, headers: { "content-type": "application/json" } }),
          },
        bindings: {
          CLIENT_API_TOKEN: "client-test-token-value-long-enough",
          WORKER_API_TOKEN: "worker-test-token-value-long-enough",
            SENKU_SOYUZ_API_TOKEN: "senku-soyuz-test-token-value-long-enough",
          TEST_MIGRATIONS: await readD1Migrations(path.join(projectRoot, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/openui.test.ts"],
    setupFiles: ["./tests/apply-migrations.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});

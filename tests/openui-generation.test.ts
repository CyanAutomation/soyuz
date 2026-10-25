import { describe, expect, it, vi } from "vitest";
import { handleOpenUIGenerationRequest } from "../src/openui/generation";
import type { Env } from "../src/env";

describe("OpenUI generation adapter", () => {
  it("[OPENUI-GENERATION-01] provides a deterministic local fixture and rejects unconfigured or invalid requests", async () => {
    const demoEnv = { OPENUI_DEMO_MODE: "true" } as Env;
    const demo = await handleOpenUIGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Summarise the last 10 runs.", mode: "generate" }),
    }), demoEnv);
    expect(demo.status).toBe(200);
    expect(await demo.text()).toContain("list_runs");

    const configuredDemoFetcher = vi.fn();
    const configuredDemo = await handleOpenUIGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Summarise the last 10 runs.", mode: "generate" }),
    }), {
      OPENUI_DEMO_MODE: "true",
      OPENUI_PROVIDER_URL: "https://gateway.example.test/v1/chat/completions",
      OPENUI_PROVIDER_API_KEY: "provider-secret",
      OPENUI_MODEL: "test-model",
    } as Env, "demo-request", configuredDemoFetcher as typeof fetch);
    expect(configuredDemo.status).toBe(200);
    expect(await configuredDemo.text()).toContain("list_runs");
    expect(configuredDemoFetcher).not.toHaveBeenCalled();

    const fetcher = vi.fn();
    const missingProvider = await handleOpenUIGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Summarise the last 10 runs." }),
    }), {} as Env, "request-test", fetcher);
    expect(missingProvider.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();

    const invalidInput = await handleOpenUIGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(2_001), mode: "generate" }),
    }), demoEnv);
    expect(invalidInput.status).toBe(400);
  });

  it("[OPENUI-GENERATION-02] keeps provider credentials server-side and relays chat-completion streams", async () => {
    const providerRequest = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-secret");
      const body = JSON.parse(String(init?.body)) as { stream: boolean; model: string; messages: Array<{ role: string; content: string }> };
      expect(body.stream).toBe(true);
      expect(body.model).toBe("test-model");
      expect(body.messages[0].content).toContain("Never fabricate run information");
      return new Response('data: {"choices":[{"delta":{"content":"root = Stack([Heading(\\"Recent runs\\")])"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const response = await handleOpenUIGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Summarise the last 10 runs." }),
    }), {
      OPENUI_PROVIDER_URL: "https://gateway.example.test/v1/chat/completions",
      OPENUI_PROVIDER_API_KEY: " provider-secret ",
      OPENUI_MODEL: "test-model",
    } as Env, "request-test", providerRequest as typeof fetch);
    const streamed = await response.text();
    expect(response.status).toBe(200);
    expect(streamed).toContain('"done":true');
    expect(streamed).toContain("Recent runs");
    expect(streamed).not.toContain("provider-secret");
    expect(providerRequest).toHaveBeenCalledTimes(1);
  });
});

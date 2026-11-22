import { describe, expect, it, vi } from "vitest";
import { A2UI_CATALOG_ID, validateA2uiMessages } from "../a2ui/protocol";
import type { Env } from "../src/env";
import { handleA2uiGenerationRequest } from "../src/a2ui/generation";

const surfaceId = "analysis-test";

function message(surface = surfaceId) {
  return {
    version: "1.0",
    createSurface: {
      surfaceId: surface,
      catalogId: A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "Column", children: ["heading"] },
        { id: "heading", component: "Text", text: "Recent runs" },
      ],
    },
  };
}

function sse(content: string): Response {
  const deltas = [content.slice(0, 13), content.slice(13, 37), content.slice(37)];
  const body = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`).join("")
    + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function responseEvents(response: Response): Promise<Array<{ event: string; data: string }>> {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
    const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "";
    return { event, data };
  });
}

describe("A2UI generation endpoint", () => {
  it("streams a deterministic A2UI v1.0 fixture in demo mode", async () => {
    const response = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Summarize retained runs." }),
    }), { ANALYSIS_DEMO_MODE: "true" } as Env, "request-demo", fetch, () => surfaceId);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = await responseEvents(response);
    expect(events.at(-1)?.event).toBe("done");
    const messages = events.filter((event) => event.event === "a2ui").map((event) => JSON.parse(event.data));
    expect(validateA2uiMessages(messages, { expectedSurfaceId: surfaceId }).ok).toBe(true);
  });

  it("validates provider JSONL before streaming A2UI messages and keeps the provider credential server-side", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body));
      expect(requestBody.stream).toBe(true);
      expect(requestBody.messages[0].content).toContain(A2UI_CATALOG_ID);
      expect(init?.headers).toMatchObject({ authorization: "Bearer provider-secret" });
      return sse(`${JSON.stringify(message())}\n`);
    });
    const response = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Show recent runs." }),
    }), {
      ANALYSIS_PROVIDER_URL: "https://gateway.example.test/v1/chat/completions",
      ANALYSIS_PROVIDER_API_KEY: "provider-secret",
      ANALYSIS_MODEL: "test-model",
    } as Env, "request-provider", fetcher, () => surfaceId);

    const events = await responseEvents(response);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(events.map((event) => event.event)).toEqual(["a2ui", "done"]);
    expect(events[0].data).not.toContain("delta");
    expect(validateA2uiMessages([JSON.parse(events[0].data)], { expectedSurfaceId: surfaceId }).ok).toBe(true);
  });

  it("forwards each complete validated A2UI message before the provider stream finishes", async () => {
    let finishProvider: (() => void) | undefined;
    let providerFinished = false;
    const providerBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const content = `${JSON.stringify(message())}\n`;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
      },
      async pull(controller) {
        await new Promise<void>((resolve) => { finishProvider = resolve; });
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
        providerFinished = true;
      },
    });
    const response = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Show recent runs." }),
    }), {
      ANALYSIS_PROVIDER_URL: "https://gateway.example.test/v1/chat/completions",
      ANALYSIS_PROVIDER_API_KEY: "provider-secret",
      ANALYSIS_MODEL: "test-model",
    } as Env, "request-streaming", async () => new Response(providerBody, { headers: { "content-type": "text/event-stream" } }), () => surfaceId);

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: a2ui");
    expect(providerFinished).toBe(false);
    finishProvider?.();
    let tail = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      tail += new TextDecoder().decode(next.value);
    }
    expect(tail).toContain("event: done");
  });

  it("rejects malformed, injected, or incomplete provider messages without a done event", async () => {
    const malicious = { ...message(), updateDataModel: { surfaceId, path: "/runs", value: [] } };
    const response = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Show recent runs." }),
    }), {
      ANALYSIS_PROVIDER_URL: "https://gateway.example.test/v1/chat/completions",
      ANALYSIS_PROVIDER_API_KEY: "provider-secret",
      ANALYSIS_MODEL: "test-model",
    } as Env, "request-invalid", async () => sse(`${JSON.stringify(malicious)}\n`), () => surfaceId);

    const events = await responseEvents(response);
    expect(events.some((event) => event.event === "error")).toBe(true);
    expect(events.some((event) => event.event === "done")).toBe(false);
  });

  it("requires a valid prior surface when refining and rejects unknown generation fields", async () => {
    const generateWithPrior = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Show recent runs.", existingSurface: JSON.stringify([message()]) }),
    }), { ANALYSIS_DEMO_MODE: "true" } as Env, "request-generate-prior", fetch, () => surfaceId);
    expect(generateWithPrior.status).toBe(400);

    const missingPrior = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Refine it.", mode: "edit" }),
    }), { ANALYSIS_DEMO_MODE: "true" } as Env, "request-missing-prior", fetch, () => surfaceId);
    expect(missingPrior.status).toBe(400);

    const staleField = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Show recent runs.", legacyProgram: "root = Stack([])" }),
    }), { ANALYSIS_DEMO_MODE: "true" } as Env, "request-stale-contract", fetch, () => surfaceId);
    expect(staleField.status).toBe(400);
  });

  it("refines an existing A2UI surface through validated component updates", async () => {
    const prior = message();
    const response = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Add a status note.", mode: "edit", existingSurface: JSON.stringify([prior]) }),
    }), { ANALYSIS_DEMO_MODE: "true" } as Env, "request-refine", fetch, () => surfaceId);

    const events = await responseEvents(response);
    expect(events.map((event) => event.event)).toEqual(["a2ui", "done"]);
    const update = JSON.parse(events[0].data);
    expect(update.updateComponents.surfaceId).toBe(surfaceId);
    expect(validateA2uiMessages([prior, update], { expectedSurfaceId: surfaceId }).ok).toBe(true);
  });

  it("preserves every component when refining a surface with multiple branches", async () => {
    const prior = {
      version: "1.0",
      createSurface: {
        surfaceId,
        catalogId: A2UI_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["heading", "left", "right"] },
          { id: "heading", component: "Text", text: "Run overview" },
          { id: "left", component: "Card", child: "leftText" },
          { id: "leftText", component: "Text", text: "Left branch" },
          { id: "right", component: "Card", child: "rightText" },
          { id: "rightText", component: "Text", text: "Right branch" },
        ],
      },
    };
    expect(validateA2uiMessages([prior]).ok).toBe(true);

    const response = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Refine the overview.", mode: "edit", existingSurface: JSON.stringify([prior]) }),
    }), { ANALYSIS_DEMO_MODE: "true" } as Env, "request-refine-multi-branch", fetch, () => surfaceId);

    const events = await responseEvents(response);
    expect(events.map((event) => event.event)).toEqual(["a2ui", "done"]);
    expect(validateA2uiMessages([prior, JSON.parse(events[0].data)], { expectedSurfaceId: surfaceId }).ok).toBe(true);
  });

  it("rejects a refinement that disconnects a component from the existing graph", async () => {
    const prior = {
      version: "1.0",
      createSurface: {
        surfaceId,
        catalogId: A2UI_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["heading", "details"] },
          { id: "heading", component: "Text", text: "Run overview" },
          { id: "details", component: "Text", text: "Existing detail" },
        ],
      },
    };
    const disconnectedUpdate = {
      version: "1.0",
      updateComponents: {
        surfaceId,
        components: [{ id: "root", component: "Column", children: ["heading"] }],
      },
    };
    let systemPromptText = "";
    const response = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Remove the detail.", mode: "edit", existingSurface: JSON.stringify([prior]) }),
    }), {
      ANALYSIS_PROVIDER_URL: "https://gateway.example.test/v1/chat/completions",
      ANALYSIS_PROVIDER_API_KEY: "provider-secret",
      ANALYSIS_MODEL: "test-model",
    } as Env, "request-refine-orphan", async (_input, init) => {
      systemPromptText = JSON.parse(String(init?.body)).messages[0].content;
      return sse(`${JSON.stringify(disconnectedUpdate)}\n`);
    });

    const events = await responseEvents(response);
    expect(systemPromptText).toContain("keep every existing component reachable from root");
    expect(events.some((event) => event.event === "error")).toBe(true);
    expect(events.some((event) => event.event === "done")).toBe(false);
  });

  it("fails safely when provider configuration or the provider response is unavailable", async () => {
    const unconfigured = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Show recent runs." }),
    }), {} as Env, "request-unconfigured", fetch, () => surfaceId);
    expect(unconfigured.status).toBe(503);

    const unavailable = await handleA2uiGenerationRequest(new Request("https://soyuz.test/dashboard/api/analysis/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Show recent runs." }),
    }), {
      ANALYSIS_PROVIDER_URL: "https://gateway.example.test/v1/chat/completions",
      ANALYSIS_PROVIDER_API_KEY: "provider-secret",
      ANALYSIS_MODEL: "test-model",
    } as Env, "request-unavailable", async () => new Response(null, { status: 502 }), () => surfaceId);
    expect(unavailable.status).toBe(502);
  });
});

import { A2UI_CATALOG_ID, A2UI_MAX_MESSAGE_CHARS, A2UI_MAX_STREAM_CHARS, A2uiStreamValidator, validateA2uiMessages } from "../../a2ui/protocol";
import { ApiError, errorResponse, parseJsonBody, requestIdFor } from "../api/http";
import type { Env } from "../env";
import { z } from "zod";

const GenerationRequest = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  mode: z.enum(["generate", "edit"]).default("generate"),
  existingSurface: z.string().max(A2UI_MAX_STREAM_CHARS).optional(),
}).strict();

const encoder = new TextEncoder();
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const PROVIDER_TIMEOUT_MS = 90_000;
const ALLOWED_COMPONENTS = "Column, Row, Card, Text, Button, Divider, List";

export async function handleA2uiGenerationRequest(
  request: Request,
  env: Env,
  requestId = requestIdFor(request),
  fetcher: typeof fetch = fetch,
  idFactory: () => string = () => crypto.randomUUID(),
): Promise<Response> {
  let body: unknown;
  try {
    body = await parseJsonBody(request, requestId);
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse(requestId);
    return errorResponse(requestId, 400, "INVALID_REQUEST", "Analysis request is invalid.");
  }
  const parsed = GenerationRequest.safeParse(body);
  if (!parsed.success) return errorResponse(requestId, 400, "INVALID_REQUEST", "Analysis request must contain a short prompt and a supported mode.");

  const prior = parsePriorSurface(parsed.data.mode, parsed.data.existingSurface);
  if (!prior.ok) return errorResponse(requestId, 400, "INVALID_EXISTING_SURFACE", "The existing A2UI surface is invalid and cannot be refined.");
  const surfaceId = prior.surfaceId ?? idFactory();
  const validator = new A2uiStreamValidator({ expectedSurfaceId: surfaceId });
  try {
    for (const message of prior.messages) validator.pushMessage(message);
  } catch {
    validator.dispose();
    return errorResponse(requestId, 400, "INVALID_EXISTING_SURFACE", "The existing A2UI surface is invalid and cannot be refined.");
  }
  const priorCount = prior.messages.length;

  if (env.ANALYSIS_DEMO_MODE === "true") {
    return validatedDemoResponse(surfaceId, validator, priorCount, requestId);
  }
  const providerUrl = configuredProviderUrl(env.ANALYSIS_PROVIDER_URL);
  const apiKey = env.ANALYSIS_PROVIDER_API_KEY?.trim();
  const model = env.ANALYSIS_MODEL?.trim();
  if (!providerUrl || !apiKey || !model) {
    validator.dispose();
    return errorResponse(requestId, 503, "ANALYSIS_UNAVAILABLE", "AI analysis is not configured. Contact your Soyuz administrator.");
  }

  const aborter = new AbortController();
  const timeoutId = setTimeout(() => aborter.abort(), PROVIDER_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetcher(providerUrl, {
      method: "POST",
      redirect: "error",
      signal: aborter.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt(surfaceId, parsed.data.mode) },
          {
            role: "user",
            content: JSON.stringify({
              request: parsed.data.prompt,
              mode: parsed.data.mode,
              existingSurface: prior.messages,
              applicationData: "The renderer loads retained run summaries and details itself from authenticated read-only Soyuz APIs. Do not invent or include application data.",
            }),
          },
        ],
      }),
    });
  } catch {
    clearTimeout(timeoutId);
    validator.dispose();
    return errorResponse(requestId, 502, "ANALYSIS_PROVIDER_UNAVAILABLE", "The configured AI provider could not be reached.");
  }
  if (!upstream.ok || !upstream.body) {
    clearTimeout(timeoutId);
    validator.dispose();
    return errorResponse(requestId, 502, "ANALYSIS_PROVIDER_UNAVAILABLE", "The configured AI provider could not generate an analysis.");
  }

  return responseForProvider(upstream, validator, requestId, aborter, timeoutId);
}

function parsePriorSurface(mode: "generate" | "edit", source: string | undefined):
  | { ok: true; messages: unknown[]; surfaceId: string | null }
  | { ok: false } {
  if (mode === "generate") return source === undefined ? { ok: true, messages: [], surfaceId: null } : { ok: false };
  if (!source) return { ok: false };
  let messages: unknown[];
  try {
    const value: unknown = JSON.parse(source);
    messages = Array.isArray(value) ? value : source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return { ok: false };
  }
  const result = validateA2uiMessages(messages);
  return result.ok && result.surfaceId
    ? { ok: true, messages, surfaceId: result.surfaceId }
    : { ok: false };
}

function systemPrompt(surfaceId: string, mode: "generate" | "edit"): string {
  const editInstruction = mode === "edit"
    ? "Refine the supplied surface with updateComponents messages for that same surface. A2UI v1.0 updates replace complete component definitions and this endpoint has no component-deletion operation: keep every existing component ID and keep every existing component reachable from root. Connect any new components into that graph."
    : "Create one complete surface using createSurface as your first message.";
  return [
    "You generate Google A2UI protocol v1.0 JSON messages for a read-only Soyuz run analysis dashboard.",
    `Use catalogId ${A2UI_CATALOG_ID} and surfaceId ${surfaceId}.`,
    `Only use these Basic Catalog components: ${ALLOWED_COMPONENTS}.`,
    "Use only host-provided bindings in /runs, /statusCounts, /selectedRun, /selectedRunId, /events, and /artifacts; List item templates may use relative fields such as displayId or runId.",
    "Supported event actions are select_run with context {runId: {\"@path\": \"runId\"}}, refresh_runs, reset_filters, and navigate_dashboard with context {path: \"/dashboard/analysis/\"}.",
    "Never include dataModel or sendDataModel, function calls, image URLs, arbitrary links, executable content, or actions that create, modify, cancel, retry, submit, or delete runs.",
    "Return compact JSONL only: one complete A2UI message per line, no Markdown, no explanation, and no blank lines.",
    editInstruction,
  ].join("\n");
}

function configuredProviderUrl(value: string | undefined): string | null {
  if (!value || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function responseForProvider(
  upstream: Response,
  validator: A2uiStreamValidator,
  requestId: string,
  aborter: AbortController,
  timeoutId: ReturnType<typeof setTimeout>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let outputChars = 0;
      const emitLine = (line: string) => {
        if (!line.trim()) return;
        outputChars += line.length;
        if (outputChars > A2UI_MAX_STREAM_CHARS) throw new Error("Generated messages exceed limits.");
        const message = validator.pushLine(line);
        controller.enqueue(encoder.encode(`event: a2ui\ndata: ${JSON.stringify(message)}\n\n`));
      };
      try {
        const onContent = (content: string) => {
          buffer += content;
          if (buffer.length > A2UI_MAX_MESSAGE_CHARS) throw new Error("Generated message exceeds limits.");
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            emitLine(line);
            newline = buffer.indexOf("\n");
          }
        };
        if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
          await readProviderSse(upstream, onContent, aborter.signal);
        } else {
          const payload = JSON.parse(await readBoundedText(upstream, MAX_PROVIDER_RESPONSE_BYTES)) as unknown;
          const content = extractMessageContent(payload);
          if (!content) throw new Error("Provider response was empty.");
          onContent(content);
        }
        if (buffer.trim()) emitLine(buffer.replace(/\r$/, ""));
        validator.finish();
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
      } catch {
        controller.enqueue(encoder.encode("event: error\ndata: {\"error\":\"The AI response was incomplete or invalid. Please try again.\"}\n\n"));
      } finally {
        validator.dispose();
        clearTimeout(timeoutId);
        try { controller.close(); } catch { /* Client cancelled the stream. */ }
      }
    },
    cancel() {
      aborter.abort();
      validator.dispose();
      clearTimeout(timeoutId);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
    },
  });
}

function validatedDemoResponse(
  surfaceId: string,
  validator: A2uiStreamValidator,
  priorCount: number,
  requestId: string,
): Response {
  const components = priorCount === 0
    ? [
      { id: "root", component: "Column", children: ["heading", "description"] },
      { id: "heading", component: "Text", text: "Recent retained runs", variant: "body", weight: 700 },
      { id: "description", component: "Text", text: "The demo surface is read-only. Sign in and configure an analysis provider to generate a custom view.", variant: "caption" },
    ]
    : demoEditComponent(validator.messages);
  const message = priorCount === 0
    ? { version: "1.0", createSurface: { surfaceId, catalogId: A2UI_CATALOG_ID, components } }
    : { version: "1.0", updateComponents: { surfaceId, components } };
  try {
    validator.pushMessage(message);
    validator.finish();
    return new Response(`event: a2ui\ndata: ${JSON.stringify(validator.messages.slice(priorCount)[0])}\n\nevent: done\ndata: {}\n\n`, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      },
    });
  } catch {
    return errorResponse(requestId, 400, "INVALID_EXISTING_SURFACE", "The demo surface could not be prepared.");
  } finally {
    validator.dispose();
  }
}

function demoEditComponent(messages: unknown[]): Array<Record<string, unknown>> {
  const componentsById = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const envelope = message as Record<string, unknown>;
    const operation = envelope.createSurface ?? envelope.updateComponents;
    if (!operation || typeof operation !== "object") continue;
    const components = (operation as Record<string, unknown>).components;
    if (!Array.isArray(components)) continue;
    for (const component of components) {
      if (component && typeof component === "object" && typeof (component as Record<string, unknown>).id === "string") {
        const value = component as Record<string, unknown>;
        componentsById.set(value.id as string, value);
      }
    }
  }

  const editableText = [...componentsById.values()].find((component) => component.component === "Text");
  const root = componentsById.get("root");
  const target = editableText ?? root;
  if (!target) throw new Error("Existing A2UI surface has no root component.");
  return [{
    ...target,
    ...(target.component === "Text" ? { text: "Demo refinement applied. The existing surface is preserved." } : {}),
  }];
}

async function readProviderSse(response: Response, onContent: (content: string) => void, signal: AbortSignal): Promise<void> {
  if (!response.body) throw new Error("Provider stream is missing.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let ended = false;
  while (!ended) {
    if (signal.aborted) throw new Error("Stream cancelled.");
    const chunk = await reader.read();
    if (chunk.done) {
      buffer += decoder.decode();
      if (buffer.trim()) ended = consumeProviderFrame(buffer, onContent);
      break;
    }
    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("Provider stream exceeded limits.");
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
    if (buffer.length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("Provider stream exceeded limits.");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (consumeProviderFrame(frame, onContent)) {
        ended = true;
        break;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel().catch(() => undefined);
}

function consumeProviderFrame(frame: string, onContent: (content: string) => void): boolean {
  const data = frame.replaceAll("\r", "").split("\n").filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart()).join("\n");
  if (!data) return false;
  if (data === "[DONE]") return true;
  const payload: unknown = JSON.parse(data);
  const delta = extractDelta(payload);
  if (delta) onContent(delta);
  return false;
}

function extractDelta(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") return "";
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

function extractMessageContent(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("Provider response is missing.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Provider response exceeded limits.");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

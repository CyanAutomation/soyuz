import { ApiError, errorResponse, parseJsonBody, requestIdFor } from "../api/http";
import type { Env } from "../env";
import { OPENUI_MAX_PROGRAM_CHARS, generateSoyuzSystemPrompt } from "../../openui/library";
import { validateGeneratedProgram } from "../../openui/runtime";
import { z } from "zod";

const GenerationRequest = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  mode: z.enum(["generate", "edit"]).default("generate"),
  existingProgram: z.string().max(OPENUI_MAX_PROGRAM_CHARS).optional(),
}).strict();

const encoder = new TextEncoder();
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const PROVIDER_TIMEOUT_MS = 90_000;

export async function handleOpenUIGenerationRequest(
  request: Request,
  env: Env,
  requestId = requestIdFor(request),
  fetcher: typeof fetch = fetch,
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
  if (parsed.data.mode === "edit" && !parsed.data.existingProgram) {
    return errorResponse(requestId, 400, "INVALID_REQUEST", "Interface refinement requires an existing generated program.");
  }
  if (parsed.data.mode === "generate" && parsed.data.existingProgram) {
    return errorResponse(requestId, 400, "INVALID_REQUEST", "A new interface cannot include an existing program.");
  }
  if (parsed.data.existingProgram && !validateGeneratedProgram(parsed.data.existingProgram).ok) {
    return errorResponse(requestId, 400, "INVALID_EXISTING_PROGRAM", "The existing interface is invalid and cannot be refined.");
  }

  if (env.OPENUI_DEMO_MODE === "true") {
    return demoResponse();
  }
  const providerUrl = configuredProviderUrl(env.OPENUI_PROVIDER_URL);
  if (!providerUrl || !env.OPENUI_PROVIDER_API_KEY?.trim() || !env.OPENUI_MODEL?.trim()) {
    return errorResponse(requestId, 503, "OPENUI_UNAVAILABLE", "AI analysis is not configured. Contact your Soyuz administrator.");
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
        authorization: `Bearer ${env.OPENUI_PROVIDER_API_KEY.trim()}`,
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
      },
      body: JSON.stringify({
        model: env.OPENUI_MODEL.trim(),
        stream: true,
        temperature: 0,
        messages: [
          { role: "system", content: generateSoyuzSystemPrompt(parsed.data.mode === "edit") },
          {
            role: "user",
            content: JSON.stringify({
              request: parsed.data.prompt,
              mode: parsed.data.mode,
              existingProgram: parsed.data.existingProgram ?? null,
              applicationData: "The browser can retrieve retained Soyuz run summaries, details, events, and artifact metadata only through the approved read-only query tools.",
            }),
          },
        ],
      }),
    });
  } catch {
    clearTimeout(timeoutId);
    return errorResponse(requestId, 502, "OPENUI_PROVIDER_UNAVAILABLE", "The configured AI provider could not be reached.");
  }
  if (!upstream.ok || !upstream.body) {
    clearTimeout(timeoutId);
    return errorResponse(requestId, 502, "OPENUI_PROVIDER_UNAVAILABLE", "The configured AI provider could not generate an analysis.");
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let outputSize = 0;
      const emit = (delta: string) => {
        outputSize += delta.length;
        if (outputSize > OPENUI_MAX_PROGRAM_CHARS) throw new Error("Generated response exceeded limits");
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
      };
      try {
        if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
          await readProviderSse(upstream, emit, aborter.signal);
        } else {
          const payload = JSON.parse(await readBoundedText(upstream, MAX_PROVIDER_RESPONSE_BYTES)) as unknown;
          const content = extractMessageContent(payload);
          if (content.length === 0) throw new Error("Provider response was empty");
          emit(content);
        }
        controller.enqueue(encoder.encode("data: {\"done\":true}\n\n"));
      } catch {
        try {
          controller.enqueue(encoder.encode("event: error\ndata: {\"error\":\"The AI response was incomplete or invalid. Please try again.\"}\n\n"));
        } catch {
          // The browser may have cancelled the stream.
        }
      } finally {
        clearTimeout(timeoutId);
        try {
          controller.close();
        } catch {
          // The browser may have cancelled the stream.
        }
      }
    },
    cancel() {
      aborter.abort();
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

function demoResponse(): Response {
  const fixture = [
    '$runStatus = "all"',
    '$selectedRunId = ""',
    'runs = Query("list_runs", { limit: 30, status: $runStatus }, { runs: [], nextCursor: null })',
    'root = Stack([Heading("Recent Kaseki runs"), MetricCard("Runs", @Count(runs.runs)), StatusChart(@StatusDistribution(runs.runs)), RunTable(runs.runs), Notice("Select a run to inspect its recorded event history.", "info")])',
  ].join("\n");
  const chunks = fixture.match(/.{1,120}/g) ?? [fixture];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const delta of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
      controller.enqueue(encoder.encode("data: {\"done\":true}\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}

async function readProviderSse(response: Response, emit: (delta: string) => void, signal: AbortSignal): Promise<void> {
  const body = response.body;
  if (!body) throw new Error("Provider stream is missing");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  while (!ended) {
    if (signal.aborted) throw new Error("Stream cancelled");
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    buffer = buffer.replace(/\r\n/g, "\n");
    if (buffer.length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("Provider stream exceeded limits");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (consumeProviderFrame(frame, emit)) {
        ended = true;
        break;
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (chunk.done) {
      if (buffer.trim()) consumeProviderFrame(buffer, emit);
      ended = true;
    }
  }
  await reader.cancel().catch(() => undefined);
}

function consumeProviderFrame(frame: string, emit: (delta: string) => void): boolean {
  const data = frame.replaceAll("\r", "").split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return false;
  if (data === "[DONE]") return true;
  const payload: unknown = JSON.parse(data);
  const delta = extractDelta(payload);
  if (delta) emit(delta);
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
  if (!response.body) throw new Error("Provider response is missing");
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
      throw new Error("Provider response exceeded limits");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

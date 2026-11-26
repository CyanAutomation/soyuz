export type OpenRouterFaultScenario = "http_503" | "malformed_json" | "timeout";

export const OPENROUTER_TEST_FAILURE_MARKER = "OPENROUTER_FAILURE_BODY_MUST_NOT_LEAK";

export function createOpenRouterFaultResponse(
  request: Request,
  scenario: OpenRouterFaultScenario,
  // This guard runs after the provider deadline and rejects if the abort was not forwarded.
  timeoutFallbackMs = 2_000,
): Response | Promise<Response> {
  if (scenario === "http_503") return new Response(OPENROUTER_TEST_FAILURE_MARKER, { status: 503 });
  if (scenario === "malformed_json") {
    return new Response(`${OPENROUTER_TEST_FAILURE_MARKER} {`, {
      headers: { "content-type": "application/json" },
    });
  }
  return waitForAbort(request, timeoutFallbackMs);
}

function waitForAbort(request: Request, fallbackMs: number): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      reject(new Error("Synthetic provider request aborted."));
    };
    const timer = setTimeout(() => {
      request.signal.removeEventListener("abort", onAbort);
      reject(new Error("Synthetic provider timeout guard expired without an abort."));
    }, fallbackMs);

    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
  });
}

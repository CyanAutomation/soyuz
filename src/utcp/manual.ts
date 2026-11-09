import { z } from "zod";
import {
  AgentCancelRunOutputSchema,
  AgentCreateRunOutputSchema,
  AgentCreateRunToolInputSchema,
  AgentGetRunEventsOutputSchema,
  AgentGetRunOutputSchema,
  AgentListRunsInputSchema,
  AgentListRunsOutputSchema,
  AgentRunEventsInputSchema,
  AgentRunIdInputSchema,
} from "../contracts/agent-tools";
import type { Env } from "../env";

const MANUAL_VERSION = "1.0.0";
const UTCP_VERSION = "1.0.0";

export interface UtcpManual {
  utcp_version: string;
  manual_version: string;
  tools: Array<{
    name: string;
    description: string;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    tags: string[];
    tool_call_template: {
      call_template_type: "http";
      url: string;
      http_method: "GET" | "POST";
      content_type?: "application/json";
      body_field?: string;
      auth: {
        auth_type: "api_key";
        api_key: "Bearer ${CLIENT_API_TOKEN}";
        var_name: "Authorization";
        location: "header";
      };
    };
  }>;
}

export function canonicalUtcpOrigin(env: Pick<Env, "SOYUZ_PUBLIC_URL" | "SOYUZ_ENVIRONMENT">): string | null {
  if (!env.SOYUZ_PUBLIC_URL) return null;
  try {
    const url = new URL(env.SOYUZ_PUBLIC_URL);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (env.SOYUZ_ENVIRONMENT === "development" && isLoopbackHost(url.hostname) && ["http:", "https:"].includes(url.protocol)) {
      return url.origin;
    }
    if (url.protocol !== "https:" || isLoopbackHost(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

function bearerAuth(): UtcpManual["tools"][number]["tool_call_template"]["auth"] {
  return {
    auth_type: "api_key",
    api_key: "Bearer ${CLIENT_API_TOKEN}",
    var_name: "Authorization",
    location: "header",
  };
}

export function createUtcpManual(env: Pick<Env, "SOYUZ_PUBLIC_URL" | "SOYUZ_ENVIRONMENT">): UtcpManual | null {
  const origin = canonicalUtcpOrigin(env);
  if (!origin) return null;
  const runsUrl = `${origin}/v1/agent/runs`;
  const tool = (
    name: string,
    description: string,
    inputs: z.ZodType,
    outputs: z.ZodType,
    method: "GET" | "POST",
    url: string,
    options: { bodyField?: string } = {},
  ): UtcpManual["tools"][number] => ({
    name,
    description,
    inputs: jsonSchema(inputs),
    outputs: jsonSchema(outputs),
    tags: ["soyuz", "kaseki", name.startsWith("get_") || name === "list_runs" ? "read" : "run-control"],
    tool_call_template: {
      call_template_type: "http",
      http_method: method,
      url,
      ...(options.bodyField ? { content_type: "application/json" as const, body_field: options.bodyField } : {}),
      auth: bearerAuth(),
    },
  });

  return {
    utcp_version: UTCP_VERSION,
    manual_version: MANUAL_VERSION,
    tools: [
      tool(
        "create_run",
        "Submit asynchronous work to Soyuz for a Kaseki host to execute later. A successful response means Soyuz admitted or replayed the request; it does not mean the task has completed. Supply an idempotencyKey and reuse it with the same request after timeouts or uncertain responses to prevent duplicate work. Omitted publishMode defaults to none. Explicit branch or pr publication can create a branch or pull request. Show displayId to people and use canonical runId for Soyuz API calls. Requires the client bearer credential configured by the UTCP client as CLIENT_API_TOKEN.",
        AgentCreateRunToolInputSchema,
        AgentCreateRunOutputSchema,
        "POST",
        runsUrl,
        { bodyField: "body" },
      ),
      tool(
        "list_runs",
        "List bounded, cursor-paginated summaries from Soyuz's newest 30 retained runs across all statuses. Older runs, their events, and artifacts are not available after retention culls them. Results include only control-plane summaries; they do not include worker lease data, requests, error objects, logs, repository contents, or artifacts. Requires the client bearer credential configured by the UTCP client as CLIENT_API_TOKEN.",
        AgentListRunsInputSchema,
        AgentListRunsOutputSchema,
        "GET",
        runsUrl,
      ),
      tool(
        "get_run",
        "Read the sanitized control-plane status for one retained run. Use canonical UUID runId, not the human-facing displayId. Soyuz retains only the newest 30 runs; details for culled runs are unavailable. Repository URLs have credentials, query strings, and fragments removed. Internal worker and claim data, raw requests, error objects, logs, repository contents, and artifacts are not returned. Requires the client bearer credential configured by the UTCP client as CLIENT_API_TOKEN.",
        AgentRunIdInputSchema,
        AgentGetRunOutputSchema,
        "GET",
        `${runsUrl}/{runId}`,
      ),
      tool(
        "get_run_events",
        "Read a bounded, sequence-paginated page of allowlisted operational event metadata for one retained run. Soyuz retains events only while the run remains in its newest 30-run window. Event payloads are allowlisted and bounded; worker identity, unrestricted payloads, stdout, stderr, Pi transcripts, repository contents, and artifacts are intentionally unavailable. Requires the client bearer credential configured by the UTCP client as CLIENT_API_TOKEN.",
        AgentRunEventsInputSchema,
        AgentGetRunEventsOutputSchema,
        "GET",
        `${runsUrl}/{runId}/events`,
      ),
      tool(
        "cancel_run",
        "Record a cancellation request through Soyuz for one retained run. Queued work may become cancelled immediately; running work records cancellation intent for the Kaseki host. This is not a guarantee that Docker execution stops immediately. Use canonical UUID runId, not displayId. Requires the client bearer credential configured by the UTCP client as CLIENT_API_TOKEN.",
        AgentRunIdInputSchema,
        AgentCancelRunOutputSchema,
        "POST",
        `${runsUrl}/{runId}/cancel`,
      ),
    ],
  };
}

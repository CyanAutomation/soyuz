# Soyuz UTCP interface

Soyuz publishes an unauthenticated, non-secret UTCP manual at `GET /utcp`. UTCP clients read the manual to discover five tools, then call Soyuz's existing HTTP API directly over HTTPS. The Worker does not run a UTCP proxy or forward tool calls internally. D1 remains the canonical run store and Cloudflare Queues remains the handoff to Kaseki.

The manual selects UTCP specification **1.0.0** (`utcp_version`) and version **1.0.0** of Soyuz's tool definitions (`manual_version`). Each tool has JSON Schema `inputs` and `outputs`, a description, tags, and an HTTP `tool_call_template`. The `outputs` schemas describe Soyuz's success response envelope `{ "data": ..., "requestId": "..." }`. Non-2xx responses use the ordinary Soyuz error envelope.

## Discovery and URLs

`GET /utcp` returns exactly `create_run`, `list_runs`, `get_run`, `get_run_events`, and `cancel_run`. It includes no API keys, runtime state, or credentials. Tool call templates use absolute endpoint URLs built from `SOYUZ_PUBLIC_URL`; inbound `Host` and forwarded-host headers are never used to build them.

Configure `SOYUZ_PUBLIC_URL` as a canonical origin with no path, query, or fragment. Production requires HTTPS and rejects loopback hostnames. Local development can explicitly set `SOYUZ_ENVIRONMENT=development` with `SOYUZ_PUBLIC_URL=http://127.0.0.1:8787`; the checked-in `.dev.vars.example` shows this configuration. A missing or invalid origin makes discovery return 503. Production Wrangler variables set `SOYUZ_ENVIRONMENT=production` and the deployed public HTTPS origin.

The selected UTCP schema follows the official [UTCP 1.0.0 RFC](https://www.utcp.io/about/RFC), [tool-provider guidance](https://www.utcp.io/for-tool-providers), and [HTTP call template reference](https://www.utcp.io/next/api/plugins/communication_protocols/http/src/utcp_http/http_call_template). Soyuz verifies the manual with the official TypeScript UTCP client and HTTP plugin in `tests/utcp.test.ts`.

## Tool inventory

| Tool | HTTP invocation | Inputs and behavior |
| --- | --- | --- |
| `create_run` | `POST /v1/agent/runs` | The UTCP input has one structured `body` field. Its value is sent as the JSON request body through `body_field: "body"`; Soyuz does not put create fields in the query string. |
| `list_runs` | `GET /v1/agent/runs` | `status`, `limit`, and `cursor` are query parameters. Pages contain at most 30 summaries. |
| `get_run` | `GET /v1/agent/runs/{runId}` | `runId` is substituted into the path and must be the canonical UUID. |
| `get_run_events` | `GET /v1/agent/runs/{runId}/events` | `runId` is a path parameter; `after` and `limit` are query parameters. Event pages contain at most 200 events. |
| `cancel_run` | `POST /v1/agent/runs/{runId}/cancel` | `runId` is substituted into the path. The POST has no request body. |

The HTTP plugin's path mapping uses `{runId}` syntax. Unmapped list/event arguments become query parameters. The create tool maps the `body` input to a JSON request body and declares `content_type: "application/json"`. Cancellation uses POST as required by the HTTP route.

## Authentication

Tool invocations require `Authorization: Bearer <CLIENT_API_TOKEN>`. The UTCP manual represents this with the supported HTTP API-key mechanism and a client-side variable:

```json
{
  "auth": {
    "auth_type": "api_key",
    "api_key": "Bearer ${CLIENT_API_TOKEN}",
    "var_name": "Authorization",
    "location": "header"
  }
}
```

This is only a placeholder; the manual never includes an actual token. The official client namespaces that variable to the manual name `soyuz_CLIENT_API_TOKEN`. Provision the value to the client from its own secret store. Do not put a token in the manual URL, tool arguments, source control, or logs.

The five agent HTTP routes accept the current client credential and the existing bounded client-token rotation overlap. They reject missing or invalid credentials, worker credentials, Kaseki submission credentials, and dashboard OAuth tokens. If the configured current client token collides with the worker or Kaseki submission token, agent routes return 503 because the server cannot safely distinguish those credential roles. They cannot call `/v1/worker/**`. The dashboard keeps its existing GitHub OAuth provider, allowlist, sessions, API authorization, and OpenUI analysis access. A future Cloudflare Access migration remains a separate project.

## Run lifecycle and idempotency

`create_run` submits work asynchronously. A successful HTTP response means Soyuz admitted or replayed the request; Kaseki executes it later on an available host. It is not a completion signal. Poll `get_run` or `get_run_events` using the returned canonical `runId`.

Agent-created work defaults an omitted `publishMode` to `none`. A valid explicit mode (`auto`, `none`, `branch`, or `pr`) is honored. Explicit branch or pull-request publication may create those GitHub resources. The human-facing `displayId` is for people; use the UUID `runId` for tool calls.

Supply a UUID `idempotencyKey` for each intended create and reuse it with an equivalent request after a timeout or uncertain response. Soyuz uses its existing origin-scoped idempotency ledger; UTCP has no separate ledger. Agent routes use the stable server-derived `api_client/utcp-agent` origin. This preserves run ownership and keeps agent idempotency keys separate from the general client API's `api_client/client-api` namespace. Equivalent retained work replays; reusing a key for different work within the same origin conflicts. If Queue publication is uncertain, Soyuz preserves the run and tells the caller to retry with the same key while reconciliation proceeds.

`cancel_run` records cancellation intent using the shared state machine. Queued work may become terminal immediately. Running work moves to `cancel_requested`; this does not guarantee that Docker stops at once. The Kaseki host observes the state and confirms cancellation after handling the running process.

## Data boundary

Agent reads reuse the shared application functions but use narrow projections instead of the broader REST responses. Repository URLs have credentials, query strings, and fragments removed. Run responses omit raw request data, worker IDs, claim/lease fields, internal database fields, and arbitrary error objects. Event responses contain only bounded operational metadata and allowlisted scalar payload keys; worker identity and unrestricted event payloads are removed.

Soyuz retains only the newest 30 runs across statuses. Once a run is culled, its details, events, and artifacts are unavailable. Event pages are bounded and sequence-paginated. UTCP does not provide tools for stdout, stderr, Pi transcripts, repository contents, or artifacts. Existing authenticated REST and dashboard artifact routes are unchanged.

## Tested TypeScript client example

The interoperability test uses the official TypeScript packages `@utcp/sdk` 1.2.0 and `@utcp/http` 1.1.14. It fetches Soyuz's manual, registers its tools, invokes `list_runs`, then invokes `create_run` with the `body_field` mapping and validates both response envelopes against the declared Zod output schemas.

```ts
import { UtcpClient, UtcpClientConfigSchema } from "@utcp/sdk";
import { HttpCallTemplateSerializer } from "@utcp/http";

const serializer = new HttpCallTemplateSerializer();
const client = await UtcpClient.create(process.cwd(), UtcpClientConfigSchema.parse({
  variables: {
    soyuz_CLIENT_API_TOKEN: process.env.CLIENT_API_TOKEN ?? "",
  },
  manual_call_templates: [serializer.validateDict({
    name: "soyuz",
    call_template_type: "http",
    http_method: "GET",
    url: "https://soyuz.example.com/utcp",
  })],
}));

try {
  const tools = await client.getTools();
  const runs = await client.callTool("soyuz.list_runs", { limit: 10 });
  const admission = await client.callTool("soyuz.create_run", {
    body: {
      repoUrl: "https://github.com/example/project",
      taskPrompt: "Update the project documentation and keep its API examples current.",
      idempotencyKey: "8c043c80-660e-4d78-903e-8ccf9f0aa5c9",
    },
  });
  console.log(tools.map((tool) => tool.name), runs, admission);
} finally {
  await client.close();
}
```

The test intercepts the Fetch boundary to route the official HTTP plugin's requests into the isolated Worker test environment. It verifies that discovery is unauthenticated, read and create calls carry the client bearer header, list arguments become query parameters, create fields become a JSON body, and Soyuz returns the declared envelopes.

## Local development and tests

Copy `.dev.vars.example` to `.dev.vars`, set distinct client, Kaseki, and worker tokens, and keep the explicit development loopback origin. The local UTCP manual will point to that origin. Use the official client example with `http://127.0.0.1:8787/utcp` when testing against `wrangler dev`.

Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:kaseki` for the repository checks. `tests/utcp.test.ts` covers discovery, manual validation, endpoint mapping, authentication segregation, creation defaults and idempotency, run/event projections, pagination, and cancellation. No UTCP client package is required in the Worker production dependency graph.

# Soyuz MCP interface

Soyuz exposes a client-facing remote MCP server in the same Cloudflare Worker as its REST API.

```text
CLI ──REST──┐
UI  ──REST──┼──> Soyuz shared run application ──> D1 and Queue ──> Kaseki
AI  ──MCP───┘
```

The MCP adapter calls the same application operations as the REST routes. It does not call Soyuz REST over internal HTTP, contact Kaseki directly, or keep run state in the MCP protocol layer. D1 remains the source of truth and the Queue remains the execution handoff.

## Endpoint and transport

```text
POST /mcp
```

The endpoint uses stateless Streamable HTTP through Cloudflare Agents SDK `agents@0.26.0` and `createMcpHandler()` with `@modelcontextprotocol/server@2.0.0`. It supports the SDK's current 2026-07-28 protocol and stateless clients using the published 2025 MCP protocol. It does not use a separate SSE-only transport or Durable Objects for MCP session state. The implementation follows the [Cloudflare Agents stateless MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers/).

## Authentication and security boundary

Requirement IDs: `MCP-AUTH-01`.

Requests may use `Authorization: Bearer $CLIENT_API_TOKEN` or OAuth access tokens issued by the Cloudflare Workers OAuth Provider. OAuth requires `soyuz:read`; `create_run` and `cancel_run` additionally require `soyuz:write`. `WORKER_API_TOKEN` is not accepted by `/mcp` and is never returned by a tool. Keep the client and worker secrets distinct in local and deployed configuration. OAuth is enabled only when its canonical public origin, GitHub OAuth credentials, KV binding, and explicit GitHub numeric-ID allowlist are configured.

MCP is a client interface to Soyuz's control plane. The private `/v1/worker/**` API remains the Kaseki execution-plane contract. MCP cannot claim, start, complete, fail, or otherwise manipulate worker lifecycle transitions. It does not contact a Kaseki host. Kaseki remains responsible for execution-context safety, host capacity, Docker, repository access, validation, detailed diagnostics, and publication.

The OAuth authorization-code flow uses PKCE and asks GitHub only for `read:user`; Soyuz stores the numeric account ID and checks the allowlist on every API request. Access tokens are bound to the Soyuz resource and protected-resource metadata is published for MCP client discovery. Keep the GitHub token transient and do not put a token in a tool definition or response. The same OAuth provider serves the private dashboard; its API is GET-only and includes artifact listing/downloads.

## V1 tools

Requirement IDs: `MCP-TOOLS-01`, `MCP-CREATE-01`, `MCP-PUBLISH-01`, `MCP-LIST-PAGE-01`, `MCP-READ-01`, `MCP-DATA-01`, `MCP-EVENTS-01`, `MCP-CANCEL-01`, `MCP-URL-REDACT-01`, `MCP-URL-MALFORMED-01`.

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `create_run` | `repoUrl`, `taskPrompt`; optional `ref`, `taskMode`, `publishMode`, `validationCommands`, `timeoutSeconds`, `idempotencyKey` | Creates canonical state and publishes through the normal Soyuz admission path. Omitted `publishMode` defaults to `none`; an explicit value is preserved. |
| `list_runs` | Optional `status`, `limit` (1–30), `cursor` | Returns summaries from the latest 30 retained runs and the next cursor. Read-only. |
| `get_run` | `runId` | Returns canonical state, lifecycle timestamps, compact outcome/publication summary, and cancellation state. Read-only. |
| `get_run_events` | `runId`; optional `after`, `limit` (1–200) | Returns a bounded page of stored operational events in sequence order. Read-only. |
| `cancel_run` | `runId` | Records cancellation intent through Soyuz and returns canonical state. State-changing. |

`list_runs.status` accepts the current Soyuz states: `admitting`, `queued`, `claimed`, `running`, `cancel_requested`, `cancelled`, `completed`, `failed`, and `admission_failed`.

Soyuz retains and exposes at most the latest 30 runs across all statuses. Status filters and cursors apply within that 30-run history window; older run details, events, and artifacts are not available.

The three read tools return structured data. Run details omit worker identity and claim lease fields, raw internal database fields, and arbitrary error objects. Repository URLs in MCP results omit user/password, query, and fragment components; if a persisted URL is malformed, MCP returns `about:invalid` so the read remains available without exposing the stored value. Event results contain Soyuz's bounded operational metadata and only allowlisted scalar payload fields; arbitrary event payload keys are omitted. MCP has no tool for stdout, stderr, raw Pi output, repository contents, files, or Kaseki artifacts; retained Kaseki artifacts are available only through authenticated REST/dashboard download routes.

`cancel_run` records intent. Queued and claimed runs may become `cancelled` immediately. Running work moves to `cancel_requested`; the Kaseki host observes that state and handles runtime cancellation under the existing worker contract. The tool does not directly terminate a Docker process.

## Safe creation retries

Requirement IDs: `MCP-IDEMPOTENCY-01`, `MCP-QUEUE-RETRY-01`.

Soyuz's existing UUID `idempotencyKey` mechanism also applies to MCP `create_run`; MCP has no second idempotency store. Supply a fresh UUID for each intended run and reuse that same key with the same normalized execution request when retrying. Soyuz returns the existing run for an equivalent request and returns `IDEMPOTENCY_KEY_REUSED` if the key is reused for different work. Without a key, separate MCP calls can create separate runs. When Queue publication is uncertain, the error says to retry with the same key while Soyuz reconciles the same run ID.

## Example

```text
User:
Run Kaseki against CyanAutomation/matmetrics and investigate the
authentication issue. Do not publish anything.

MCP:
create_run({
  repoUrl: "https://github.com/CyanAutomation/matmetrics",
  taskPrompt: "Investigate the authentication issue and propose a focused fix.",
  publishMode: "none",
  idempotencyKey: "d744c5a2-1d8f-4a2e-bc4d-6813d6fc0133"
})

Soyuz:
{
  runId: "...",
  status: "queued",
  publishMode: "none"
}
```

## Deployment follow-up

- Add the OAuth KV namespace ID to `wrangler.jsonc`, configure the GitHub OAuth app callback, and set the canonical origin and allowlist before enabling OAuth.
- Apply `0003_run_artifacts.sql` through the separately authorized production migration process before deploying the upload route.
- Verify the integration with an authorized disposable `publishMode: none` run; a read-only production preflight and bounded-run helper are documented in [deployment guidance](DEPLOYMENT.md#authorized-live-acceptance-check).

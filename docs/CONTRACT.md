# Soyuz transport contract

All Soyuz↔Kaseki messages use `contractVersion: "1"`, independent from either repository's package version. Unknown versions must be rejected without starting execution. API success responses use `{ "data": ..., "requestId": "..." }`; errors use `{ "error": { "code": ..., "message": ..., "requestId": ... } }` and may include safe validation details.

## Run request

`POST /v1/runs` accepts a JSON Kaseki execution request. Soyuz preserves the current field names and useful execution options: `repoUrl`, `projectName`, `ref`, `taskPrompt`, `changedFilesAllowlist`/`allowlist`, `maxDiffBytes`, validation commands and lint cleanup, `goalSetting`, `scouting`, `goalCheck`, `runEvaluation`, `taskMode`, `publishMode`, startup check settings, tracing IDs, and timeout. It accepts the current selected snake_case aliases and normalizes them to camelCase. The defaults match Kaseki's API: `ref: "main"`, `taskMode: "patch"`, `publishMode: "pr"`.

`taskPrompt` is required unless `startupCheck` is `true`. Validation is structural only. In particular, Soyuz does not assess shell commands, repository contents, publication credentials, or host readiness; Kaseki keeps its current execution-context admission checks.

V1 rejects `webhookConfig`. Kaseki's current webhook option can carry a signing secret. Passing it through both the D1 request record and Queue needs a defined secret-storage and webhook-delivery owner first. Direct Kaseki API callers can continue using that option until a separately versioned migration is designed.

Clients may send an RFC UUID in the request's `idempotencyKey`, the `Idempotency-Key` header, or both (if both are sent they must match). For the same key and equivalent normalized execution request, Soyuz returns the existing run with HTTP 200. Reusing a key for different execution input returns 409 `IDEMPOTENCY_KEY_REUSED`. If no key is provided, a retry is not deduplicated across separate requests.

Example:

```http
POST /v1/runs
Authorization: Bearer <CLIENT_API_TOKEN>
Idempotency-Key: d744c5a2-1d8f-4a2e-bc4d-6813d6fc0133
Content-Type: application/json
```

```json
{
  "repoUrl": "https://github.com/example/service",
  "ref": "main",
  "taskPrompt": "Add a health endpoint and update the API documentation.",
  "taskMode": "patch",
  "publishMode": "pr",
  "validationCommands": ["npm test"],
  "timeoutSeconds": 1800
}
```

Fresh admission returns HTTP 202 and an RFC 9562 UUIDv7 run ID. Existing Kaseki clients should not depend on the old `kaseki-N` format.

If `Queue.send()` throws, its outcome may be unknown: Cloudflare could have accepted the message while the response was lost. Soyuz returns 503 `QUEUE_PUBLISH_UNCERTAIN`, keeps the run in `admitting`, and retries the same run ID through its scheduled reconciler. After five unsuccessful attempts, the run becomes `admission_failed`. Callers should retry with the same idempotency key to retrieve the pending run.

## Queue message

Soyuz publishes the validated normalized request, not a D1 row:

```json
{
  "contractVersion": "1",
  "runId": "f8a0c4c5-d628-7b93-a7cf-4b4629a28853",
  "createdAt": "2026-10-02T12:00:00.000Z",
  "correlationId": "15870068-6723-4b70-9e9f-53b8271e032d",
  "requestId": "7867a1e3-ed9d-4f23-81b0-0b47c6831cdd",
  "request": {
    "repoUrl": "https://github.com/example/service",
    "ref": "main",
    "taskPrompt": "Add a health endpoint and update the API documentation.",
    "taskMode": "patch",
    "publishMode": "pr"
  }
}
```

Cloudflare Queues is at-least-once. A consumer must use `runId` as its stable deduplication key and check Soyuz state before execution. Soyuz does not expose a polling `/next-job` endpoint; configure the Queue's HTTP pull consumer directly.

## Worker reads and callbacks

Every worker request uses `Authorization: Bearer <WORKER_API_TOKEN>`, distinct from the client token.

- `GET /v1/worker/runs/:id` returns the canonical `status`, `cancelRequestedAt`, `claimExpiresAt`, `workerId`, stage, and update time. Kaseki uses it before start and while running.
- `POST /v1/worker/runs/:id/claim` body: `{ contractVersion, callbackId, workerId, leaseSeconds? }`. The default lease is 120 seconds (allowed range 30–300 seconds). A compare-and-set from `queued` to `claimed` selects one execution host.
- `POST /v1/worker/runs/:id/started` body: `{ contractVersion, callbackId, workerId, startedAt?, stage? }`.
- `POST /v1/worker/runs/:id/events` body: `{ contractVersion, eventId, workerId, type, stage?, step?, timestamp?, payload? }`. Event types are bounded operational events: stage/step changes, progress updates, heartbeat, validation completion, and publication completion. Each event is capped at 12 KB.
- `POST /v1/worker/runs/:id/completed` body: `{ contractVersion, callbackId, workerId, completedAt?, exitCode?: 0, summary?, publishedUrl?, changedFileCount? }`.
- `POST /v1/worker/runs/:id/failed` body: `{ contractVersion, callbackId, workerId, completedAt?, exitCode?, failureClass, failureMessage }`.
- `POST /v1/worker/runs/:id/cancelled` body: `{ contractVersion, callbackId, workerId, completedAt?, exitCode?, reason? }`.

Lifecycle callback IDs and event IDs must remain stable across retries. Replaying the same ID and payload is safe; reusing an ID for different data returns 409. Worker events are event metadata, not stdout/stderr or artifact uploads.

## Public endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | None | Minimal Worker/D1 health |
| `POST /v1/runs` | Client | Validate, persist, and enqueue |
| `GET /v1/runs` | Client | Filtered, cursor-paginated history |
| `GET /v1/runs/:id` | Client | Canonical run and normalized request |
| `GET /v1/runs/:id/events` | Client | Append-only event history |
| `POST /v1/runs/:id/cancel` | Client | Cancel queued work or record running cancellation intent |
| `POST /mcp` | Client | Stateless Streamable HTTP MCP tools |

Queued cancellation becomes terminal `cancelled` immediately; a later Queue delivery must be skipped. Claimed-but-not-started cancellation also becomes terminal `cancelled`; the Kaseki adapter must wait for `started` to succeed before launching execution. Running cancellation becomes `cancel_requested`; the worker polls and confirms with `/cancelled`. If execution completes or fails first, that terminal result is retained.

## Errors

Invalid JSON returns 400; structurally invalid run requests return 422; auth failure returns 401; unknown runs return 404; idempotency conflicts and invalid lifecycle transitions return 409; temporary D1 or Queue admission problems return 503. Internal stack traces and raw binding errors are not returned.

The MCP endpoint exposes only `create_run`, `list_runs`, `get_run`, `get_run_events`, and `cancel_run`. It uses the same client bearer credential and shared run operations as REST. `create_run` defaults an omitted `publishMode` to `none`; REST keeps its existing `pr` default. MCP does not expose `/v1/worker/**` lifecycle operations. See [the MCP interface and security boundary](MCP.md).

# Soyuz transport contract

Requirement IDs in this contract are indexed in [the test requirement map](TEST-REQUIREMENTS.md).

All Soyuz↔Kaseki messages use `contractVersion: "1"`, independent from either repository's package version. Unknown versions must be rejected without starting execution. API success responses use `{ "data": ..., "requestId": "..." }`; errors use `{ "error": { "code": ..., "message": ..., "requestId": ... } }` and may include safe validation details.

## Run request

Requirement IDs: `RUN-VALIDATE-01`, `RUN-IDEMPOTENCY-01`, `RUN-ADMISSION-01`, `QUEUE-RETRY-01`, `QUEUE-RECONCILE-01`.

`POST /v1/runs` accepts a JSON Kaseki execution request. Soyuz preserves the current field names and useful execution options: `repoUrl`, `projectName`, `ref`, `taskPrompt`, `changedFilesAllowlist`/`allowlist`, `maxDiffBytes`, validation commands and lint cleanup, `goalSetting`, `scouting`, `goalCheck`, `runEvaluation`, `taskMode`, `publishMode`, startup check settings, tracing IDs, and timeout. It accepts the current selected snake_case aliases and normalizes them to camelCase. The defaults match Kaseki's API: `ref: "main"`, `taskMode: "patch"`, `publishMode: "pr"`.

`taskPrompt` is required unless `startupCheck` is `true`. Validation is structural only. In particular, Soyuz does not assess shell commands, repository contents, publication credentials, or host readiness; Kaseki keeps its current execution-context admission checks.

`repoUrl` must be an absolute HTTPS URL on both REST and MCP submission paths. HTTP, SSH, file, and other schemes are rejected. This transport rule does not restrict HTTPS destinations; Kaseki must continue applying its host-side repository and network safety checks.

V1 rejects `webhookConfig`. Kaseki's current webhook option can carry a signing secret. Passing it through both the D1 request record and Queue needs a defined secret-storage and webhook-delivery owner first. Direct Kaseki API callers can continue using that option until a separately versioned migration is designed.

Clients may send an RFC UUID in the request's `idempotencyKey`, the `Idempotency-Key` header, or both (if both are sent they must match). For the same key and equivalent normalized execution request, Soyuz returns the existing run with HTTP 200 while that run remains in the newest-30 history window. Reusing a key for different execution input returns 409 `IDEMPOTENCY_KEY_REUSED`. After a run leaves that window, Soyuz keeps only its origin-scoped key, request fingerprint, and run ID in a deduplication ledger; matching reuse returns 410 `IDEMPOTENCY_KEY_EXPIRED` and does not create duplicate work. After migration `0004_run_origin_retry.sql`, keys are scoped by the authenticated origin. The Kaseki host must persist and reuse its key after an uncertain response.

`POST /v1/runs/:id/retry` accepts `{ "idempotencyKey": "<UUID>" }`. It creates one new run only when the source is terminal (`completed`, `failed`, `cancelled`, or `admission_failed`); the new run includes `retryOf` with the source UUID. Reusing that retry key replays the same new run. Retry and cancellation require the caller's origin to match the source run's origin. The scoped Kaseki credential is restricted to create/retry/cancel and must be distinct from `CLIENT_API_TOKEN`.

Retries of historical runs whose stored repository URL is not HTTPS return 409 `RUN_REPOSITORY_URL_UNSUPPORTED`; submit a new run with an HTTPS URL to continue that work.

Each run response includes an `origin` object derived from the matched credential (for example `{ "type": "kaseki", "id": "kaseki-prod" }`) and `retryOf` (null for a non-retry run). Neither field is accepted from the request body. The same trusted origin and retry lineage appear in the read-only dashboard.

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

Fresh admission returns HTTP 202 with a canonical RFC 9562 UUIDv7 `id` and a stable, user-facing `displayId` such as `soyuz-213`. Soyuz assigns display IDs in creation order and includes them in run create, read, list, worker-read, dashboard, and MCP responses. Keep using the UUID `id`/`runId` in API paths, worker callbacks, Queue messages, and deduplication; `displayId` is for showing or discussing runs with people. It is separate from Kaseki's host-local `kaseki-N` job ID. Existing Kaseki clients should not depend on the old `kaseki-N` format as Soyuz's canonical ID.

If `Queue.send()` throws, its outcome may be unknown: Cloudflare could have accepted the message while the response was lost. Soyuz returns 503 `QUEUE_PUBLISH_UNCERTAIN`, keeps the run in `admitting`, and retries the same run ID through its scheduled reconciler. After five unsuccessful attempts, the run becomes `admission_failed`; its failure message directs callers to check Queue availability and submit a new run with a new idempotency key. Before then, callers should retry with the same idempotency key to retrieve the pending run.

## Queue message

Requirement IDs: `QUEUE-MESSAGE-01`, `QUEUE-RECONCILE-01`.

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

Requirement IDs: `AUTH-REST-01`, `WORKER-READ-01`, `WORKER-CLAIM-01`, `WORKER-START-01`, `WORKER-EVENT-01`, `WORKER-COMPLETE-01`, `WORKER-FAIL-01`, `WORKER-PRESTART-FAIL-01`, `WORKER-CANCEL-01`, `CALLBACK-IDEMPOTENCY-01`, `RUN-LIVENESS-01`.

Every worker request uses `Authorization: Bearer <WORKER_API_TOKEN>`, distinct from the client token.

- `GET /v1/worker/runs/:id` returns both the canonical `runId` and human-facing `displayId`, plus `status`, `cancelRequestedAt`, `claimExpiresAt`, `workerId`, current `claimCallbackId`, stage, update time, `lastHeartbeatAt`, and `operationalHealth` (`unknown`, `healthy`, or `suspect_stalled`). Claim, display, and health fields are additive contract-v1 metadata and do not change lifecycle status.
- `POST /v1/worker/runs/:id/claim` body: `{ contractVersion, callbackId, workerId, leaseSeconds? }`. The default lease is 120 seconds (allowed range 30–300 seconds). A compare-and-set from `queued` to `claimed` selects one execution host.
- `POST /v1/worker/runs/:id/started` body: `{ contractVersion, callbackId, workerId, claimCallbackId?, startedAt?, stage? }`.
- `POST /v1/worker/runs/:id/events` body: `{ contractVersion, eventId, workerId, claimCallbackId?, type, stage?, step?, timestamp?, payload? }`. Event types are bounded operational events: stage/step changes, progress updates, heartbeat, validation completion, and publication completion. Each event is capped at 12 KB.
- `POST /v1/worker/runs/:id/completed` body: `{ contractVersion, callbackId, workerId, claimCallbackId?, completedAt?, exitCode?: 0, summary?, publishedUrl?, changedFileCount? }`.
- `POST /v1/worker/runs/:id/failed` body: `{ contractVersion, callbackId, workerId, claimCallbackId?, completedAt?, exitCode?, failureClass, failureMessage }`. It accepts an owned, live `claimed` run as well as an active run so Kaseki can persist a pre-execution admission failure without starting Docker.
- `POST /v1/worker/runs/:id/cancelled` body: `{ contractVersion, callbackId, workerId, claimCallbackId?, completedAt?, exitCode?, reason? }`. It accepts an owned, live `claimed` run as well as an active run so a confirmed pre-start cancellation can be recorded.
- `PUT /v1/worker/runs/:id/artifacts/:artifactId` streams an artifact with `Content-Length`, `X-Artifact-Name`, `X-Artifact-Kind`, `X-Soyuz-Worker-Id`, and `X-Soyuz-Claim-Callback-Id` headers. The worker ID and current claim ID must match the active run. Each file is limited to 25,000,000 bytes; a run can retain at most 100 artifacts.

The claim request's `callbackId` is also the per-attempt fencing token. New Kaseki hosts echo it on every later callback; Soyuz rejects an older token with 409 `STALE_CLAIM`, including when two controller instances accidentally reuse a `workerId`. The echoed field is optional for contract-v1 compatibility with older hosts; those hosts do not receive stale-callback protection. Lifecycle callback IDs and event IDs must remain stable across retries. Replaying the same ID and payload is safe; reusing an ID for different data returns 409. Worker events are event metadata, not stdout/stderr. Exact artifact retries with the same ID and metadata are idempotent; reusing an ID for different bytes or metadata returns 409.

`artifacts.uploaded` is a bounded terminal event containing only `status` (`complete` or `partial`), `uploadedCount`, `failedCount`, and `skippedCount`. The Kaseki adapter persists the report and its event ID before delivery, so retrying the terminal callback replays the same report safely. It does not include artifact contents or local filesystem paths.

`worker.heartbeat` updates `lastHeartbeatAt` and restores `operationalHealth: "healthy"`. Soyuz's five-minute stale-run reconciler changes only the health classification to `suspect_stalled` and appends `run.suspected_stalled`; it never changes lifecycle status or republishes work. A later heartbeat can restore health. See the [Kaseki integration policy](KASEKI-INTEGRATION.md#heartbeat-and-suspected-stalled-runs).

## Public endpoints

Requirement IDs: `HEALTH-DB-01`, `RUN-READ-REST-01`, `CANCEL-QUEUED-01`, `CANCEL-RUNNING-01`.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | None | Minimal Worker/D1 health |
| `POST /v1/runs` | Client | Validate, persist, and enqueue |
| `POST /v1/runs/:id/retry` | Client or scoped Kaseki | Retry a terminal run from the same origin with a new idempotency key |
| `GET /v1/runs` | Client | Filtered, cursor-paginated history across the newest 30 runs; `limit` is 1–30 |
| `GET /v1/runs/:id` | Client | Canonical run and normalized request |
| `GET /v1/runs/:id/events` | Client | Append-only event history |
| `GET /v1/runs/:id/artifacts` | Client | List retained artifact metadata |
| `GET /v1/runs/:id/artifacts/:artifactId` | Client | Download an artifact as an attachment |
| `POST /v1/runs/:id/cancel` | Client | Cancel queued work or record running cancellation intent |
| `POST /mcp` | Client key or OAuth | Stateless Streamable HTTP MCP tools |
| `GET /dashboard/` | Browser | Private read-only dashboard; requires OAuth for its API |
| `GET /dashboard/analysis/` | Browser | Optional OpenUI run-analysis page |
| `POST /dashboard/api/analysis/generate` | OAuth `soyuz:read` | Stream a generated OpenUI Lang program; does not change run state |

| `GET /dashboard/api/me` | OAuth `soyuz:read` | Current allowlisted GitHub account login |
| `GET /dashboard/api/**` | OAuth `soyuz:read` | Dashboard run/event/artifact reads |

Run history is limited to the newest 30 runs across all statuses. Status filters and cursors apply within that window, and details, events, and artifacts for older runs are unavailable. Soyuz culls older run rows and their associated data during its minutely retention sweep.

`POST /dashboard/api/analysis/generate` is the only POST exception under the dashboard API. It accepts a bounded `{ "prompt": "...", "mode": "generate" | "edit", "existingProgram"?: "..." }` JSON request and streams OpenUI Lang as server-sent events. It requires an authenticated, allowlisted `soyuz:read` token, uses only server-side provider credentials, and cannot create or mutate runs. Other non-GET dashboard API methods return 405. Provider configuration and deterministic local fixture mode are described in [OpenUI run analysis](OPENUI-ANALYSIS.md).

The dashboards display the authenticated GitHub login after verifying it through `/dashboard/api/me`. Sign-out revokes the dashboard's active OAuth access token through the OAuth token endpoint and clears the displayed run data. This ends the Soyuz dashboard session; it does not sign the user out of GitHub. The browser keeps the access token in memory, so reloading the page requires signing in again.

Queued cancellation becomes terminal `cancelled` immediately; a later Queue delivery must be skipped. Claimed-but-not-started cancellation also becomes terminal `cancelled`; the Kaseki adapter must wait for `started` to succeed before launching execution. Running cancellation becomes `cancel_requested`; the worker polls and confirms with `/cancelled`. If execution completes or fails first, that terminal result is retained.

## Errors

Requirement IDs: `AUTH-CONFIG-01`, `AUTH-ROTATE-01`, `HTTP-BODY-01`, `ERRORS-01`.

Request bodies larger than 96 KiB return 413 `REQUEST_TOO_LARGE`.

OAuth client registration fails closed with 503 `CLIENT_IP_UNAVAILABLE` if the connecting IP is absent or blank, rather than sharing a fallback rate-limit bucket.

Invalid JSON returns 400; structurally invalid run requests return 422; an absent or invalid caller key returns 401; a valid scoped Kaseki key used outside its create/retry/cancel permissions returns 403 `INSUFFICIENT_SCOPE`; a missing server-side API key returns 503 `AUTHENTICATION_UNAVAILABLE`; unknown runs return 404; expired idempotency replays return 410 `IDEMPOTENCY_KEY_EXPIRED`; idempotency conflicts and invalid lifecycle transitions return 409; temporary D1 or Queue admission problems return 503 with a user-facing message and request ID. Internal stack traces and raw binding errors are not returned. Soyuz keys are static bearer secrets without automatic expiry; rotation or revocation invalidates older values.

The MCP endpoint exposes only `create_run`, `list_runs`, `get_run`, `get_run_events`, and `cancel_run`. It uses the same client bearer credential and shared run operations as REST. `create_run` defaults an omitted `publishMode` to `none`; REST keeps its existing `pr` default. MCP does not expose `/v1/worker/**` lifecycle operations. See [the MCP interface and security boundary](MCP.md).

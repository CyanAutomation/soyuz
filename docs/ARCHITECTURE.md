# Architecture

```mermaid
flowchart TD
    CLI[CLI] -->|REST| REST[REST adapter]
    UI[Web UI and integrations] -->|REST| REST
    UI -->|GitHub OAuth, read-only| Dashboard[Private run dashboard]
    AI[AI clients] -->|Streamable HTTP at /mcp| MCP[MCP adapter]
    REST --> App[Shared run application operations]
    MCP --> App
    App --> D1[(D1: runs, events, artifact index)]
    App -->|versioned Queue message| Q[Cloudflare Queue]
    Q -->|HTTP pull, capacity controlled| K[Kaseki host]
    K -->|separate worker bearer API| Worker[Private worker routes]
    Worker --> D1
    Worker -->|claim-fenced upload| R2[(Private R2 artifacts)]
    Dashboard -->|authorized read| D1
    Dashboard -->|authorized download| R2
    K --> Docker[Disposable Docker workers]
    Docker --> Repo[Repository, Pi, validation, publication]
```

The REST and MCP adapters call the same run application operations. MCP does not make an internal HTTP request to `/v1`; it uses the same validation, idempotency, D1, Queue, read, event, and cancellation paths directly.

## Ownership boundary

Soyuz owns public control-plane authentication, request shape validation, run IDs, idempotent admission, canonical external state, cancellation intent, Queue publication, and operational event metadata. D1 remains the source of truth even while Kaseki is offline.

Kaseki owns host capacity, local scheduling, Docker containers, repository access, dependency preparation, Pi execution, safety/admission checks that need execution context, validation, diagnostic artifacts, and GitHub publication. Soyuz does not connect to a Kaseki host to launch work and does not attempt runtime preflight checks.

Messages are typed in Soyuz and carry `contractVersion: "1"`. The repositories do not share source code. A Kaseki consumer calls `GET /v1/worker/runs/:id` before start and while running, then reports lifecycle callbacks using the worker token.

## Run lifecycle

Requirement IDs: `LIFECYCLE-TRANSITIONS-01`, `LIFECYCLE-TERMINAL-01`, `CANCEL-CAS-01`, `WORKER-PRESTART-FAIL-01`, `WORKER-CLAIM-RECOVERY-01`, `LIFECYCLE-RACE-01`.

```mermaid
stateDiagram-v2
    [*] --> admitting
    admitting --> queued: Queue.send and D1 confirmation
    admitting --> admission_failed: definite Queue failure after retry limit
    admitting --> cancelled: client cancels during admission
    queued --> claimed: worker compare-and-set claim
    queued --> cancelled: client cancels before execution
    claimed --> running: worker started callback
    claimed --> failed: worker reports pre-start admission failure
    claimed --> admitting: claim lease expires
    claimed --> cancelled: client cancels before start
    running --> cancel_requested: client requests cancellation
    running --> completed: worker completion
    running --> failed: worker failure
    running --> cancelled: worker confirms cancellation
    cancel_requested --> completed: execution completed first
    cancel_requested --> failed: execution failed
    cancel_requested --> cancelled: worker confirms cancellation
    cancelled --> [*]
    completed --> [*]
    failed --> [*]
    admission_failed --> [*]
```

Transitions are checked in one domain state machine and written with a status compare-and-set. The short `claimed` lease prevents two hosts from starting one at-least-once Queue message. Kaseki must wait for the `started` callback to succeed before executing; if the host disappears before that callback, the scheduled reconciler expires the claim and republishes the same run ID. Terminal states do not return to active states. Duplicate worker callbacks are accepted when their stable event/callback ID and payload match the already stored operation.

## D1 model

`runs` holds searchable lifecycle and request metadata: repository/ref, modes, timestamps, current stage/status, worker and claim-lease identity, outcome, cancellation time, request/correlation IDs, idempotency key and request fingerprint. The validated execution request and small result summary are JSON columns. `last_heartbeat_at` and `operational_health` track execution liveness separately from lifecycle status. Indexes support newest-first history, status filtering, correlation lookup, and unique idempotency keys. Soyuz exposes and retains the newest 30 runs. Its minutely sweep moves old artifact object keys to a durable deletion queue, then deletes older runs, events, and artifact indexes. The queue retries R2 deletion when storage is unavailable without retaining old run records. A separate origin-scoped idempotency ledger keeps only the key, request fingerprint, and run ID after a run is culled, preventing duplicate work without making old run details reportable. A daily retention sweep also redacts request prompts and custom inputs after 365 days in terminal states; requests marked redacted cannot be retried.

`run_events` is append-only operational history. It records status changes and compact worker events with a per-database increasing sequence, a per-run idempotency ID, timestamps, stage/step, and bounded JSON payload. `run_artifacts` indexes private R2 objects with a 30-day expiry and a per-run limit. Kaseki uploads only its bounded summary, failure JSON, and diff outputs after execution; raw stdout/stderr remain on the host.

## Admission across D1 and Queues

D1 and Queues do not share a transaction. Soyuz writes `admitting` and its event, awaits `RUN_QUEUE.send()`, then batches the `queued` update and event in D1. A send exception is outcome-ambiguous, so the run stays `admitting`; a one-minute scheduled reconciler retries it with the same run ID and records `admission_failed` after five unsuccessful attempts. A successful send followed by a D1 failure can also create duplicate Queue messages, so the Kaseki consumer must deduplicate and check canonical status.

### Queue retention and recovery

The scheduled reconciler also republishes a `queued` run when its last update is at least 12 hours old. This recovers jobs whose Queue message expired while the execution host was unavailable. The recovery reserves an attempt with a D1 compare-and-set and appends `run.queue_recovery_attempted` in one batch before sending; a failed send is eligible for another attempt after 12 hours. It keeps the same run ID and leaves `queuedAt` unchanged. `updatedAt` records the latest recovery attempt. Duplicate delivery remains safe because Kaseki deduplicates by run ID and checks canonical state before execution. Keep Queue retention longer than the 12-hour recovery interval; the current production Queue retains messages for 24 hours.

Kaseki must leave a pulled message unacknowledged while Soyuz still reports `admitting`. After it reads `queued`, it claims the run with a worker-authenticated compare-and-set. It may execute only after its `started` callback moves the claim to `running`. If it sees a terminal state, it acknowledges and skips the message. A cancellation racing with publication may still leave a Queue message; canonical `cancelled` state makes it harmless.

## IDs, authentication, and compatibility

Requirement ID: `RUN-ID-UUIDV7-01`.

Soyuz generates RFC 9562 UUIDv7 IDs from the current millisecond timestamp and Web Crypto random bytes rather than Kaseki's historical `kaseki-N`. They are URL-safe and lexicographically time-sortable; D1 timestamps remain the source for deterministic history ordering. Callers must treat IDs as opaque strings.

Client and worker APIs have separate bearer secrets. Public health is unauthenticated. `/mcp` accepts the legacy client key or OAuth tokens; OAuth read and write scopes separate reads from run creation/cancellation. The private read-only dashboard uses GitHub OAuth and an explicit user-ID allowlist. Worker artifact uploads require the shared worker token plus the current worker and claim fencing IDs. These routes cannot be used to execute work directly. Kaseki remains responsible for execution-context safety, Docker, repository access, validation, and publication. See [the MCP interface](MCP.md) and [deployment guide](DEPLOYMENT.md) for OAuth configuration.

The caller migration can be gradual: direct callers may keep using the current Kaseki API while new or selected clients submit to Soyuz. Soyuz and Kaseki remain independently deployable.

## Cloudflare references

Guidance checked against Cloudflare's current documentation on 2026-10-03:

- [Workers](https://developers.cloudflare.com/workers/)
- [Queue JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
- [HTTP pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/)
- [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [D1 Worker API and transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Wrangler commands and type generation](https://developers.cloudflare.com/workers/wrangler/commands/)
- [Cloudflare Agents stateless MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers/)

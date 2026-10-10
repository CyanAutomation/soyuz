# Test requirement index

Tests carry the IDs below in their `it()` names; one test may cover more than one ID. These IDs provide a stable link from an assertion to its canonical behavior source. When a test or contract changes, update this index; do not reuse an ID for a different behavior. IDs whose source is marked as an internal invariant classify helper-level tests, not user-facing contract coverage.

| ID | Requirement | Canonical source |
| --- | --- | --- |
| `AUTH-MINIMUM-01` | Configured API tokens have a 16-character minimum. | [Deployment token configuration](DEPLOYMENT.md#api-token-configuration) |
| `AUTH-REST-01` | Client and worker routes use separate credentials. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks) |
| `CONTRACT-VERSION-01` | Soyuz/Kaseki messages use contract version 1. | [Transport contract: overview](CONTRACT.md) |
| `AUTH-CONFIG-01` | Missing server-side API keys return 503. | [Transport contract: errors](CONTRACT.md#errors) |
| `AUTH-ROTATE-01` | Rotated or revoked credentials are rejected; static tokens do not expire automatically. | [Transport contract: errors](CONTRACT.md#errors) |
| `HEALTH-DB-01` | Health and run history report D1 unavailability safely. | [Transport contract: public endpoints and errors](CONTRACT.md#public-endpoints) |
| `RUN-VALIDATE-01` | REST run requests are structurally validated before admission. | [Transport contract: run request](CONTRACT.md#run-request) |
| `RUN-ADMISSION-01` | Accepted REST runs persist and publish a versioned Queue message. | [Transport contract: run request and Queue message](CONTRACT.md#queue-message) |
| `QUEUE-MESSAGE-01` | Queue messages contain the validated request and stable run identity. | [Transport contract: Queue message](CONTRACT.md#queue-message) |
| `WORKER-READ-01` | A worker can read the canonical state before execution. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks) |
| `RUN-IDEMPOTENCY-01` | Equivalent normalized requests replay; key reuse for different work conflicts. | [Transport contract: run request](CONTRACT.md#run-request) |
| `QUEUE-RETRY-01` | Uncertain publication retries the same run ID and eventually fails admission. | [Transport contract: run request](CONTRACT.md#run-request) |
| `WORKER-CLAIM-01` | A claim is replay-safe and selects one worker. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks) |
| `WORKER-START-01` | Replaying a started callback preserves running state. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks) |
| `WORKER-EVENT-01` | Retried operational events are stored once. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks) |
| `CALLBACK-IDEMPOTENCY-01` | Replaying a callback or event with the same ID and payload is safe. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks) |
| `WORKER-COMPLETE-01` | Completion callbacks are replay-safe and terminal runs reject late starts. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks) |
| `WORKER-FAIL-01` | Failure callbacks accept an exact retry. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks) |
| `WORKER-PRESTART-FAIL-01` | An owned, live claimed run can record a pre-execution failure without entering running state. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks); [Architecture: run lifecycle](ARCHITECTURE.md#run-lifecycle) |
| `CANCEL-QUEUED-01` | Queued cancellation is terminal and rejects a late start. | [Transport contract: cancellation](CONTRACT.md#public-endpoints) |
| `CANCEL-RUNNING-01` | Running cancellation remains pending until the worker confirms it. | [Transport contract: cancellation](CONTRACT.md#public-endpoints) |
| `WORKER-CANCEL-01` | The worker can confirm cancellation through its callback route. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks) |
| `CANCEL-CAS-01` | A stale claimed-state cancellation cannot overwrite a run that has started. | [Architecture: run lifecycle](ARCHITECTURE.md#run-lifecycle) |
| `RUN-READ-REST-01` | REST history, detail, and unknown-run behavior are stable. | [Transport contract: public endpoints](CONTRACT.md#public-endpoints) |
| `RUN-LIVENESS-01` | A stale heartbeat marks an active run suspect without changing lifecycle state or requeueing it; a later heartbeat restores healthy status. | [Transport contract: worker reads and callbacks](CONTRACT.md#worker-reads-and-callbacks); [Kaseki heartbeat policy](KASEKI-INTEGRATION.md#heartbeat-and-suspected-stalled-runs) |
| `QUEUE-RECONCILE-01` | A stale admission is retried with the original run ID. | [Transport contract: run request](CONTRACT.md#run-request) |
| `WORKER-CLAIM-RECOVERY-01` | An abandoned claim expires and republishes the original run ID. | [Architecture: run lifecycle](ARCHITECTURE.md#run-lifecycle) |
| `LIFECYCLE-RACE-01` | Competing terminal outcomes commit only one terminal event. | [Architecture: run lifecycle](ARCHITECTURE.md#run-lifecycle) |
| `MCP-AUTH-01` | MCP accepts the client credential only and admits no request when authentication fails. | [MCP interface: authentication](MCP.md#authentication-and-security-boundary) |
| `MCP-TOOLS-01` | Streamable HTTP exposes exactly the five client-facing tools and their access hints. | [MCP interface: V1 tools](MCP.md#v1-tools) |
| `MCP-CREATE-01` | MCP creation uses shared admission and defaults publication to `none`. | [MCP interface: V1 tools](MCP.md#v1-tools) |
| `MCP-PUBLISH-01` | Explicit MCP publication modes are preserved. | [MCP interface: V1 tools](MCP.md#v1-tools) |
| `MCP-URL-REDACT-01` | Credentials and query tokens are removed from returned repository URLs. | [MCP interface: read data boundary](MCP.md#v1-tools) |
| `MCP-IDEMPOTENCY-01` | MCP creation replays equivalent requests and rejects reused keys for different work. | [MCP interface: safe creation retries](MCP.md#safe-creation-retries) |
| `MCP-VALIDATE-01` | Invalid MCP input returns a validation error without persistence or publication. | [Transport contract: run request](CONTRACT.md#run-request) |
| `MCP-QUEUE-RETRY-01` | Uncertain MCP admission tells callers to reuse the same idempotency key. | [MCP interface: safe creation retries](MCP.md#safe-creation-retries) |
| `MCP-LIST-PAGE-01` | MCP listing is bounded, newest-first, and cursor pages do not repeat runs. | [MCP interface: V1 tools](MCP.md#v1-tools) |
| `MCP-READ-01` | MCP details omit internal fields and unknown IDs return `RUN_NOT_FOUND`. | [MCP interface: read data boundary](MCP.md#v1-tools) |
| `MCP-DATA-01` | MCP read results omit credentials and private worker/database fields. | [MCP interface: read data boundary](MCP.md#v1-tools) |
| `MCP-URL-MALFORMED-01` | Malformed persisted URLs return `about:invalid` without exposing stored values. | [MCP interface: read data boundary](MCP.md#v1-tools) |
| `MCP-EVENTS-01` | MCP event pages are ordered, cursor-based, and omit raw output and worker identity. | [MCP interface: read data boundary](MCP.md#v1-tools) |
| `MCP-CANCEL-01` | MCP cancellation uses canonical queued, running, and terminal transitions. | [MCP interface: cancellation](MCP.md#v1-tools) |
| `LIFECYCLE-TRANSITIONS-01` | The state machine permits the documented lifecycle transitions. | [Architecture: run lifecycle](ARCHITECTURE.md#run-lifecycle) |
| `LIFECYCLE-TERMINAL-01` | Terminal states cannot return to active states. | [Architecture: run lifecycle](ARCHITECTURE.md#run-lifecycle) |
| `RUN-ID-UUIDV7-01` | Run IDs encode the millisecond timestamp and sort across millisecond boundaries. | [Architecture: IDs, authentication, and compatibility](ARCHITECTURE.md#ids-authentication-and-compatibility) |
| `HTTP-BODY-01` | JSON body size is measured in bytes and capped at 96 KiB. | [Transport contract: errors](CONTRACT.md#errors) |
| `ERRORS-01` | Invalid run requests return a stable 422 error response. | [Transport contract: errors](CONTRACT.md#errors) |

## Internal helper invariants

These tests protect implementation helpers and are useful for direct callers and mutation checks, but they do not represent behavior that a client can exercise through the JSON API. Keep them separate from user-facing requirement coverage when scoring the suite.

Run `npm run test:mutation:unit` to measure how well the focused helper and lifecycle unit tests detect mutations. This pilot is not part of the regular CI test command.

The initial local run reported a 90.63% mutation score across 113 mutants. It also reported three timeouts, 49 type-check errors, and six survivors. Five survivors are static transition-array mutants: replacing a transition list with an empty list directly makes the transition test fail, although Stryker reports those mutants as surviving. Treat this score as a baseline signal, not a gate, until the Vitest runner's static-mutant behavior is resolved. The remaining survivor changes UUID error-message text, which is not part of the public contract.

| ID | Internal invariant |
| --- | --- |
| `RUN-ID-BOUNDS-01` | The UUIDv7 encoder rejects timestamps outside its 48-bit field. |
| `SERIALIZE-CYCLE-01` | Stable serialization detects circular references. |
| `SERIALIZE-SHARED-01` | Reusing an object in separate branches is not mistaken for a cycle. |
| `SERIALIZE-ARRAY-01` | Stable serialization preserves nested array values and deterministic object-key ordering. |
| `SERIALIZE-PRIMITIVE-01` | Stable serialization returns a string for primitive values, mapping undefined to null. |
| `SERIALIZE-SHA256-01` | The SHA-256 helper returns the standard hexadecimal digest. |

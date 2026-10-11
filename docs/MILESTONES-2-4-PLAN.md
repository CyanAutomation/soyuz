# Kaseki/Soyuz milestones 2–4 delivery record

This is a historical handoff snapshot. Its verification notes describe the state at that handoff, not the current deployment state.

## Base state inspected

- Soyuz was reset to `main` and fast-forwarded from `origin/main` at `4d2514b` before work began. Contract v1 already defined Queue admission, worker reads/claim/start/events/terminal callbacks, callback IDs, and claim recovery.
- Kaseki was reset to `main` and fast-forwarded from `origin/main` at `bdbc2b82` before work began. Its scheduler persists queued work before execution, uses the shared jobs index, and recovers queued jobs while classifying interrupted running jobs as `api_restart`.
- Kaseki already supplied task safety admission, template and publish checks, Docker lifecycle, cancellation, progress events, results storage, and Prometheus metrics; the adapter reuses those services.
- Each accepted claim has a `claimCallbackId` derived from its unique claim callback ID. Started, event/heartbeat, and terminal callbacks must match the latest claim, even if a worker ID is accidentally reused. A stale `running` run is still operator-review only; Soyuz never takes it over automatically.

## Delivered

### Milestone 2 — Kaseki adapter

- Added the opt-in host adapter, version-1 request validation, Soyuz worker client, and Cloudflare HTTP pull/ack/retry client. The default remains `SOYUZ_ENABLED=false`.
- Added capacity-limited pulls, `Retry-After` handling, capped retry delays, a required documented DLQ policy, and strict rejection of unsupported request fields/versions and `webhookConfig`.
- Added durable local Soyuz run identity to Kaseki's existing jobs index and scheduler deduplication by Soyuz run ID.
- Added a scheduler gate: a new run cannot launch Docker before local persistence and accepted `/started`; on restart, queued Soyuz work waits for canonical state reconciliation. The Queue lease is acknowledged after durable local handoff and start authorization.
- Kept Cloudflare Queue credentials separate from the Soyuz Worker token. Queue IDs remain transient; callbacks and logs use run/correlation IDs, and external payloads omit prompts, logs, source, and artifacts.

### Milestone 3 — Distributed behavior and recovery

- Added simulated adapter tests for lost Queue acknowledgement/redelivery, two competing hosts, and pre-start cancellation; contract tests cover request validation and direct/base64 Queue bodies.
- Added focused tests for the HTTP Queue field names, ack/retry formats, backoff headers, scheduler start gating, post-restart revalidation, outbox durability, and cancellation completing successfully during a cancellation race.
- The adapter does not retry an active run on heartbeat loss. Kaseki recovery reports interrupted local runs as failure and does not replay them automatically.

### Milestone 4 — Operational resilience

- Added a persistent local callback outbox with stable payload IDs, retry/backoff with jitter, a delivery lease, backlog warnings, a finite pending cap, and Queue intake pause at the cap.
- Added bounded active-run heartbeat and stage callbacks, separate Soyuz D1 heartbeat metadata, and a five-minute stalled-run classifier with an operational event/log. A later heartbeat restores `healthy`; lifecycle status is unchanged.
- Added Kaseki metrics and operator documentation for setup, failure boundaries, safe retry, recovery, monitoring, and rollback.

## Handoff and recovery policy

Kaseki acknowledges the Queue message only after (1) Soyuz claim acceptance, (2) durable local run mapping/job persistence, (3) Soyuz `/started` success, and (4) durable local start authorization. If the acknowledgement response is lost, redelivery resolves by the durable Soyuz run ID. This is at-least-once delivery with local deduplication, not an exactly-once guarantee.

An expired `claimed` lease may be recovered by Soyuz's existing admission reconciler because the scheduler gate prevents a claimed-but-not-started execution from running. A `running` run with stale heartbeat is marked `suspect_stalled` and never requeued by the reconciler. If the host and persistent volume are permanently lost, contract v1 has no automated fencing/takeover operation; operators must verify the previous Docker execution stopped before a separately approved manual recovery.

## Verification at milestone handoff

Soyuz unit/API tests and Kaseki type/unit checks were run locally. The Kaseki guide contained a disposable non-publishing smoke-test procedure. At that handoff, no production migration, Worker deployment, live Queue consumption, or live execution had been performed. See the [deployment guide](DEPLOYMENT.md) for current rollout procedures and the [test requirement index](TEST-REQUIREMENTS.md) for tracked behavior.

The HTTP pull implementation follows the current official [Cloudflare pull consumer](https://developers.cloudflare.com/queues/configuration/pull-consumers/), [dead-letter queue](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), and [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/) documentation.

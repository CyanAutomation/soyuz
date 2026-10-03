# Kaseki integration follow-up

This follow-up is required before Soyuz can dispatch real runs. The current repository implements only the Soyuz side; no `kaseki-agent` files were changed here.

## Required host configuration

1. Configure the Soyuz base URL and a dedicated `WORKER_API_TOKEN` on each Kaseki host using the host's secret manager. Keep Cloudflare Queue credentials separate from the Soyuz callback token.
2. Configure the Cloudflare account ID, Queue ID, queue API token, pull endpoint, and execution capacity on the Kaseki host. Create a scoped Cloudflare API token with Queue read and write permissions; the pull API also needs write access to acknowledge or retry messages.
3. Enable HTTP pull on the Queue with `npx wrangler queues consumer http add soyuz-runs` or the Cloudflare dashboard. Current Cloudflare guidance says HTTP pull is not configured with a `type = "http_pull"` Wrangler binding. Use one Queue consumer mode at a time.
4. Pull only when the Kaseki host can durably accept the number of messages requested. Use the Queue API's `visibility_timeout_ms` and batch size to match its execution/handoff time. When capacity is unavailable, use the Queue acknowledgement endpoint's `retries` list with a delay; do not acknowledge and discard.

The Cloudflare HTTP pull endpoints are `POST /client/v4/accounts/{account_id}/queues/{queue_id}/messages/pull` and `POST /client/v4/accounts/{account_id}/queues/{queue_id}/messages/ack`. Pull responses include `lease_id`; ack requests list acknowledged lease IDs in `acks` and delayed messages in `retries`.

## Consumer flow

1. Pull only within available execution capacity. Decode the Queue message and validate `contractVersion === "1"`, `runId`, timestamps, and the run request against a Kaseki-owned adapter schema. Reject unsupported versions safely and send an operational alert; do not run an unknown payload.
2. Before scheduling, call `GET /v1/worker/runs/:id` with the worker token. If Soyuz reports `admitting`, retry the lease after a delay without acknowledging. If the run is cancelled or another terminal state, acknowledge and skip it. If it is already `claimed` by another worker, retry after a delay. If it is `queued`, the run is eligible for a claim.
3. Preserve Kaseki's existing safety gate, publish-mode credential checks, template/readiness validation, and execution-specific admission policy before starting the job. Soyuz intentionally performs only structural control-plane validation.
4. POST `/v1/worker/runs/:id/claim` with a stable callback ID, worker ID, and a 30–300 second lease (default 120). This D1 compare-and-set moves `queued → claimed`; only the winning host may persist and schedule the run. If the claim fails, do not execute. Retry or acknowledge only after reading canonical state and following the duplicate rules below.
5. Add a durable `externalRunId`/Soyuz run ID mapping to Kaseki's persisted job record and make local scheduler submission idempotent by that ID. Kaseki currently generates `kaseki-N` IDs and the scheduler's existing HTTP idempotency store is outside the Queue consumer path; calling `submitJob()` a second time for the same Queue delivery would create a second run.
6. Use the existing `JobPersistenceManager.persistQueuedJob()` boundary as the model for a durable handoff: write the job plus its Soyuz ID mapping and local restart ownership claim before acknowledging the Queue lease. The existing scheduler persists queued jobs before processing its local FIFO queue and recovers claimed queued jobs on restart. Configure a persistent results/index volume on the execution host. If that durable write fails, leave the lease unacknowledged and retry it.
7. Acknowledge only after that durable Kaseki acceptance succeeds. This is the chosen handoff point: Kaseki has taken durable responsibility for the claimed run. If the HTTP ack call fails after local persistence, a redelivery finds the Soyuz ID mapping, does not enqueue a second job, and safely retries the ack. Do not wait until task completion to acknowledge; use Kaseki's durable scheduler/recovery path after handoff.
8. Do not let Kaseki execute the job until it has POSTed `/started` and received success. That callback atomically changes `claimed → running`; its worker ID must match the claim owner. The current `submitJob()` begins processing after persistence, so add a scheduler start hook/gate that can report start before launching Docker. If the lease expires or Soyuz rejects `started`, remove the local pending attempt without running it.
9. Convert only operational events from Kaseki progress tracking to Soyuz events, with stable UUID `eventId`s. Keep raw progress logs, stdout/stderr, analysis, and artifacts in Kaseki's existing result directory; do not copy arbitrary log lines into D1.
10. While a job is running, periodically call worker-authenticated `GET /v1/worker/runs/:id`. When `status` becomes `cancel_requested`, call the existing Kaseki scheduler cancellation path, allow its process-exit cleanup to finish, then POST `/cancelled` with a stable callback ID. If work completes or fails before cancellation takes effect, POST the corresponding terminal result instead.
11. On terminal Kaseki state, POST `/completed` for success, `/failed` for execution or quality-gate failure, and `/cancelled` when Kaseki's `failureClass` is `cancelled`. Include compact summary metadata only. Retry network failures with the same callback ID and payload; Soyuz treats callback delivery as at-least-once.
12. Maintain a durable callback retry/outbox or replay terminal callbacks during Kaseki recovery. Kaseki's current persistence recovery marks previously running jobs `failed` with `failureClass: api_restart`; the adapter must report that terminal outcome to Soyuz after restart so Soyuz does not remain `running` forever.

## Duplicate and race handling

- If the same `runId` is already durably queued or running on this host, do not schedule another Kaseki job. If another host owns a live `claimed` run, retry the lease until that claim starts or expires. If a different host owns a `running` run, acknowledge the duplicate delivery and do not start another copy.
- Two hosts can both read `queued`, but only one `POST /claim` can win the D1 compare-and-set. If a host's claim or started callback receives 409, it must not execute; stop or discard its local pending attempt and follow the existing recovery path.
- A cancellation can race with a Queue pull. If the worker sees `cancelled`, acknowledge and skip. If a host has already started, it sees `cancel_requested` by polling and stops through the scheduler.
- Queue delivery is at least once. Do not treat Queue lease IDs as run identity; they change across deliveries. Use Soyuz `runId` for durable deduplication and lease IDs only for Queue ack/retry operations.
- If the host cannot persist job ownership, cannot reach Soyuz to check canonical state, or does not understand the contract version, it must retry rather than acknowledge the message.

## Migration sequence

Keep direct `client → Kaseki API` use available while wiring the host consumer. Then move selected callers to `client → Soyuz → Queue → Kaseki`. Kaseki's direct API can remain as a local/admin interface; the two repositories stay independently deployed and communicate only through this versioned contract.

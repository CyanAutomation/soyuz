# Kaseki integration

Milestones 2–4 implement the opt-in Kaseki host adapter in [`kaseki-agent`](https://github.com/CyanAutomation/kaseki-agent/tree/main/src/integrations/soyuz). Kaseki owns execution, safety admission, Docker, repository access, validation, artifacts, and publication. Soyuz remains the control plane and canonical run history.

See the Kaseki [host setup and operations guide](https://github.com/CyanAutomation/kaseki-agent/blob/main/docs/SOYUZ_INTEGRATION.md) for environment variables, secret files, failure recovery, metrics, and the controlled smoke-test procedure. This repository documents the cross-service behavior and the additional Soyuz liveness change.

## Handoff and authorization

The Kaseki API service starts the adapter only when `SOYUZ_ENABLED=true`; standalone Kaseki API and CLI runs remain the default. The adapter validates contract version 1, checks canonical run state, preserves Kaseki readiness, template/publish, credential, and task safety gates, then claims the Soyuz run. It writes the run ID mapping and queued job through Kaseki's existing `JobPersistenceManager`, posts `/started`, durably records the authorization, and only then opens the scheduler gate for Docker.

The Queue message is acknowledged after local durable acceptance and successful start authorization, not after coding finishes. If the ack response is lost, redelivery resolves by Soyuz `runId` and reuses the same local job. Delivery is at least once; no exactly-once execution guarantee is made. The full failure-boundary table and operator recovery policy are maintained in the Kaseki guide.

Claim lease IDs are used only to acknowledge/retry Queue messages. Soyuz run IDs are the durable deduplication key. Host IDs must be stable and unique per execution host. A second host cannot execute a run owned by another host. A stale heartbeat does not release ownership or permit a takeover.

## Callback and cancellation behavior

Kaseki sends bounded stage-change and heartbeat events; it does not upload prompts, logs, source, or artifacts. Started, event, and terminal callback IDs are stable across retries. Terminal callbacks are written atomically with the local terminal job into a durable outbox, retried with bounded exponential backoff and jitter, and compacted after delivery. The outbox pauses Queue intake at its configured hard cap to bound local storage growth.

Kaseki polls canonical status while an execution is active. It applies `cancel_requested` through its existing cancellation path and sends `/cancelled` after local cleanup finalizes. If completion wins the race, the completion callback is retained.

## Heartbeat and suspected stalled runs

Contract version 1 exposes `lastHeartbeatAt` and `operationalHealth` on worker and client run reads. Heartbeats refresh a dedicated D1 timestamp and mark health `healthy`; they do not change lifecycle state. A five-minute cron threshold marks an active run `suspect_stalled` and emits one bounded `run.suspected_stalled` event/log for the stale heartbeat. Recovery by a later heartbeat restores `healthy`.

`operationalHealth` is separate from lifecycle status. A suspect run remains `running` or `cancel_requested`; Soyuz never automatically requeues it. This protects against duplicate execution when a Kaseki controller or network is unavailable but its Docker process is still running. The Kaseki API restart path reports `api_restart` through its outbox once the persistent host is back. A permanently lost host with lost local state requires an operator to verify execution has stopped and follow a separately approved recovery procedure; contract v1 does not provide automatic takeover or fencing.

## Queue retry and dead-letter policy

Configure the Cloudflare HTTP pull consumer with a finite retry limit and a dead-letter queue. Kaseki retries malformed or unsupported messages and never executes them. Cloudflare deletes messages at the retry limit when no DLQ is configured, so a DLQ is required for safe poison-message review. Do not replay a DLQ message until the contract/configuration cause is corrected.

Current Queue HTTP pull request fields use `visibility_timeout_ms` and `batch_size`; the lease timeout is bounded to 12 hours and the batch size to 100. Queue authentication requires a separate bearer token with Queue read and write permissions. The implementation follows current [Cloudflare pull consumer](https://developers.cloudflare.com/queues/configuration/pull-consumers/) and [dead-letter queue](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) behavior.

## Database migration and rollout

This change adds migration `0002_run_liveness.sql`, which adds nullable heartbeat time and a separate health classification to existing run rows. It keeps contract version 1 and does not add a new canonical lifecycle state. Apply the remote migration through the existing separately authorized production migration procedure before deploying code that reads the new columns. The change has not been deployed here.

Roll out the Kaseki adapter against a non-production Queue first. Verify a `publishMode: none` completion and failure, a cancellation, duplicate delivery, callback retry, and restart reconciliation before enabling routine intake. See [deployment and local smoke-test guidance](DEPLOYMENT.md).

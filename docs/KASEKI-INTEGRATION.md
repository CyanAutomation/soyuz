# Kaseki integration

Milestones 2–4 implement the opt-in Kaseki host adapter in [`kaseki-agent`](https://github.com/CyanAutomation/kaseki-agent/tree/main/src/integrations/soyuz). Kaseki owns execution, safety admission, Docker, repository access, validation, artifacts, and publication. Soyuz remains the control plane and canonical run history.

See the Kaseki [host setup and operations guide](https://github.com/CyanAutomation/kaseki-agent/blob/main/docs/SOYUZ_INTEGRATION.md) for environment variables, secret files, failure recovery, metrics, and the controlled smoke-test procedure. This repository documents the cross-service behavior and the additional Soyuz liveness change.

## Handoff and authorization

The Kaseki API service starts the adapter only when `SOYUZ_ENABLED=true`; standalone Kaseki API and CLI runs remain the default. The adapter validates contract version 1, checks canonical run state, preserves Kaseki readiness, template/publish, credential, and task safety gates, then writes a per-attempt claim intent to Kaseki's existing persistent jobs index before claiming the Soyuz run. After claim success, it writes the run ID mapping and queued job, posts `/started`, durably records the authorization, and only then opens the scheduler gate for Docker. A lost claim response can be reconciled after restart from the saved intent without creating a speculative local job.

The Queue message is acknowledged after local durable acceptance and successful start authorization, not after coding finishes. If the ack response is lost, redelivery resolves by Soyuz `runId` and reuses the same local job. Delivery is at least once; no exactly-once execution guarantee is made. The full failure-boundary table and operator recovery policy are maintained in the Kaseki guide.

## Submission identity, provenance and retries

Kaseki uses a dedicated `KASEKI_SUBMISSION_API_TOKEN`, distinct from `CLIENT_API_TOKEN`. Soyuz accepts it only for run creation, canonical retry and cancellation. API and dashboard `origin` fields come from the credential that authenticated the request and the configured `KASEKI_SUBMISSION_IDENTITY`; request fields cannot override provenance. Idempotency keys are unique within the authenticated origin, so a Kaseki caller and a general client can use the same UUID independently.

Kaseki persists the caller's UUID idempotency key before forwarding a submission and reuses it after network timeouts. Soyuz's canonical retry route only accepts completed or failed source runs, creates a new canonical UUID, and records `retryOf`. Reusing the retry key returns the same new run. Requests containing `webhookConfig` are rejected when Soyuz routing is enabled; per-run webhook secrets stay on the execution host and are not copied to D1 or Queue messages.

Queue lease IDs are used only to acknowledge/retry Queue messages. Soyuz run IDs are the durable deduplication key. Host IDs must be stable and unique per execution host. Each accepted claim also supplies a `claimCallbackId` that fences started, event/heartbeat, and terminal callbacks from older execution attempts, even if a host ID is accidentally reused. A second host cannot execute a run owned by another host. A stale heartbeat does not release ownership or permit a takeover.

## Callback and cancellation behavior

Kaseki sends bounded stage-change and heartbeat events; it does not upload prompts or raw logs. At finalization it may upload the allowlisted summary, failure JSON, and diff artifacts described in the Kaseki host guide. Artifact upload is bound to the current worker and claim ID. Started, event, and terminal callback IDs are stable across retries. Terminal callbacks are written atomically with the local terminal job into a durable outbox, retried with bounded exponential backoff and jitter, and compacted after delivery. The outbox pauses Queue intake at its configured hard cap to bound local storage growth.

Kaseki polls canonical status while an execution is active. It applies `cancel_requested` through its existing cancellation path and sends `/cancelled` after local cleanup finalizes. If completion wins the race, the completion callback is retained.

## Heartbeat and suspected stalled runs

Contract version 1 exposes `lastHeartbeatAt` and `operationalHealth` on worker and client run reads, and exposes the current claim token on worker reads only. Heartbeats refresh a dedicated D1 timestamp and mark health `healthy`; they do not change lifecycle state. A five-minute cron threshold marks an active run `suspect_stalled` and emits one bounded `run.suspected_stalled` event/log for the stale heartbeat. Recovery by a later heartbeat restores `healthy`.

`operationalHealth` is separate from lifecycle status. A suspect run remains `running` or `cancel_requested`; Soyuz never automatically requeues it. This protects against duplicate execution when a Kaseki controller or network is unavailable but its Docker process is still running. The Kaseki API restart path reports `api_restart` through its outbox once the persistent host is back. A permanently lost host with lost local state requires an operator to verify execution has stopped and follow a separately approved recovery procedure; contract v1 does not provide automatic takeover of a running execution.

## Queue retry and dead-letter policy

Configure the Cloudflare HTTP pull consumer with a finite retry limit and a dead-letter queue. Kaseki retries malformed or unsupported messages and never executes them. Cloudflare deletes messages at the retry limit when no DLQ is configured, so a DLQ is required for safe poison-message review. Do not replay a DLQ message until the contract/configuration cause is corrected.

Current Queue HTTP pull request fields use `visibility_timeout_ms` and `batch_size`; the lease timeout is bounded to 12 hours and the batch size to 100. Queue authentication requires a separate bearer token with Queue read and write permissions. The implementation follows current [Cloudflare pull consumer](https://developers.cloudflare.com/queues/configuration/pull-consumers/) and [dead-letter queue](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) behavior.

## Database migration and rollout

The schema includes `0002_run_liveness.sql` for heartbeat and operational health, `0003_run_artifacts.sql` for artifact metadata and the per-run cap, and `0004_run_origin_retry.sql` for authenticated provenance, origin-scoped idempotency and canonical retry lineage. It keeps contract version 1 and does not add a new canonical lifecycle state. Apply pending remote migrations through the separately authorized production migration procedure before deploying code that reads the new columns.

As of 2026-10-17, the production check found migrations `0001`–`0003` applied, `/health` healthy, the Worker bound to D1 and the `soyuz-runs` producer Queue, and an HTTP pull consumer with `max_retries=3`, a DLQ, and a 30-second visibility timeout. Queue peek was empty and two canonical runs were failed; no active or completed run was present. The Queue retains messages for 24 hours. This is infrastructure readiness only, not a successful Kaseki handoff. Migration `0004` and the scoped submission credential must be deployed before submission routing is enabled.

## Compatibility matrix

| Kaseki host | Soyuz Worker and D1 | Behavior |
| --- | --- | --- |
| Direct API submission; pre-claim-fencing host | Contract-v1 Worker with migrations `0001`–`0003` | Legacy local Kaseki run IDs; no Kaseki provenance or canonical retry lineage. |
| Claim-fenced Queue adapter | Claim-fenced Worker with migrations `0001`–`0003` | Queue callbacks use per-claim fencing; direct Kaseki submissions remain available. |
| Submission routing enabled | Worker with migration `0004` and `KASEKI_SUBMISSION_API_TOKEN` | Soyuz UUIDs are canonical, provenance is authenticated, and retries record `retryOf`. |
| Submission routing enabled | Worker without migration `0004` or scoped token | Incompatible; keep submission routing disabled. |

Roll out the compatible Soyuz Worker only after its D1 migrations are applied and verified. Deploy Kaseki with claim fencing and submission routing disabled, configure the dedicated token, prove the contract in a non-production environment, then enable production routing separately. Verify a `publishMode: none` completion and failure, a cancellation, duplicate delivery, callback retry and restart reconciliation before enabling routine intake. A production smoke submission creates executable work; use an explicitly authorized disposable repository and Queue. See [deployment and local smoke-test guidance](DEPLOYMENT.md).

# Phase ABC persistence and retention

**Status:** Source implementation is prepared on the coordinated `codex/phase-abc-persistence` branches. Production migration 0011, cleanup activation, and a live artifact canary have not been run. They require a separately approved operational change.

## Ownership and storage boundaries

Soyuz owns the canonical run identity, lifecycle, retention deadline, artifact metadata, publication lifecycle, and cleanup coordination. Cloudflare D1 stores bounded structured records and indexes. The private `soyuz-artifacts` R2 bucket stores artifact bytes. Executors upload through claim-fenced Soyuz endpoints and receive no R2 credentials. Senku remains a decisioning service; Kirisame remains the GitHub publication boundary; neither owns a second execution journal. Rusty Fossil's SQLite store is a short-lived recovery and delivery journal, not an artifact archive. No artifact microservice or additional storage provider is introduced.

Factory-owned run data includes request and prompt fields, outcomes, events, worker liveness, generic artifact metadata and bytes, decision evidence returned for persistence, publication manifests/intents/attempts/events, idempotency rows, and bounded cleanup/reconciliation records. Standalone operational counters expire within 90 days. Source code, schema/migrations, contract definitions, active configuration, independently managed credentials, and GitHub's published commits/PRs are outside this run-history deletion policy. Cloudflare or inference-provider backup/log retention is provider managed and is not represented as physical deletion by this application policy.

## Retention policy

Policy version 1 sets a hard maximum of 90 days, anchored to Soyuz's canonical `runs.created_at` in UTC. Every run-associated record and artifact has `expires_at = canonicalRunCreatedAt + 90 days`. Standalone diagnostics use their own creation day plus 90 days. Upload, reads, run updates, evaluation, publication retries, reconciliation, migrations, and operator activity cannot extend a deadline. Publication pins are clamped to the run expiry. Idempotency/replay protection is supported for the same 90-day period; it is not an indefinite deduplication guarantee.

Run list display still defaults to 30 rows and accepts bounded pagination up to 100. That page size does not delete history. Outcome aggregation reads all unexpired runs while limiting each returned run projection to 100 entries and reporting truncation.

At the exact deadline, run, event, request, artifact, and publication read/dispatch paths fail closed. The minutely maintenance pass selects at most 30 expired runs, expires associated records, places R2 keys in the durable deletion queue, and processes at most 1,000 queued objects per invocation in batches of 100. The same pass retries failed deletes. A bounded consistency scan checks 50 D1-to-R2 references and 100 R2 keys per prefix (`runs/` and `publication-manifests/`) per invocation. Objects without a D1 index that are older than ten minutes enter the durable delete queue. Missing indexed objects become unavailable in D1 and downgrade run artifact delivery to `partial`. Cleanup/reconciliation metrics are structured, aggregated, and themselves expire within 90 days. R2 lifecycle cleanup is only a secondary safeguard; the bucket's configured rule currently covers incomplete multipart uploads, not canonical run expiry.

The storage report is available at authenticated `GET /v1/storage-usage` after migration 0011. It reports current artifact count/bytes, average bytes per run, categories, execution engines, seven-day upload growth, rejection counts, cleanup queue size, reconciliation counters, expiring D1 records, referenced object counts/estimated bytes, already queued object deletions, and records needing checksum, missing-object, or expiry reconciliation. The expired-object count is based on D1 references, not a live R2 inventory. It is a read-only impact report; it does not enumerate/delete the bucket or run an expiry sweep.

## Artifact delivery and object contract

The canonical object keys remain server-generated as `runs/{runId}/{artifactId}` and `publication-manifests/{runId}/{artifactId}`. Objects are private and fetched through authenticated Soyuz routes. Upload authorization continues to require worker identity, canonical run ownership, a live claim callback fence, and an active run. Existing artifact IDs remain idempotent only for identical bytes and metadata; conflicting content fails closed. SHA-256 is computed over the stored bytes. R2 custom metadata records the checksum and provenance; D1 stores the authoritative metadata and checksum. A digest verifies content integrity and does not grant authorization.

The executor-neutral taxonomy includes execution metadata/summary/failure, code diff and changed-file list, validation results, evaluation scorecard/result, decision evidence, telemetry, and the existing Kirisame publication manifest. Optional outputs remain optional; a failed run need not produce a diff or publication manifest. Kaseki's six existing names remain supported: `result-summary.md`, `failure.json`, `git.diff`, `changed-files.txt`, `run-scorecard.json`, and `run-evaluation.json`.

Current general limits are 25,000,000 bytes per artifact, 100 artifacts and 100,000,000 aggregate bytes per run, and 12,000 bytes per persisted event payload. SQL triggers enforce aggregate run bytes against concurrent reservations. Kirisame's stricter immutable publication-manifest limits and RFC 8785 digest semantics are unchanged. Arbitrary workspace archives, unrestricted environment dumps, prompts in diagnostic logs, secrets, raw provider responses, and hidden model reasoning are not valid artifacts.

Uploads emit structured attempted/stored/rejected diagnostics with safe status and stable code, bounded retry information, byte count, and producer engine. Raw error bodies and file contents are not logged. Execution outcome remains separate from artifact delivery status (`not_reported`, `complete`, `partial`, or `failed`).

## Contract versions

Portable JSON Schemas and valid/invalid examples live under `contracts/persistence/v1/`:

| Record | Responsibility |
| --- | --- |
| `retention-policy` | Policy version and 90-day invariant |
| `run-record` | Canonical run, lifecycle, outcome, and expiry projection |
| `run-event` | Bounded typed event projection |
| `execution-outcome` | Text-free outcome summary |
| `artifact-record` | Artifact provenance, integrity, object status, and expiry |
| `artifact-manifest` | Run-level expected/persisted/missing artifact completeness |
| `artifact-envelope` | Typed transfer envelope |
| `decision-record` | Mapping to Senku's decision/profile contract |
| `publication-record` | Mapping to Kirisame publication protocol v1 |

The run manifest is separate from, and does not redefine, Kirisame's immutable publication manifest. The decision mapping references Senku profile and decision versions rather than copying Senku's schemas. Production consumers use pinned v1 schemas; they do not fetch mutable schemas from `main` at runtime.

Version boundaries are independent: public API contract version, persistence-record schema version, artifact content schema version, SQL migration number, retention policy version, engine identity/version, Senku profile/version, and Kirisame publication protocol version. A physical column change increments a migration; an accepted record shape/meaning change needs a new persistence schema; a byte-format change needs a new artifact schema; a retention rule change needs a policy version and cannot extend records already expiring under v1. New required fields or changed meanings require a new contract version. Existing v1 records stay readable only until their stored expiry.

## D1 migration and deployment

Migration `0011_unified_persistence_retention.sql` adds policy/schema versions and expiry timestamps across runs, events, generic artifacts, idempotency, publication manifests/intents/records/events, and bounded reconciliation/upload metrics. It backfills run deadlines from canonical `created_at`, derives child deadlines from their owner, clamps publication pins, adds expiry/usage indexes, adds artifact type/checksum/engine/object-status fields, and creates storage budgets and cleanup cursors. It does not reset D1 or delete existing rows. Records lacking a checksum remain queryable while their stored metadata is reconciled; they are identified by the dry-run report.

Before any remote migration, query authenticated `GET /v1/storage-usage` after deploying a compatible reader or use a reviewed D1-only impact query against the target database. Save counts for expired runs/events/artifacts/publication rows, estimated referenced bytes, invalid expiry relationships, missing checksum metadata, and deletion queue size. Review publication records and all invalid/legacy rows. The migration itself changes schema and backfills deadlines; it does not activate a data purge. Apply it only through the separately approved `npm run db:migrate:remote` procedure, verify migration history read-only, then deploy the Worker source that requires 0011. Production was not changed by this phase.

Rollback deploys the previous Worker while retaining migration 0011 and its data. Do not roll back by recreating D1, dropping columns, restoring an expired object, or widening an expiry. The migration is additive/backward compatible for the immediately previous source; old source can ignore the extra columns. A release that deletes expired rows is not undone by code rollback.

## Baseline and diagnostics (25 November 2026)

Read-only discovery observed 30 runs, 622 events, 6 completed/24 failed, 27 `artifacts.uploaded` events, 93 reported failed uploads, zero indexed generic artifacts, zero R2 objects, zero publication manifests, zero Soyuz publication records, and approximately 610 KB of D1 storage. The current R2 bucket is private. D1 is on migration 0010; migration 0011 is local only. Workers aggregate telemetry showed 120 PUT requests to `/artifacts/`, each returning HTTP 503; all were report artifacts and none were 4xx. This indicates failure after authorization/validation but does not distinguish an R2 write failure from a D1 reservation/metadata failure. The Kaseki health request returned 502 through the available proxy/tunnel, so trusted host logs and a successful execution trace were unavailable. The specific root cause is therefore unconfirmed. Do not infer a fix from the empty bucket alone. The new diagnostic codes, safe metrics and isolated regression tests provide the next evidence needed.

Cloudflare read-only inspection did not confirm backup/Time Travel expiry, D1 point-in-time recovery retention, Queue source/DLQ retention, full Workers Logs/Traces retention, AI Gateway logging retention, or inference-provider retention controls. Those settings remain provider/account-level verification items. Logical deletion in Soyuz does not promise immediate physical removal from provider-managed backups or logs.

## Service compliance and handoff

| Service | Durable run data | 90-day behavior / status |
| --- | --- | --- |
| Soyuz | Authoritative D1 records and private R2 artifacts | Source enforces a canonical 90-day deadline, access guards, bounded deletion outbox and reconciliation; migration 0011 is not deployed. |
| Kaseki Agent | Local job index, callback outbox, result files and host logs | Source prunes terminal local history and callback state at 90 days, protects pending terminal callback artifacts only before the same deadline, and starts an automatic six-hour sweep; host rollout is not confirmed. |
| Rusty Fossil | SQLite recovery descriptors, callback payloads and Docker identity fences | Source expires queue work and removes prompt-bearing descriptors/callback content at 90 days; it preserves a minimal manual-review execution fence when Docker cleanup is unresolved. That fence contains no execution prompt but can remain beyond 90 days if cleanup never resolves; bounded operator cleanup is not yet enforced in code, so this is a retention limitation. Cargo tests and formatting checks passed; five Docker-backed integration tests remain ignored. |
| Senku | No durable D1/KV/R2 decision history; process-local UTCP cache | Stateless source returns structured decision responses; durable evidence belongs in Soyuz. Provider/Cloudflare log retention remains unverified. |
| Kirisame | No local publication journal or storage binding | Soyuz owns publication lifecycle and artifact retention. Kirisame's short-lived live-canary workflow has a one-day platform retention setting; no general run history is persisted there. Provider logs remain unverified. |

Rusty Fossil must remain execution-ephemeral. A future artifact handoff must use a pinned Soyuz v1 envelope, stable artifact ID, canonical run/worker/claim fence, bounded byte count, checksum, producer/engine identity, and idempotent retry; it must upload through Soyuz and retain only the minimum local spool needed to complete delivery before the canonical deadline. Do not implement its full artifact producer or coding execution in this phase.

## Decisions

1. Soyuz coordinates persistence because it owns canonical run identity and callbacks.
2. D1 stores indexed metadata and bounded control-plane state; large bytes remain in R2.
3. R2 remains private and serves execution evidence without adding another service or storage provider.
4. Ninety days bounds operational exposure and storage growth consistently across engines.
5. Canonical run creation prevents activity from silently extending the lifetime of prompts and evidence.
6. Independent schema versions let API, database, artifact, policy, engine, decision, and publication contracts evolve safely.
7. Rusty Fossil keeps only short-lived recovery, delivery, and execution-fencing state.
8. A new artifact microservice is not justified while Soyuz can coordinate D1 and R2 directly.

## Validation evidence

Soyuz TypeScript checking and the production bundle build passed. The full Vitest run reported 338 passing tests and 12 failures. The same 12 A2UI template-validation failures reproduce on untouched `origin/main` (baseline: 328 passed, 12 failed); the added Soyuz tests pass, including the regression that aggregates outcomes across 31 retained runs. Focused API and persistence-contract suites passed 60 tests; the one failure in that focused selection is the same baseline A2UI failure in `outcome-overview.test.ts`. Fallow's maintainability audit passed with no introduced dead exports, complexity regressions, or duplicate code.

Kaseki Agent's six focused suites passed 200 tests; its build, type check, Markdown link check, and `git diff --check` passed. Rusty Fossil's regular Cargo tests passed (fossil-core 17, fossil-storage 33, rusty-fossil 13, service 8); `cargo fmt --all -- --check` and `git diff --check` passed. Five Docker-backed integration tests are ignored in this environment. The Senku and Kirisame changes are documentation-only, and `git diff --check` passed. These results validate source and isolated test behavior; they do not establish successful production artifact delivery or a live cleanup run.

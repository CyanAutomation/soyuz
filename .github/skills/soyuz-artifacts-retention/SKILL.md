---
name: soyuz-artifacts-retention
description: Use when changing worker artifact uploads, R2 storage, artifact metadata or downloads, cleanup queues, or run and artifact retention.
---

# Change artifact storage and retention safely

Read artifact and retention sections in `docs/CONTRACT.md`, `docs/ARCHITECTURE.md`, and `docs/DEPLOYMENT.md`. For schema changes, also follow `soyuz-d1-schema`; for worker claim or callback changes, follow `soyuz-worker-lifecycle`.

## Locate the lifecycle

- Worker upload and claim authorization: `src/api/worker-artifacts.ts`.
- Client/OAuth artifact listing and download: `src/api/artifacts.ts`.
- Metadata allowlist and limits: `src/api/artifact-model.ts`.
- Run culling, expiry, and deletion outbox processing: `src/api/retention.ts` and `src/db/runs.ts`.
- R2 binding and cron schedules: `wrangler.jsonc`.
- Artifact schema and durable deletion queue: `migrations/0003_run_artifacts.sql` and `migrations/0006_run_retention_outboxes.sql`.

## Preserve storage and access guarantees

- Keep the R2 bucket private. Route every read through authenticated Soyuz APIs; downloads are streamed as attachments and must not expose public object URLs.
- Require uploads to belong to the active run and current worker claim fencing identity. Keep upload idempotency and conflict behavior stable, enforce declared and streamed byte limits, and clean up failed or partial writes and index reservations.
- Keep object keys server-derived from canonical run and artifact UUIDs. Treat names and content types as untrusted metadata; return only the explicit public metadata projection.
- Preserve the configured file-size and per-run artifact caps, 30-day expiry, and cache limits. Authorize the caller and check run retention and artifact expiry before serving cached bytes.
- Run culling and artifact expiry are separate paths. Preserve the durable deletion outbox and retries so D1 run cleanup can proceed while R2 is unavailable without losing deletion work.
- Coordinate metadata, object cleanup, health schema checks, and deployment order when changing migrations. Do not make retention edits that orphan objects or make still-retained artifacts inaccessible.

## Verify the lifecycle

Update focused cases in `tests/api.test.ts`, `tests/dashboard-api.test.ts`, and migration tests as appropriate. Artifact upload, expiry, and deletion retry coverage currently lives in `tests/api.test.ts`. Cover stale/wrong worker claims, size mismatch and overflow, duplicate IDs and metadata conflicts, inaccessible or expired artifacts, cache behavior, partial storage failure, and retried deletion work where affected. Use local R2/D1 test bindings; do not validate by uploading or deleting production objects.

Use `npm test` and `npm run typecheck` for verification when requested. Apply schema changes only to local D1 with `npm run db:migrate:local`; remote migrations require the separate procedure in the deployment guide.

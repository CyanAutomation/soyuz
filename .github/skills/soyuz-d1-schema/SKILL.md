---
name: soyuz-d1-schema
description: Use when adding or changing a D1 schema migration, persisted run data, migration checks, or retention behavior.
---

# Evolve the D1 schema

Read `docs/ARCHITECTURE.md`, the relevant sections of `docs/CONTRACT.md`, and the D1 procedure in `docs/DEPLOYMENT.md`. Inspect the current schema, numbered migrations, D1 queries, and tests before choosing a migration.

## Migration rules

- Add a new monotonically numbered file under `migrations/`, using the existing `NNNN_short_description.sql` naming style.
- Numbered migrations already on the base branch are immutable. Never edit, rename, or delete one; correct the schema with a later migration.
- Keep application code compatible with the deployment order. Update reads and writes, indexes, retention jobs, health schema checks, and any data projections that depend on the changed columns.
- Treat D1 as the canonical run store. Preserve atomic compare-and-set transitions, idempotency and retry lineage, append-only event history, and private artifact indexing where relevant.
- Account for existing data and deployed Worker versions. A migration should be safe to apply before code starts relying on the new schema; use additive or staged changes when a direct change would break a running version.
- The CI migration impact check detects edits and deletions of existing numbered files. Production preflight compares migration names and order; it does not verify SQL file contents.

## Validate without touching production

Add or update migration-history and behavior tests as appropriate. Apply the migration to local D1 with `npm run db:migrate:local`, then run the relevant tests and type checks when requested. The repository includes migration impact and history helpers in `scripts/migration-impact.ts`, `scripts/migration-history.ts`, and `scripts/verify-production-migrations.ts`.

Do not run `npm run db:migrate:remote` as part of ordinary development or CI. It changes production D1 and requires separate authorization under `docs/DEPLOYMENT.md`. CI's production preflight uses read-only D1 access and blocks a Worker deploy when database identity or migration history does not match; it does not apply migrations.

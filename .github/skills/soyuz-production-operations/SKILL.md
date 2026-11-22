---
name: soyuz-production-operations
description: Use when performing production health checks, migration preflight or execution, smoke submissions, Queue inspection, or recovery.
---

# Operate Soyuz production safely

Read the relevant procedure in `docs/DEPLOYMENT.md`. For Kaseki handoff or Queue recovery, also read `docs/KASEKI-INTEGRATION.md` and follow `soyuz-kaseki-integration`. For Senku or JEV rollout checks, follow `soyuz-senku-integration`. For workflow or deployment changes, follow `soyuz-cloudflare-release`.

## Start with read-only checks

- Use `npm run soyuz:smoke` for its default health, run-list, and Queue checks. The default path does not submit work or lease Queue messages.
- Inspect Queue messages with Cloudflare's read-only peek operation. Do not manually pull, acknowledge, delete, or cancel work to inspect it.
- `/health` establishes Worker/D1 connectivity and required schema only. It does not prove a Kaseki execution or exercise the Senku binding/provider path.
- Use the documented read-only database and run views to establish current state before proposing recovery. Do not infer that a stale heartbeat means the execution stopped.

## Gate production changes explicitly

- `SOYUZ_SMOKE_ACK_EXECUTION=yes npm run soyuz:smoke -- --run` submits executable work that an enabled Kaseki host may consume. Set the acknowledgment only after explicit authorization for that specific run and its resource cost; use a disposable repository, `publishMode: none`, a bounded task, and the documented timeout. Never use Soyuz or Kaseki source repositories as the target.
- A smoke timeout does not mean the run stopped. Preserve the run ID and inspect canonical state; do not cancel it automatically. Reuse its idempotency key when checking an uncertain submission.
- `npm run db:migrate:remote` changes production D1 and requires separate authorization and D1 Edit access. Verify the configured database identity first, run the documented procedure manually, and verify migration history with read-only credentials before deployment. Never add production migration execution to CI.
- Treat `npm run deploy` as a real production deployment. Do not deploy, change secrets, replay a DLQ message, or alter production state unless the task explicitly authorizes that action.
- Keep credentials in the approved secret manager. Do not put production tokens in shell history, arguments, source files, or logs.

## Report evidence and limits

Record which checks were read-only and which were authorized state-changing operations. Distinguish Worker/D1 health from Queue handoff, Kaseki execution, and Senku provider verification. If a check is incomplete or state is uncertain, report the run ID and observed state; do not claim end-to-end success from `/health` alone.

Use the local smoke, migration-preflight, and protocol-simulator tests when requested. Tests must not connect to production or submit executable work.

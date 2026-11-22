---
name: soyuz-kaseki-integration
description: Use when changing the Soyuz and Kaseki handoff, Queue consumer protocol, host provenance, callback behavior, recovery, or rollout compatibility.
---

# Change the Soyuz and Kaseki integration

Read `docs/KASEKI-INTEGRATION.md`, the related sections of `docs/CONTRACT.md` and `docs/DEPLOYMENT.md`, and the Kaseki host guide linked from the integration document. Follow `soyuz-worker-lifecycle` for run-state and fencing changes, `soyuz-api-contract` for wire-shape changes, and `soyuz-d1-schema` for persistence changes.

## Locate the Soyuz side

- Queue message and callback schemas: `src/contracts/queue-message.ts` and `src/contracts/worker-callbacks.ts`.
- Worker reads, callbacks, and artifact upload authorization: `src/api/workers.ts` and `src/api/worker-artifacts.ts`.
- Queue reconciliation and recovery: `src/queue/reconcile.ts`.
- Canonical admission and origin policy: `src/application/runs.ts` and `src/auth/bearer.ts`.
- Local host protocol simulator: `tests/support/kaseki-protocol-simulator.ts`; its scenarios are in `tests/kaseki-protocol.test.ts`.

## Preserve the handoff guarantees

- Soyuz is the control plane and canonical run history. Kaseki owns execution-context admission, repository access, Docker, validation, and publication. Do not duplicate those controls in Soyuz or make the Kaseki adapter the default path.
- Keep `contractVersion: "1"` compatible. Queue lease IDs are for ack/retry only; canonical run UUIDs deduplicate host jobs. Persist and reuse the same idempotency key after an uncertain submission.
- Assign origin from the authenticated credential. `KASEKI_SUBMISSION_API_TOKEN` must remain distinct from client and worker credentials and limited to create, retry, and cancel operations.
- Kaseki must durably record claim intent and local mapping. It may execute only after the current `/started` callback is accepted and start authorization is durable. Acknowledge a Queue lease only after local durable acceptance and start authorization; redelivery must reuse the same job and callback IDs.
- Keep callback IDs stable across retries and use the current claim fencing identity. A stale claim cannot write after replacement. A stale heartbeat alone must not trigger automatic takeover or requeue of a running job.
- Preserve cancellation as intent until Kaseki confirms cleanup. Keep finite Queue retries and a DLQ; do not replay poison messages before correcting the contract or configuration cause.
- Keep prompts and raw logs out of callbacks. Artifact uploads remain private, authenticated, bounded, and attached to the active claim.

## Verify the protocol and rollout

Use `npm run test:kaseki` for the local protocol simulator. It checks Soyuz contract behavior with simulated durable host state; it does not execute Kaseki's real adapter, scheduler, safety admission, Docker, or publisher. Do not describe it as an end-to-end Kaseki test.

Before enabling a production consumer, verify the migration and credential prerequisites and use the compatibility/rollout order in `docs/KASEKI-INTEGRATION.md`. A live smoke submission creates executable work; use it only with explicit authorization and the disposable-target procedure in `docs/DEPLOYMENT.md`. Do not manually pull or acknowledge a message to inspect it.

When requested, update the focused protocol and contract tests, then use `npm run test:kaseki`, `npm test`, and `npm run typecheck` as relevant. Do not validate with a live Queue or production run as part of ordinary development.

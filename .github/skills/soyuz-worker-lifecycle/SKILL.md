---
name: soyuz-worker-lifecycle
description: Use when changing run state transitions, queue reconciliation, worker claims, callbacks, cancellation races, or stale-run recovery.
---

# Change the worker lifecycle safely

Soyuz and Kaseki communicate through an at-least-once Queue and authenticated callbacks. Read the lifecycle and admission sections in `docs/ARCHITECTURE.md`, the worker callback sections in `docs/CONTRACT.md`, and the relevant Kaseki guidance in `docs/KASEKI-INTEGRATION.md` before changing lifecycle behavior.

## Trace the full transition

- Allowed states and transitions: `src/domain/run-state-machine.ts`.
- Callback schemas: `src/contracts/worker-callbacks.ts`.
- Worker endpoints and authentication handoff: `src/api/workers.ts` and `src/index.ts`.
- Compare-and-set persistence, events, and claims: `src/db/runs.ts`.
- Admission and client cancellation: `src/application/runs.ts`.
- Admission, claim, and stalled-run recovery: `src/queue/reconcile.ts`.
- Queue message shape: `src/contracts/queue-message.ts`.

Trace a change from request or Queue delivery through validation, D1 mutation, event recording, and callback response. Preserve the boundary where Soyuz stores canonical intent and Kaseki controls execution.

## Invariants to retain

- Keep transition rules in the domain state machine and enforce writes with a D1 compare-and-set. Terminal states never return to active states.
- Queue delivery is at least once. Deduplicate by canonical run ID and make duplicate callbacks replay-safe; an identical callback ID and payload may replay, while conflicting reuse must fail.
- Claims are leases. Started, event/heartbeat, and terminal callbacks must carry the current claim fencing identity. A stale claim must not write after another claim replaces it.
- Kaseki may execute only after Soyuz accepts the `started` callback. A queued or claimed message is not authorization to start Docker by itself.
- Keep event insertion atomic with the associated transition where the existing flow does so. Competing terminal outcomes must not both become canonical.
- Recovery may retry an uncertain admission or replace an expired pre-start claim using the same run ID. Never automatically requeue a `running` run because its heartbeat is stale; mark it suspect for operator review.
- A running cancellation is intent (`cancel_requested`) until the host confirms cancellation. A cancellation race must not overwrite a successful completion or failure.
- Heartbeat health is separate from lifecycle status. Restoring a heartbeat does not create a new run or lifecycle transition.

## Test the race, not just the happy path

Update the state-machine and API tests for valid and invalid transitions, duplicate callbacks, conflicting callback IDs, obsolete claim tokens, concurrent claims, cancellation versus start/completion, and recovery boundaries affected by the change. Preserve requirement IDs in `docs/TEST-REQUIREMENTS.md` when coverage represents a client-visible guarantee.

Use `npm test` and `npm run typecheck` for verification when requested. Do not use a live Queue or production run to test lifecycle changes; the local Worker test harness is the normal verification path.

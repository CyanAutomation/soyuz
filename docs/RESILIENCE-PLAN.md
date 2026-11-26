# Service resilience plan

This plan covers the failure paths between Soyuz and its upstream providers and agents. Faults are injected only in local tests; there is no production fault switch and the suites do not call OpenRouter or GitHub.

## Design rules

- Use deterministic, scripted fault scenarios at HTTP boundaries: status responses, malformed or oversized bodies, interrupted body reads, transport rejection, delay, and response loss after a remote mutation.
- Reuse test-only fault primitives around the real clients and stateful fakes. Keep application state changes in the fake handler so a response can be lost after the simulated commit.
- Assert one request where a client must not retry, and assert stable callback/publication identities where a caller may retry or reconcile.
- Check safe public error codes, bounded response handling, credential and body redaction, and state invariants in the same scenarios.
- Keep retries in the owning durable workflow. HTTP clients expose retryability and deadlines; they do not add hidden retries.

## Work and acceptance criteria

| Area | Work | Acceptance |
| --- | --- | --- |
| Soyuz → Senku → OpenRouter | Run the real local Soyuz and Senku Workers through the Service Binding while replacing OpenRouter with scripted 503, malformed JSON, and abort-on-timeout outcomes. Preserve the success scenario. | One provider attempt per request; dashboard maps errors to stable codes; request/run state is unchanged; prompt, provider body, and credentials do not appear in responses or logs. |
| Senku provider client | Use a reusable scripted `fetch` primitive for status, network rejection, timeout, content type, malformed and oversized bodies. | Existing provider classifications remain explicit, bodies stay bounded and private, and the adapter makes one attempt. |
| Kaseki Agent ↔ Soyuz | Apply reusable before/after-handler HTTP faults to the stateful Soyuz fake; cover delayed and interrupted response reads. | A committed claim with a lost response is reconciled by its stable claim ID; uncertain queue acknowledgements do not create duplicate jobs; body read errors are safe and bounded. |
| Rusty-Fossil ↔ Senku/Soyuz | Share a scripted local HTTP scenario helper across both Rust client integration suites. | 429/503, timeout, malformed JSON, and oversized bodies map to typed errors; retryability and one-attempt behavior are asserted; unsafe upstream text is not returned. |
| Kirisame ↔ GitHub | Wrap the stateful GitHub fake with scripted before/after-mutation faults. Verify Retry-After and reconciliation after uncertain ref and pull-request writes. | Pre-mutation rate limits preserve retry delay; post-mutation response loss does not duplicate a branch or pull request; malformed and oversized GitHub responses remain bounded and safely classified. |

## Rollout gates

1. Run focused test suites in each repository on its declared Node or Rust toolchain, then run the repository-wide checks.
2. Keep the Soyuz → Senku cross-Worker test opt-in through `SENKU_WRANGLER_CONFIG`; it must block outbound HTTP outside the local OpenRouter stub.
3. Before enabling any production retry behavior, confirm the owning durable queue/outbox preserves callback IDs, idempotency keys, deadlines, and retry-after schedules across process restarts.
4. Treat Rusty-Fossil production service wiring as a separate release gate: its compatibility and client suites do not prove that production worker coordination currently invokes those clients.
5. After deployment, compare bounded success/failure counts and latency by dependency, then verify that alerts and operator guidance distinguish timeout, rate limit, malformed response, and uncertain mutation outcomes.

## Focused local checks

Run the JavaScript suites on Node 26 or the repository's declared runtime. The Soyuz cross-Worker test needs the local Senku checkout path:

```sh
SENKU_WRANGLER_CONFIG=/absolute/path/to/senku/wrangler.jsonc npm run test:cross-worker
npx vitest run test/provider.test.ts
npx jest --runInBand src/integrations/soyuz/SoyuzAdapter.test.ts src/integrations/soyuz/SoyuzApiClient.test.ts src/integrations/soyuz/scripted-fetch.test.ts
npx vitest run tests/worker/github-http-e2e.test.ts
```

Run the Rust client fault suites from the Rusty-Fossil workspace:

```sh
cargo test -p fossil-senku --test contracts upstream_faults_are_bounded_classified_and_never_retried
cargo test -p fossil-soyuz --test client soyuz_http_faults_are_classified_without_retries_or_remote_body_leaks
```

## Current status

The local fault harnesses and contract checks in this branch address the first four rows and the GitHub mutation/rate-limit scenarios in the fifth row. The deployment and production-wiring gates remain operational work because the test harness cannot establish service configuration, live telemetry, or Rusty-Fossil production wiring.

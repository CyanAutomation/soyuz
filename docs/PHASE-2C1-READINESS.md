# Phase 2C.1 readiness and Phase 2C.2 canary runbook

**Reviewed:** 28 November 2026 (UTC)
**Readiness:** **NOT READY**
**Scope:** read-only production verification and local Soyuz reliability/provenance changes. No production run, GitHub publication, deployment, secret change, migration, or backfill was performed. The Kaseki host is unavailable in this environment; its source and runtime commissioning are deferred to the follow-up session requested by the operator.

This is the authoritative deployment and rollout snapshot for the Kirisame integration. Historical commissioning records remain historical evidence; they are not rewritten as current verification.

## Current evidence

| Area | Verified state | Evidence and limit |
| --- | --- | --- |
| Soyuz source | `origin/main` is `ba1ccda65761926ee69eb45a06c51541d5e8153f`; main CI/deploy run [#327](https://github.com/CyanAutomation/soyuz/actions/runs/46033209185) and its CodeQL/Scorecard checks succeeded. The source includes the private Kirisame binding, exact Somatic PR-to-`main` policy, operator preflight, exhausted-attempt recovery, terminal callback compatibility, migration 0012 projection, and manifest diagnostics. | Active production Worker version #66 (`3e2f4e3f-a214-450d-a003-2dcd2122bb8b`, deployment `8387b029-ab8c-4435-8d6e-3a00de935bdd`, 100% traffic, created 28 November 12:08 UTC) is annotated `dash` and has no source SHA. Its deployed revision is unverified. This work adds future deployment provenance locally; it has not been deployed. |
| Soyuz production settings | `KIRISAME` targets `kirisame.PublisherEntrypoint`; `KIRISAME_CALLER_ID=soyuz`; the `KIRISAME_API_KEY` secret binding exists; dispatch is `true`; the allowlist is exactly `CyanAutomation/somatic`, mode `pr`, base `main`. The separate `SOYUZ_OPERATOR_API_TOKEN` binding exists. | Cloudflare bindings were read on 28 November; secret values were not read. Production settings and policy were not changed. |
| Operator authentication | `POST /v1/operator/kirisame/preflight` returned HTTP 401 `UNAUTHORIZED` with no credential (request `11cbfd88-a3aa-4a40-899e-aa561ec49382`) and with a synthetic invalid bearer (request `a61d6139-df02-4fba-ae35-79a66399f408`) at 12:52 UTC. | Negative checks only; neither invoked Kirisame. The authenticated preflight was not run because the existing token value is not available to this cloud environment. Obtain it only through the approved operator secret manager in the separate authorized environment. |
| Public publishing boundary | Unauthenticated `POST /v1/publications` returned HTTP 401 `UNAUTHORIZED` at 12:52 UTC (request `e59e98f7-db2b-4fac-b532-7f6f2f4cabaa`). The route is protected by client authentication. Kirisame's public Worker source exposes only public read routes; publishing remains on the private service binding. | No publisher RPC or GitHub mutation was invoked. A direct network request to Kirisame's workers.dev host was blocked by this environment's outbound proxy, so public/private isolation evidence is source plus Soyuz boundary behavior, not a direct runtime probe of Kirisame. |
| Kirisame production | Active Worker version #19 (`2970f2fc-6ccb-4183-8117-8c8a477232a7`, deployment `a63daef3-7bd9-4401-912a-293df60b1f17`, 100% traffic) reports source `4ff14b817eb3633251e8618739c19fa9335e99a5`, app `0.1.0`, contract `1`; `PUBLISHING_ENABLED=true`, App ID `3345400`, and private-key/caller-key secret bindings exist. | The source SHA matches the Worker source binding. Current Kirisame `main` is `025c369427e911961971cd266666723946e73d3c`, five commits ahead with docs-only runtime additions; no redeploy is indicated. Secret values were not read. |
| Production D1 | Migrations `0001` through `0012_run_outcome_projection.sql` are applied; 0012 was applied 26 November at 18:20 UTC. Current aggregate: 33 retained runs (2 claimed, 7 completed, 24 failed), 0 publication rows, 0 intents, and 0 publication events. | Read-only Cloudflare D1 queries at 28 November 12:52 UTC; no rows written. Two claims were still live, with leases through 12:55:11.557Z and 12:55:18.733Z. D1 run state alone does not prove host/Queue ownership. |
| Outcome projection/backfill | `outcome_summary_json` is present for 23 of 31 retained terminal runs; eight are missing. The bounded script only reads unexpired rows with a non-null `result_json`, then only writes a valid `result.outcomeSummary`. Current assessment found zero valid recoverable candidates; four rows have no outcome summary in the source payload and four have no recoverable source. | No malformed source/projection was found in the current read-only review. No backfill was run. Historical information that is no longer present is documented as unrecoverable, not fabricated; the eligibility gate is satisfied to the extent retained source data permits. |
| Queue | `soyuz-runs` has one HTTP pull consumer, 24-hour retention, batch size 10, three retries, 30-second visibility, and DLQ `soyuz-runs-dlq`. Read-only best-effort Cloudflare metrics reported backlog count/bytes 0 at 12:52 UTC. | Queue metrics can be approximate. They do not identify an active host owner or callback backlog. Two live D1 claims remain; the host must be checked before canary admission. No Queue message was pulled or leased. |
| Kaseki host | No current host/container/image/checkout/producer/outbox state was inspected in this session. | `kaseki-agent` and Termius access are unavailable in this cloud environment. Per operator direction, Kaseki changes and runtime verification are deferred to a follow-up session in a different environment. Do not treat the 26 November host snapshot as current or use it to assert provenance. |
| Credential isolation and producer | No current runtime credential-isolation probe, trusted manifest producer test, legacy-publisher suppression test, or child network-boundary check was run. | These checks require the actual Kaseki host and are mandatory follow-up gates. Keep `SOYUZ_KIRISAME_PRODUCER_ENABLED` disabled outside the controlled canary window. |
| Callback compatibility | Current Soyuz main accepts optional `taskAdmission` outcome data. Current Kaseki main is `e330b199858e1f8584e4d241ca6f6c9269e94a45` and its main CI/image workflows succeeded. | Source-level compatibility only. The Kaseki running image/source and its outbox cannot be inspected here; deployed callback compatibility remains unverified. |
| Artifact and retention | Soyuz source and migration 0011/0012 retain records, artifacts, publication manifests, intents, and events to the canonical 90-day run deadline. | Schema and source evidence; production data was read only. Soyuz's active deployed source remains unproven. |

Phase 2C.2 remains blocked by the two live claims, unauthenticated preflight status, unverified active Soyuz source, and unavailable Kaseki host/image, credential-isolation, producer, and callback-outbox evidence. No known D1 migration or eligible backfill work remains. Do not start the canary until each required gate below is evidenced in the appropriate environment.

## Implementation and security notes

- Soyuz enforces its single exact repository policy again immediately before every private RPC. A missing, malformed, empty, or revoked policy blocks dispatch. Revocation prevents future writes; it cannot undo a GitHub mutation already accepted by Kirisame.
- At most eight automatic mutation attempts are reserved. An expired eighth lease transitions atomically to `blocked` with `PUBLICATION_OUTCOME_UNKNOWN`, preserves any known branch/PR fields, appends one operator-review event, and is excluded from later scheduler batches. Do not assume the PR is absent. Inspect GitHub read-only before any separately authorized recovery.
- Missing caller identity/key is a permanent `KIRISAME_CALLER_CONFIGURATION_INVALID` block, not a retry loop. The publication event gives a sanitized operator action. Neither credential is stored in the immutable request or publication rows.
- Soyuz exposes `POST /v1/operator/kirisame/preflight`, guarded by the separate `SOYUZ_OPERATOR_API_TOKEN`. It calls the existing fixed-scope `verifyCanaryAuthorization` RPC with Soyuz's own `KIRISAME_CALLER_ID` and `KIRISAME_API_KEY`; it cannot publish and returns no token. The operator token must not equal client, worker, or Kaseki submission credentials. Its production secret binding is present; use the existing value through the approved operator secret manager only.
- Kirisame authenticates the caller but does not constrain the caller's repository choice. The App installation includes all CyanAutomation repositories; that is not a repository-level authorization boundary. A compromised authorized caller could request a repository outside its intended policy. Soyuz's exact dispatch policy, Kirisame caller authentication, and Kirisame's repository-scoped installation tokens are the current controls. Per-caller capability restrictions are useful defense in depth and should be considered in a separate ADR; no second receiver allowlist is added here.
- Kaseki's source persists `publicationRoute` before execution and suppresses its direct publisher for a Kirisame-routed run. It removes privileged credentials from the coding child. The trusted host must remain the only producer; do not enable automatic legacy fallback.

## Required rollout before the canary

1. Production D1 identity and migration history were read-only verified against the configured database. Migration 0012 is applied; do not reapply it or alter migration history.
2. The bounded backfill script reads only unexpired rows with `result_json` and writes only a schema-valid `result.outcomeSummary`. The current read-only assessment found no valid candidates. Do not fabricate the eight missing projections or perform a production backfill for them.
3. Merge and validate the local Soyuz source-provenance change before relying on a future Worker deployment annotation. The current active version #66 remains source-unverified until an approved deployment records and exposes the new metadata. Any production deployment requires the established rollout authorization; none was performed here.
4. The live Worker binding, caller ID, dispatch gate, Somatic policy, and Kirisame secret-binding presence were verified. `SOYUZ_OPERATOR_API_TOKEN` is already configured; do not replace, rotate, or retrieve its plaintext from Cloudflare. Secret values remain unread.
5. Run the actual preflight from the approved operator environment after obtaining the existing token through its approved secret manager. Expected result is `{ "status": "verified", "repository": "CyanAutomation/somatic" }`. A 401/503 or any rejected stage is a stop condition; do not substitute the separate live-invoker credentials. The controlled unauthenticated and synthetic-invalid requests already returned 401 and did not invoke Kirisame.

   ```sh
   curl --fail-with-body --silent --show-error \
     --request POST "$SOYUZ_BASE_URL/v1/operator/kirisame/preflight" \
     --header "Authorization: Bearer ${SOYUZ_OPERATOR_API_TOKEN:?load from the approved secret manager}" \
     --header "Content-Type: application/json" \
     --data '{}'
   ```

6. Wait for the two live D1 claims to settle. The queue metrics were zero at the last check, but are best-effort and do not prove host ownership or callback-outbox health. In the separate Kaseki environment, verify no active run, claimed Queue message, callback backlog, or in-flight legacy publication; record image digest/source, package version, adapter health, rollback reference, and the actual producer setting.
7. Keep `SOYUZ_KIRISAME_PRODUCER_ENABLED` disabled outside the controlled canary window. Only after every gate is evidenced and the canary is separately authorized, set it through the host's established deployment/configuration process, verify the route and health, and revert it after the canary. Record the exact host-specific command during the Kaseki follow-up; this environment has no host access and must not guess the deployment mechanism.
8. Confirm the exact Somatic/main/PR policy, rerun focused Soyuz and Kaseki tests in their respective environments, and capture deployment and rollback references. Do not start that canary during Phase 2C.1.1.

Do not broaden the policy, remove the legacy implementation, change the GitHub App installation, or run a second preflight using the separate live-invoker credentials as a substitute for Soyuz's own credentials.

## Phase 2C.2 canary procedure

**Target:** `CyanAutomation/somatic`, base `main`, mode `pr`. This procedure is prepared only; do not execute it during Phase 2C.1. The existing isolated PR #128 is not the target and must remain untouched.

1. **Stop/go checks.** Complete every rollout item above. Confirm no active Soyuz run, no Queue message already claimed for this host, no in-flight Kaseki legacy publication, current exact Somatic/main/PR policy, verified private preflight, and healthy callback outbox. Use an approved operator credential stored outside the coding environment.
2. **Submission.** Submit one canonical Soyuz run with a fresh UUID idempotency key. Reuse that same key and identical body if the submission response is uncertain. The intended request is:

   ```json
   {
     "repoUrl": "https://github.com/CyanAutomation/somatic",
     "ref": "main",
     "taskMode": "patch",
     "publishMode": "pr",
     "changedFilesAllowlist": ["canary/phase-2c2/README.txt"],
     "maxDiffBytes": 12000,
     "taskPrompt": "Add one UTF-8 text file at canary/phase-2c2/README.txt containing: Software Factory canary. This file verifies the trusted publication path. Do not change any other path, application code, dependencies, workflows, or infrastructure. Run the configured validation checks. Do not commit or publish directly."
   }
   ```

3. **Host selection and route.** Verify Soyuz's canonical run ID and selected trusted worker. On the host, verify the persisted route is `kirisame`, the pinned base SHA is present, the host workspace is retained, and the run's effective `KASEKI_PUBLISH_MODE` is `none`. If the host rejects admission or selects the legacy route, stop; do not resubmit locally.
4. **Validation and manifest.** Require the configured host validation gates to pass. Verify the trusted host—not the coding agent—constructs the canonical v1 manifest from the pinned Git tree, emits claim-fenced `validation.completed` evidence, uploads the same immutable manifest under the active claim, and registers the intent before the terminal completion callback. Expected R2 key: `publication-manifests/<runId>/<artifactId>`, with a ready D1 index row, matching digest and expiry at the owning run's deadline.
5. **Soyuz lifecycle and dispatch.** Confirm execution completes before the intent becomes a publication row. Expected lifecycle: `pending` → `publishing` → `published`; the same publication ID, request fingerprint, and attempt owner must appear in the event history. Verify current policy again and observe the private binding call. Never manually create a second publication identity.
6. **GitHub result.** Verify exactly one new PR, distinct from PR #128, authored by the GitHub App bot identity for App ID `3345400` (record the exact login returned in the PR metadata; it must not be a human or Kaseki host account), with deterministic head `kirisame/p/<publicationId>`, target `main`, and exactly the allowed text file. Verify its branch SHA and PR number/URL match the Soyuz projection.
7. **Replay.** Verify a duplicate submission with the same idempotency key returns the same canonical run. Verify repeated terminal callback delivery retains the original artifact ID, validation event ID, and publication ID. If a transport retry occurred, verify it used the same immutable fingerprint and reconciled to the same branch/PR; do not force an extra publish call solely to manufacture a replay.
8. **No dual publisher.** Confirm the persisted route stayed `kirisame`, the execution child had `KASEKI_PUBLISH_MODE=none` and no GitHub write secret, and no legacy direct-publisher attempt or local push occurred. Preserve this evidence with the run and PR identifiers.

### Stop, failure, and rollback

- Stop before submission if any deployment, migration, preflight, policy, host provenance, isolation, active-run, or Queue ownership check is unknown or fails.
- If the run fails validation before intent creation, retain the canonical run and inspect the host; do not retry the coding task by creating a second run without operator review.
- If publication becomes `retryable_failure`, let Soyuz's bounded scheduler retry the same immutable request. If it becomes `blocked` or `PUBLICATION_OUTCOME_UNKNOWN`, inspect GitHub branch/PR state read-only and require operator review before any recovery. Never infer absence from a timeout.
- On producer-route risk, disable `SOYUZ_KIRISAME_PRODUCER_ENABLED` and restart Kaseki to stop new routes. Do not switch an already persisted Kirisame route to legacy publishing. Keep the results volume and outbox. On a Soyuz receiver issue, disable dispatch after confirming no active publication attempt; retain the durable ledger and R2 objects until the run's 90-day expiry.
- Record the previous host image digest, host source/package references, Soyuz/Kirisame deployment versions, and migration bookmark before the window. Roll back only to a Worker compatible with the applied schema; never roll back the D1 schema or recreate it.

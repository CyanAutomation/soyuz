# Phase 2C.1 readiness and Phase 2C.2 canary runbook

**Reviewed:** 26 November 2026 (UTC)  
**Readiness:** **NOT READY**  
**Scope:** non-mutating verification only. No new production run, GitHub publication, deployment, secret change, migration, or backfill was performed.

This is the authoritative deployment and rollout snapshot for the Kirisame integration. Historical commissioning records remain historical evidence; they are not rewritten as current verification.

## Current evidence

| Area | Verified state | Evidence and limit |
| --- | --- | --- |
| Soyuz source | Latest `main` is `cc735403beaf4ea08b1c9e655b799696df972c94`; it includes PR #130 reliability/readiness work and the private Kirisame binding, dispatch gate, and exact Somatic PR-to-`main` policy. | Current production deployment is version #60 (`b9d97801-1f49-44e2-ba95-1890fcf59a89`, deployment `16948d43-d0f0-4229-bf83-e35e88644316`, created 26 November at 19:28 UTC). Cloudflare exposes no source SHA annotation or source binding for this Worker, so the deployed commit is unverified. |
| Soyuz production settings | `KIRISAME` targets `kirisame.PublisherEntrypoint` in production; `KIRISAME_CALLER_ID=soyuz`; `KIRISAME_API_KEY` binding exists; dispatch is `true`; policy is exactly `CyanAutomation/somatic`, mode `pr`, base `main`. | Settings were read from Cloudflare on 26 November. Secret values were not read. `SOYUZ_OPERATOR_API_TOKEN` is absent, preventing the operator-only authenticated preflight. |
| Kirisame production | Deployment version #19 (`2970f2fc-6ccb-4183-8117-8c8a477232a7`, deployment `a63daef3-7bd9-4401-912a-293df60b1f17`, 100% traffic) reports source `4ff14b817eb3633251e8618739c19fa9335e99a5`, app version `0.1.0`, contract `1`. `PUBLISHING_ENABLED=true`; `GITHUB_APP_ID=3345400`; GitHub private-key and caller-key secret bindings exist. | Cloudflare Worker settings and active deployment were read on 26 November. Secret values were not read. The deployment source matches its `KIRISAME_SOURCE_SHA` binding. |
| Authenticated preflight | The fixed-Somatic read-only `verifyCanaryAuthorization` RPC and Soyuz operator route exist in source. | No actual Soyuz-to-Kirisame preflight was run: the separate `SOYUZ_OPERATOR_API_TOKEN` binding is absent. Presence of the two caller secret bindings does not prove their values match, and App/token scope is therefore unverified. |
| Production Soyuz D1 | Migrations `0001` through `0012_run_outcome_projection.sql` are applied; migration 0012 was applied on 26 November at 18:20 UTC. There are 30 runs (6 completed, 22 failed, 2 currently claimed), 0 publications, 0 publication intents, and 0 publication events. | Read-only migration-history and aggregate queries on 26 November; no rows written. Two claimed runs had unexpired leases at the time of the query, so canary admission must wait for them to settle and be checked by the operator. |
| Outcome projection/backfill | `outcome_summary_json` is present for 20 of 28 terminal runs. Four retained, valid `result_json` rows have no `outcomeSummary` field; the bounded script cannot derive a projection from those rows. Four other terminal rows have no retained recoverable outcome source. | Current D1 state was read-only inspected. Whether a prior two-pass backfill was executed is unverified. No backfill was run in this review; the production backfill status must not be reported as complete. |
| Kaseki host | The healthy `kaseki-api` container uses image digest `sha256:14190fe4c6178d779bdcb4135a773c520d5bd538fd9f299758638bb79008c7a2` (image created 26 November at 19:37 UTC). Host checkout is `5acf93b048c507ebf3c762ecec340797c21ce76a`. `SOYUZ_ENABLED=true` and `SOYUZ_SUBMISSION_ENABLED=true`; `SOYUZ_KIRISAME_PRODUCER_ENABLED` is unset and therefore defaults to `false`. | Image has no OCI source-revision label, so the checkout SHA does not prove the running image source. No active coding child container was visible. The host checkout is highly diverged from `origin/main`; do not use it as deployed-image provenance. |
| Credential isolation | Kaseki source routes Kirisame work through the trusted host; the child receives `KASEKI_PUBLISH_MODE=none`, runs non-root with a read-only root filesystem, and is not mounted with the Docker socket or host secret directory. | The merged main source filters a named set of App/Soyuz/Cloudflare credentials, but its tests did not cover generic `GITHUB_TOKEN`/`GH_TOKEN`, host Git helper configuration, or executable `core.fsmonitor` in the untrusted workspace `.git/config`. This review found those gaps and added a local Kaseki hardening follow-up with regression tests; it is not yet merged or deployed. No active coding child was available for a live environment or network probe, so the host-to-child network boundary remains unverified. |
| Callback compatibility | Current Soyuz `main` accepts the optional `taskAdmission` outcome; current Kaseki `main` includes the persisted terminal outbox. | Source compatibility only. Soyuz's deployed source revision is unproven and Kaseki's running image has no source provenance, so deployed compatibility remains unverified. |
| Artifact and retention | Soyuz source binds run records, events, generic artifacts, publication manifests, intents, and publication events to the run's 90-day expiry. The claim-change-after-R2-write recovery has a regression test and reuses only digest-verified bytes. | Source and test evidence; production migration history is through 0012, but the exact Soyuz code deployed in version #60 is unverified. |

The Phase 2C.2 gates remain blocked by two active claimed runs, unverified completion of the outcome backfill, the absent Soyuz operator token and unrun authenticated preflight, unverified Soyuz deployment source, and missing Kaseki image provenance with the producer flag off. Do not start the canary until each gate below is evidenced.

## Implementation and security notes

- Soyuz enforces its single exact repository policy again immediately before every private RPC. A missing, malformed, empty, or revoked policy blocks dispatch. Revocation prevents future writes; it cannot undo a GitHub mutation already accepted by Kirisame.
- At most eight automatic mutation attempts are reserved. An expired eighth lease transitions atomically to `blocked` with `PUBLICATION_OUTCOME_UNKNOWN`, preserves any known branch/PR fields, appends one operator-review event, and is excluded from later scheduler batches. Do not assume the PR is absent. Inspect GitHub read-only before any separately authorized recovery.
- Missing caller identity/key is a permanent `KIRISAME_CALLER_CONFIGURATION_INVALID` block, not a retry loop. The publication event gives a sanitized operator action. Neither credential is stored in the immutable request or publication rows.
- Soyuz exposes `POST /v1/operator/kirisame/preflight`, guarded by the separate `SOYUZ_OPERATOR_API_TOKEN`. It calls the existing fixed-scope `verifyCanaryAuthorization` RPC with Soyuz's own `KIRISAME_CALLER_ID` and `KIRISAME_API_KEY`; it cannot publish and returns no token. The operator token must not equal client, worker, or Kaseki submission credentials. Configure it only through the approved secret manager after the compatible Worker is deployed.
- Kirisame authenticates the caller but does not constrain the caller's repository choice. The App installation includes all CyanAutomation repositories; that is not a repository-level authorization boundary. A compromised authorized caller could request a repository outside its intended policy. Soyuz's exact dispatch policy, Kirisame caller authentication, and Kirisame's repository-scoped installation tokens are the current controls. Per-caller capability restrictions are useful defense in depth and should be considered in a separate ADR; no second receiver allowlist is added here.
- Kaseki's source persists `publicationRoute` before execution and suppresses its direct publisher for a Kirisame-routed run. It removes privileged credentials from the coding child. The trusted host must remain the only producer; do not enable automatic legacy fallback.

## Required rollout before the canary

1. Review `scripts/migration-impact.ts` against the verified production account/database and confirm migration 0012 remains applied. Do not reapply it or alter migration history.
2. Run local migrations and compatibility checks for any future migration. Inspect the bounded backfill script's dry-run/read behavior and compare its candidates with production. A previous production backfill run is unverified; the four retained result rows without `outcomeSummary` are not derivable by this script. Any production backfill rerun requires the established operator authorization and must remain bounded/idempotent.
3. Verify the deployed Soyuz source revision through deployment provenance before relying on main's lifecycle, policy, artifact, and callback behavior. Deploying or changing production is outside this read-only review and requires the established rollout authorization.
4. The live Worker settings currently match the expected binding, caller ID, dispatch gate, Somatic policy, Kirisame publishing gate, App ID, and secret-binding presence. Secret values remain unread. Add `SOYUZ_OPERATOR_API_TOKEN` through the approved secret manager, then verify the exact binding and secret presence without exposing values.
5. Call the operator preflight from an approved operator environment only after that token is configured. Require `{ "status": "verified", "repository": "CyanAutomation/somatic" }`. A 401/503 or any rejected stage is a stop condition; do not substitute the separate live-invoker credentials.
6. Wait for the two currently claimed Soyuz runs to settle. Then have the operator verify no active run, Queue ownership, callback backlog, or in-flight legacy publication. Verify Kaseki image source/package provenance, adapter health, rollback reference, and the producer flag. Keep `SOYUZ_KIRISAME_PRODUCER_ENABLED` off until the approved canary window.
7. Confirm the exact Somatic/main/PR policy, rerun focused Soyuz/Kaseki tests, and capture deployment and rollback references. Enable the producer only for the approved Phase 2C.2 canary window; do not start that canary during Phase 2C.1.

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

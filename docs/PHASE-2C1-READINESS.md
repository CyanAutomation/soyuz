# Phase 2C.1 readiness and Phase 2C.2 canary runbook

**Reviewed:** 26 November 2026 (UTC)  
**Readiness:** **NOT READY**  
**Scope:** non-mutating verification only. No new production run, GitHub publication, deployment, secret change, migration, or backfill was performed.

This is the authoritative deployment and rollout snapshot for the Kirisame integration. Historical commissioning records remain historical evidence; they are not rewritten as current verification.

## Current evidence

| Area | Verified state | Evidence and limit |
| --- | --- | --- |
| Soyuz source | `15306c97e190f1c399dae9242edf4fc9c1ecc67d` on `main`; source declares the private Kirisame binding, `PUBLICATION_DISPATCH_ENABLED=true`, and the exact Somatic PR-to-`main` policy. | Source configuration only; not proof of the active Worker configuration. |
| Production Soyuz D1 | Migrations `0001` through `0011` are applied. `0012_run_outcome_projection.sql` is absent. Publications: 0. Publication intents: 0. | Read-only D1 query on 26 November; no rows written. Outcome backfill has not been run for `0012`. |
| Soyuz/Kirisame Worker settings | Deployment versions, live secret presence, and the deployed Service Binding could not be reverified. | Cloudflare Worker settings/version requests failed with API authentication error `10001`; D1 read access was available. Do not treat source configuration as deployment evidence. |
| Kirisame | Source `fc7ff3c4ecdfb7b516e25400a2353d53fb957021`; fixed Somatic read-only preflight exists in `PublisherEntrypoint.verifyCanaryAuthorization`. | Active Worker version, `PUBLISHING_ENABLED`, caller-key secret, App private-key secret, and the Soyuz caller credential match were not independently verified. The actual Soyuz-to-Kirisame preflight was not run. |
| Kaseki host | API container is healthy on package version `1.160.0`, image digest `sha256:52a49692676874f1a059696d9761f4432f8a5d3b7c92ee569c8d3dceb7f9ca96`; host source checkout is `5acf93b048c507ebf3c762ecec340797c21ce76a`. | The image has no OCI source-revision label, so the checkout SHA is not proven to be the image source. `SOYUZ_ENABLED=true`; the Kirisame producer flag is unset and defaults to `false`. No active coding container was visible. The protected metrics endpoint returned 401, so Queue activity was not verified. |
| Credential isolation | Source routes Kirisame work through the trusted host; the coding child receives `KASEKI_PUBLISH_MODE=none`, no GitHub App/Kirisame/Soyuz worker credentials or secret directories, no Docker socket, and a read-only container filesystem. | Kaseki regression tests cover the environment and launch configuration. This is source/test evidence, not a live child-container credential probe on the host. |
| Callback compatibility | Soyuz main accepts the optional `taskAdmission` outcome introduced by Kaseki; Kaseki main includes the persisted terminal outbox. | Source compatibility only. The deployed Worker and host versions were not independently verified. |
| Artifact and retention | Soyuz source binds all run-associated records and manifest objects to the run's 90-day expiry. The claim-change-after-R2-write race has a regression test and reuses only the same digest-verified bytes. | Local migration and tests pass. The production schema is at `0011`; deployment use of these changes remains unverified. |

The Phase 2C.2 gates remain blocked by the unapplied production migration `0012` and its two-pass outcome backfill, unavailable Worker deployment/secret verification, an unrun authenticated preflight, and the host producer being off. Do not start the canary until each gate below is evidenced.

## Implementation and security notes

- Soyuz enforces its single exact repository policy again immediately before every private RPC. A missing, malformed, empty, or revoked policy blocks dispatch. Revocation prevents future writes; it cannot undo a GitHub mutation already accepted by Kirisame.
- At most eight automatic mutation attempts are reserved. An expired eighth lease transitions atomically to `blocked` with `PUBLICATION_OUTCOME_UNKNOWN`, preserves any known branch/PR fields, appends one operator-review event, and is excluded from later scheduler batches. Do not assume the PR is absent. Inspect GitHub read-only before any separately authorized recovery.
- Missing caller identity/key is a permanent `KIRISAME_CALLER_CONFIGURATION_INVALID` block, not a retry loop. The publication event gives a sanitized operator action. Neither credential is stored in the immutable request or publication rows.
- Soyuz exposes `POST /v1/operator/kirisame/preflight`, guarded by the separate `SOYUZ_OPERATOR_API_TOKEN`. It calls the existing fixed-scope `verifyCanaryAuthorization` RPC with Soyuz's own `KIRISAME_CALLER_ID` and `KIRISAME_API_KEY`; it cannot publish and returns no token. The operator token must not equal client, worker, or Kaseki submission credentials. Configure it only through the approved secret manager after the compatible Worker is deployed.
- Kirisame authenticates the caller but does not constrain the caller's repository choice. The App installation includes all CyanAutomation repositories; that is not a repository-level authorization boundary. A compromised authorized caller could request a repository outside its intended policy. Soyuz's exact dispatch policy, Kirisame caller authentication, and Kirisame's repository-scoped installation tokens are the current controls. Per-caller capability restrictions are useful defense in depth and should be considered in a separate ADR; no second receiver allowlist is added here.
- Kaseki's source persists `publicationRoute` before execution and suppresses its direct publisher for a Kirisame-routed run. It removes privileged credentials from the coding child. The trusted host must remain the only producer; do not enable automatic legacy fallback.

## Required rollout before the canary

1. Review `scripts/migration-impact.ts` output against the production D1 and verify the exact Cloudflare account/database.
2. Run local migrations and migration compatibility tests; retain the applied production history without reset or recreation.
3. Obtain explicit operator authorization, apply `0012_run_outcome_projection.sql`, and run the documented bounded backfill before deployment. Deploy the compatible Soyuz Worker, repeat the backfill, then verify migration history and health. This document does not authorize production migration or deployment.
4. Verify active Soyuz and Kirisame deployment versions, binding target, dispatch/publishing flags, exact Somatic policy, and secret presence without reading secret values. Configure the separate operator preflight token.
5. Call the operator preflight from an approved operator environment. Require `{ "status": "verified", "repository": "CyanAutomation/somatic" }`. A 401/503 or any rejected stage is a stop condition.
6. Verify the trusted Kaseki host image provenance, package/source compatibility, Queue/adapter health, producer support, rollback reference, and absence of active runs. Confirm the `SOYUZ_KIRISAME_PRODUCER_ENABLED` flag is still off until the canary window.
7. Re-run the focused Soyuz/Kaseki tests, confirm no existing active run could publish through both paths, record all deployment versions and rollback references, then enable the producer only for the approved canary window.

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

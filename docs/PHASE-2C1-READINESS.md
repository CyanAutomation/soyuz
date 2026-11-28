# Phase 2C.1 readiness and Phase 2C.2 canary runbook

**Reviewed:** 28 November 2026, 15:00 UTC
**Readiness:** **NOT READY**
**Scope:** read-only production verification and local Soyuz reliability/provenance changes. No production run, GitHub publication, Worker deployment, D1 write, secret change, migration, or backfill was performed. The operator freed 2.221 GB on Kaseki before the follow-up inspection; its API is now healthy, but source provenance, callback reconciliation, and child-container isolation remain unverified.

This is the authoritative deployment and rollout snapshot for the Kirisame integration. Historical commissioning records remain historical evidence; they are not rewritten as current verification.

## Current evidence

| Area | Verified state | Evidence and limit |
| --- | --- | --- |
| Soyuz source | `origin/main` is `f96b87ad223c8cabda9e1f2d3eaf5b457ba8d789`; main CI/deploy [#46152234577](https://github.com/CyanAutomation/soyuz/actions/runs/46152234577) and CodeQL [#46152234475](https://github.com/CyanAutomation/soyuz/actions/runs/46152234475) succeeded. | Active Worker version #67 (`5191522f-af5a-4d10-93ef-acdf0480d6d9`, deployment `5016b5bf-5002-43f8-a039-d6da8bf2ba5b`, 100% traffic, created 28 November 14:00 UTC) annotates source `f96b87ad223c8cabda9e1f2d3eaf5b457ba8d789`, app `0.1.0`, contract `1`, built `2026-11-28T13:59:24.125Z`. This proves the active source includes the merged Phase 2C.1 implementation. The additional late-success lease fence in this PR is local and not deployed. Previous Worker version #66 was `3e2f4e3f-a214-450d-a003-2dcd2122bb8b`, deployment `8387b029-ab8c-4435-8d6e-3a00de935bdd`; this is the available Worker rollback reference. |
| Soyuz production settings | Cloudflare settings at 14:47 UTC show `KIRISAME` → `kirisame.PublisherEntrypoint`, caller ID `soyuz`, the `KIRISAME_API_KEY` and `SOYUZ_OPERATOR_API_TOKEN` secret bindings present, dispatch `true`, and the exact Somatic/main/PR allowlist. | Secret values were not read. No settings or policy were changed. |
| Operator authentication | Missing-credential and synthetic-invalid bearer requests to `POST /v1/operator/kirisame/preflight` returned HTTP 401 `UNAUTHORIZED`; latest recorded request IDs are `dba03263-04e8-42ad-8035-bcc28266dd8f` and `683e7258-739f-45b2-a7ee-34a1c14fc149`. Earlier negative probes at 12:52 UTC also returned 401. | Neither negative test invoked Kirisame. Authenticated preflight remains outstanding because the existing token is not securely available to this environment; use only the approved operator secret manager. The exact timestamp for the two latest request IDs was not retained in the terminal output. |
| Public publishing boundary | Unauthenticated Soyuz `POST /v1/publications` returned 401 `UNAUTHORIZED` (request `e59e98f7-db2b-4fac-b532-7f6f2f4cabaa`, 12:52 UTC). Current Kirisame source still routes only GET public diagnostics/docs; `/internal/v1/publications` returns 404 and publishing is on its private binding. | No publisher RPC or GitHub mutation occurred. The attempted direct public Kiri POST probe was rejected by automatic review because it could potentially trigger a publication; it was not retried through another path. Public/private isolation is therefore source-verified but lacks a live negative POST result. |
| Kirisame production | Active Worker version #19 (`2970f2fc-6ccb-4183-8117-8c8a477232a7`, deployment `a63daef3-7bd9-4401-912a-293df60b1f17`, 100% traffic) reports source `4ff14b817eb3633251e8618739c19fa9335e99a5`, app `0.1.0`, contract `1`; publishing is available, App ID `3345400`, and App/caller secret bindings exist. | Current `main` is `025c369427e911961971cd266666723946e73d3c`, five commits ahead. The runtime change adds GET-only docs/OpenAPI routes; the private RPC implementation is unchanged and the public route still returns 404 for publication paths. Main CI [#45980861346](https://github.com/CyanAutomation/kirisame/actions/runs/45980861346) succeeded. No redeploy is indicated. Secret values were not read. |
| Production D1 | Migrations `0001` through `0012_run_outcome_projection.sql` are applied; 0012 was applied 26 November at 18:20 UTC. At 14:43:28 UTC: 33 runs (2 claimed, 7 completed, 24 failed), 0 publication rows, 0 intents. | Read-only Cloudflare queries wrote zero rows. Both claimed runs had `started_at=NULL`; their leases had expired 12–19 seconds before the query. D1 run state alone does not prove host/Queue ownership. |
| Outcome projection/backfill | `outcome_summary_json` is present for 23 of 31 retained terminal runs; eight are missing. At 14:35 UTC the bounded backfill eligibility query found zero valid recoverable candidates and zero malformed JSON; four retained payloads have no `outcomeSummary`, and four have no source result. | No backfill was run. Unavailable historical information is documented as unrecoverable rather than fabricated; the eligibility gate is satisfied to the extent retained source data permits. |
| Queue | `soyuz-runs` has one HTTP pull consumer, 24-hour retention, batch size 10, three retries, 30-second visibility, and DLQ `soyuz-runs-dlq`. At 14:43:28 UTC best-effort metrics reported backlog count/bytes 0. | Queue metrics do not identify an active host owner or callback backlog. No Queue message was pulled or leased. |
| Kaseki host | Termius host `kaseki`; API image package `1.160.1`, image ID and RepoDigest `sha256:96aa3ca809f2727b5568c5687f96cd4943f3d04f7352fa660705f3d96e50edf`, created `2026-11-27T18:45:10Z`. `GET /ready` returned 200 at 14:34:28 UTC; Docker health is healthy. Available disk is 3,914,072,064 bytes, above the 2 GiB minimum but below the 5 GiB warning threshold. | The running image has no OCI labels, so its source revision is unknown. The producer env var is unset (runtime default false). The only containers are Kaseki API, tunnel, and host management; no coding container or active local execution was observed. Existing host checkouts are stale/dirty and the Compose project directory label points to a missing path. No host files or container configuration were changed. |
| Credential isolation and producer | Current main implements the trusted manifest/intent flow, suppresses the direct publisher on the Kirisame route, filters child credentials, and hardens host Git inspection. A Kaseki Compose contract gap was found: the producer flag is not passed into the container; a local fix is prepared in the Kaseki PR. | No representative coding container is running, so runtime secret, mount, socket, Git-config, and network-isolation probes were not possible. Producer remains unset/disabled. Do not restart the host or enable the producer until the source/config checkout is identified and work is settled. |
| Callback compatibility | Soyuz main accepts optional `taskAdmission`; Kaseki main `e330b199858e1f8584e4d241ca6f6c9269e94a45` has passing main CI/image workflows [CI](https://github.com/CyanAutomation/kaseki-agent/actions/runs/46050073671), [image](https://github.com/CyanAutomation/kaseki-agent/actions/runs/46050140944). | The running image source remains unknown. Its persistent outbox has 502 entries: 500 delivered and 2 blocked terminal `failed` callbacks (one attempt each, created 26 November; no validation detail persisted). Local job records for both are failed and never start-authorized, while the same two D1 runs remain claimed with expired leases. This ownership/outbox mismatch is an explicit stop condition. |
| Artifact and retention | Soyuz migrations 0011/0012 retain records, artifacts, publication manifests, intents, and events to the canonical 90-day deadline. | Schema and production data were read only; no retention or backfill writes were performed. |

Phase 2C.2 remains blocked by the unavailable authenticated preflight, two unsettled/expired D1 claims that conflict with failed host jobs and blocked callbacks, unknown running-image source, unverified coding-container isolation, and the Compose producer-flag gap. The host's hard disk readiness failure is cleared, but capacity remains in warning. No D1 migration or eligible historical backfill work remains. Do not start the canary until the ownership/outbox state is reconciled and every required gate below is evidenced.

## Implementation and security notes

- Soyuz enforces its single exact repository policy again immediately before every private RPC. A missing, malformed, empty, or revoked policy blocks dispatch. Revocation prevents future writes; it cannot undo a GitHub mutation already accepted by Kirisame.
- At most eight automatic mutation attempts are reserved. An expired eighth lease transitions atomically to `blocked` with `PUBLICATION_OUTCOME_UNKNOWN`, preserves any known branch/PR fields, appends one operator-review event, and is excluded from later scheduler batches. Do not assume the PR is absent. Inspect GitHub read-only before any separately authorized recovery.
- The merged scheduler refreshes the clock for each dispatch and checks the lease before the publisher RPC. This PR adds a response-time compare-and-set that requires a live lease before recording success. A valid success arriving after lease expiry is now blocked as `PUBLICATION_OUTCOME_UNKNOWN` for operator review; a superseded attempt remains fenced by its attempt ID. The eight-attempt budget is unchanged.
- Missing caller identity/key is a permanent `KIRISAME_CALLER_CONFIGURATION_INVALID` block, not a retry loop. The publication event gives a sanitized operator action. Neither credential is stored in the immutable request or publication rows.
- Soyuz exposes `POST /v1/operator/kirisame/preflight`, guarded by the separate `SOYUZ_OPERATOR_API_TOKEN`. It calls the existing fixed-scope `verifyCanaryAuthorization` RPC with Soyuz's own `KIRISAME_CALLER_ID` and `KIRISAME_API_KEY`; it cannot publish and returns no token. The operator token must not equal client, worker, or Kaseki submission credentials. Its production secret binding is present; use the existing value through the approved operator secret manager only.
- Kirisame authenticates the caller but does not constrain the caller's repository choice. The App installation includes all CyanAutomation repositories; that is not a repository-level authorization boundary. A compromised authorized caller could request a repository outside its intended policy. Soyuz's exact dispatch policy, Kirisame caller authentication, and Kirisame's repository-scoped installation tokens are the current controls. Per-caller capability restrictions are useful defense in depth and should be considered in a separate ADR; no second receiver allowlist is added here.
- Kaseki's source persists `publicationRoute` before execution and suppresses its direct publisher for a Kirisame-routed run. It removes privileged credentials from the coding child. The trusted host must remain the only producer; do not enable automatic legacy fallback.

## Required rollout before the canary

1. Production D1 identity and migration history were read-only verified against the configured database. Migration 0012 is applied; do not reapply it or alter migration history.
2. The bounded backfill script reads only unexpired rows with `result_json` and writes only a schema-valid `result.outcomeSummary`. The current read-only assessment found no valid candidates. Do not fabricate the eight missing projections or perform a production backfill for them.
3. The active Soyuz version #67 is independently mapped to `origin/main` by its source annotation. This PR's late-response lease fence is not in production yet; merge and validate it, then deploy only through the established operator rollout process. Preserve version #67 and the previous #66 deployment as rollback references; no Worker deployment was performed here.
4. The live Worker binding, caller ID, dispatch gate, Somatic policy, and Kirisame secret-binding presence were verified. `SOYUZ_OPERATOR_API_TOKEN` is already configured; do not replace, rotate, or retrieve its plaintext from Cloudflare. Secret values remain unread.
5. Run the actual preflight from the approved operator environment after obtaining the existing token through its approved secret manager. Expected result is `{ "status": "verified", "repository": "CyanAutomation/somatic" }`. A 401/503 or any rejected stage is a stop condition; do not substitute the separate live-invoker credentials. The controlled unauthenticated and synthetic-invalid requests already returned 401 and did not invoke Kirisame.

   ```sh
   curl --fail-with-body --silent --show-error \
     --request POST "$SOYUZ_BASE_URL/v1/operator/kirisame/preflight" \
     --header "Authorization: Bearer ${SOYUZ_OPERATOR_API_TOKEN:?load from the approved secret manager}" \
     --header "Content-Type: application/json" \
     --data '{}'
   ```

6. Reconcile the two expired D1 claims with their failed, never-started host jobs and two blocked terminal callbacks. Verify canonical run state and host ownership before using any supported recovery action. Do not retry callbacks, cancel runs, or force claims from this readiness procedure. Queue backlog zero does not resolve this mismatch.
7. Keep `SOYUZ_KIRISAME_PRODUCER_ENABLED` unset/false outside the controlled canary window. The new Kaseki PR passes the flag through Compose with a false default. Once a clean, canonical Compose deployment directory is identified, the host is idle, the callback outbox is healthy, and the verified image is deployed, a separately authorized window may enable it as described below. The current host image has no traceable source revision, so it cannot yet be selected as a verified canary release.
8. Run the actual credential-isolation probe against a representative child container using synthetic sentinels, and verify the trusted host creates the manifest/evidence/intent. No coding container was running during commissioning, so source tests do not close this runtime gate.
9. Confirm the exact Somatic/main/PR policy, rerun focused Soyuz/Kaseki checks in CI's supported Linux/Node 26 environment, and record the verified image digest and a rollback digest. Do not start that canary during Phase 2C.1.1.

Do not broaden the policy, remove the legacy implementation, change the GitHub App installation, or run a second preflight using the separate live-invoker credentials as a substitute for Soyuz's own credentials.

### Controlled producer enablement procedure (not run)

The running container reported `SOYUZ_KIRISAME_PRODUCER_ENABLED` unset; source defaults it to `false`. The current host's Compose working-directory label points to a missing path, and its available source checkouts are stale or dirty. Do not run these commands until the operator has identified a clean, canonical deployment checkout and the queue, active claims, executions, and callback outbox have settled.

In that checkout, set the non-secret `.env` value to `SOYUZ_KIRISAME_PRODUCER_ENABLED=true` for the authorized window (leave all existing secrets and other settings intact), then check and recreate only the API service:

```sh
cd "$KASEKI_COMPOSE_DIR"
docker compose config --format json \
  | jq -e '.services["kaseki-api"].environment.SOYUZ_KIRISAME_PRODUCER_ENABLED == "true"'
docker compose up -d --no-deps --force-recreate kaseki-api
curl --fail-with-body --silent --show-error http://127.0.0.1:8080/ready
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' kaseki-api \
  | grep -Fx 'SOYUZ_KIRISAME_PRODUCER_ENABLED=true'
```

Before this restart, require every D1 run to be settled (no active-status rows and no expired claims awaiting reconciliation), zero claimed Queue messages, zero active local executions, and zero pending/blocked callbacks; a restart can interrupt adapter delivery. Confirm the running image digest and its four OCI labels after recreation. After the approved canary, change the value back to `false`, validate the rendered Compose setting, recreate the API service, and verify the environment reports `false`. Do not switch a persisted Kirisame route to the legacy publisher.

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

# Cloudflare setup and deployment

## Local setup

Use Node.js 24.11.0 or later. Install dependencies, copy the local variable template, and replace both token values with distinct random strings. Soyuz enforces a minimum of 16 characters; the 32-character example values are a stronger recommendation. Then apply the local D1 migration:

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Wrangler's local D1 and Queue bindings are used by local development. HTTP pull is for the external Kaseki host and is not an endpoint served by Soyuz.

## One-time Cloudflare bootstrap

```sh
npx wrangler d1 create soyuz-runs
npx wrangler queues create soyuz-runs
npx wrangler r2 bucket create soyuz-artifacts
```

OAuth uses a Cloudflare KV namespace. Create it and add the returned namespace ID to the `OAUTH_KV` binding in `wrangler.jsonc` before deploying the dashboard:

```sh
npx wrangler kv namespace create soyuz-oauth
```

The checked-in `wrangler.jsonc` already contains a non-zero D1 `database_id`. Verify that it identifies the intended database before deploying. If you create a different D1 database, replace the configured ID with the `database_id` returned by Wrangler and keep the configured database name and Queue name as `soyuz-runs` unless you update the corresponding bindings at the same time.

Set distinct production Worker secrets before the first deploy. Apply the initial migration as a separately authorized manual operation, generate Worker/binding types, then deploy once with an account administrator so the `soyuz` Worker is created:

```sh
npx wrangler secret put CLIENT_API_TOKEN
npx wrangler secret put KASEKI_SUBMISSION_API_TOKEN
npx wrangler secret put WORKER_API_TOKEN
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npm run db:migrate:remote
npm run cf:types
npm run deploy
```

`npm run db:migrate:remote` changes production D1 and requires D1 Edit access. Run it only with separate authorization from the Worker deployment. CI/CD never runs production migrations.

Set `SOYUZ_PUBLIC_URL` to the canonical HTTPS origin, such as `https://soyuz.example.com`, and `SOYUZ_OAUTH_ALLOWED_GITHUB_IDS` to a comma-separated allowlist of numeric GitHub user IDs as Worker variables or secrets. Configure the GitHub OAuth App callback URL to `${SOYUZ_PUBLIC_URL}/oauth/callback`. The dashboard API and OAuth access tokens remain unavailable unless the `OAUTH_KV` binding, callback origin, OAuth credentials, and non-empty allowlist are configured.

### OAuth consent security

**[OAUTH-CONSENT-ESCAPE-01]** The consent page escapes registered client metadata and form values, sends `Cache-Control: no-store`, and forbids framing with Content Security Policy. Approval accepts same-origin form submissions and is bound to the browser with a hashed transaction cookie. The flow requests only GitHub `read:user`; Soyuz stores the GitHub numeric ID/login and does not retain the GitHub access token.

**[OAUTH-CONSENT-COPY-01]** Consent explains dashboard access in plain language and shows human-readable permission descriptions rather than internal scope identifiers.

The `ARTIFACTS` R2 binding stores private run files. Worker uploads are limited to 25,000,000 bytes per file and 100 artifacts per run, require the current worker ID and claim fencing token, and are retained for 30 days. Authenticated client/OAuth reads are streamed as attachments. The minutely cron culls runs beyond the newest 30, including their events and artifact indexes. It records old R2 object keys in a durable deletion queue and retries failed or unavailable-storage deletions independently of run retention. The daily cron removes expired R2 objects and D1 metadata. It also redacts submitted request details from terminal runs after 365 days, replacing the prompt and custom inputs while preserving run events, status, repository/ref metadata, and idempotency history. A redacted run cannot be retried because its original request is no longer available. At most 100 requests are redacted per daily sweep.

Dashboard assets receive a restrictive Content Security Policy, `no-referrer`, MIME sniffing protection, and frame protections. Dashboard HTML is served with `Cache-Control: no-store`; stable CSS and JavaScript asset URLs use `public, max-age=300, must-revalidate` so browsers refresh deployed bundles within five minutes. Authenticated API responses remain `no-store` because run state and artifact metadata can change. Artifact downloads remain `private, no-store` for clients, while the Worker may cache artifacts up to 1 MB in the per-location Cache API for at most one hour and never beyond their D1 expiry. The Worker checks the caller's authorization, run retention, and artifact expiry before consulting that cache; cache failures fall back to R2. **[HEALTH-SCHEMA-01]** `/health` verifies the D1 schema used by run liveness, retry lineage, request retention, idempotency, and artifact cleanup as well as database connectivity; it reports unavailable until required schema migrations are applied.

## API token configuration

**[AUTH-MINIMUM-01]** Cloudflare secrets are not checked into the repository. Soyuz enforces a 16-character minimum for API tokens; use distinct random values of at least 32 characters as recommended by `.dev.vars.example`. Use the same `WORKER_API_TOKEN` on the Kaseki callback client and status poller. When Kaseki submission routing is enabled, configure a separate `KASEKI_SUBMISSION_API_TOKEN` and set `KASEKI_SUBMISSION_IDENTITY` to a stable deployment label such as `kaseki-prod`. The scoped token is limited to run creation, canonical retry and cancellation; it must differ from `CLIENT_API_TOKEN`. Do not reuse client, worker, or Kaseki credentials.

API tokens do not expire on their own. For a no-downtime rotation, first configure the matching `*_PREVIOUS` token and `*_PREVIOUS_EXPIRES_AT` secrets with the old key and a UTC expiry no more than 14 days away, then replace the current `CLIENT_API_TOKEN`, `WORKER_API_TOKEN`, or `KASEKI_SUBMISSION_API_TOKEN`. Update clients to the new key during that window. The old key is rejected after its expiry even if the previous-key secrets remain configured; remove those secrets after rotation. If the overlap is absent or invalid, old keys stop working as soon as the current secret changes. A missing current Worker-side key makes protected requests return 503 `AUTHENTICATION_UNAVAILABLE`; an outdated client key returns 401 `UNAUTHORIZED`.

## Configure external HTTP pull

Enable HTTP pull for the Queue from Cloudflare, or run:

```sh
npx wrangler queues consumer http add soyuz-runs
```

Create a separate API token for the Kaseki host with Queue read and write permissions. The host needs write permission because it must acknowledge or retry leases. Store that token in the host's secret manager; it is not a Soyuz Worker secret.

Create a separate dead-letter Queue, for example `soyuz-runs-dlq`, and configure the HTTP pull consumer with a finite `max_retries` value (for example, 5) and that DLQ. Verify the consumer settings in Cloudflare before enabling unattended Kaseki polling. Without a DLQ, messages that reach the retry limit are deleted. The host guide explains poison-message review and replay.

The `soyuz-runs` Queue currently retains messages for 24 hours. Soyuz's one-minute reconciler republishes D1 runs that remain `queued` for 12 hours, leaving time for a replacement message to reach Kaseki before Queue retention expires. Keep Queue retention longer than this recovery interval or adjust the interval with it.

## GitHub Actions deployment

`.github/workflows/ci.yml` runs on pull requests to `main` and pushes to `main`. It lints `.yml` and `.yaml` workflow files with actionlint and scans them with zizmor. Pull requests review dependency changes and report numbered SQL migrations in the `D1 migration impact` job summary. That job rejects edits or deletions of numbered migration files already present on the base branch; add a new numbered migration for schema changes. The check has no production credentials and does not query or change production. Validation requires both PR review checks to pass, then runs `npm ci`, `npm run typecheck`, `npm test`, and the Wrangler deployment dry run.

On a push to `main`, validation builds the Worker bundle and dashboard assets, then uploads them as a short-lived artifact. The deploy job downloads and deploys that same bundle without rebuilding it. The standalone `Production D1 migration preflight` job verifies the configured D1 database identity and compares `d1_migrations` with every numbered SQL filename in `migrations/`. A missing, unexpected, or out-of-order migration blocks deployment. It uses the separate D1 Read token and does not apply migrations or use the Worker deployment token. The Worker deploy job depends on successful validation and preflight; its post-deploy `/health` check verifies Worker/D1 connectivity and the schema required by the current Worker version.

Create a GitHub environment named `production` and add these environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_D1_READ_API_TOKEN`

Create `CLOUDFLARE_API_TOKEN` with Workers Editor restricted to the existing `soyuz` Worker. Set a one-year expiry and rotate the token in Cloudflare and GitHub before it expires. Give `CLOUDFLARE_D1_READ_API_TOKEN` D1 Read access only, scoped to the production account and `soyuz-runs` database where Cloudflare supports resource-level restriction. Do not grant D1 Edit to either CI token. Restrict the `production` environment to deployments from `main`; production deployments do not require an approval gate. Protect `main` by requiring the `Review dependency changes`, `D1 migration impact`, and `Typecheck, tests, and deployment validation` pull request checks before merge. Keep `CLIENT_API_TOKEN` and `WORKER_API_TOKEN` as Cloudflare Worker secrets, not GitHub repository files. The first deployment creates the Worker and therefore must be done separately with an account administrator. If a Wrangler step fails for missing permissions, record its exact command and Cloudflare error and request only the needed permission.

For an authorized production migration, first verify the target database name and ID in `wrangler.jsonc`, then run `npm run db:migrate:remote` manually. This invokes `wrangler d1 migrations apply soyuz-runs --remote` and requires D1 Edit. The Cloudflare account token interface currently applies D1 Edit account-wide, so use an administrator-approved manual session or another approved migration path; never add this permission to a CI token. After it completes, run `node scripts/verify-production-migrations.ts` with the read-only account and D1 token environment variables, and confirm the reported migration count before deploying. The CI preflight blocks deployment until history matches.

## Authorized live acceptance check

Submitting a run creates executable work that an enabled Kaseki host may immediately consume. Do this only after explicit authorization for the live run and its resource costs, and use a disposable repository, `publishMode: none`, a non-production Queue where available, a short timeout, and a bounded task. Do not use the Soyuz or Kaseki source repositories as the smoke-test target.

Use the production smoke helper for a repeatable preflight and run check. It verifies `/health`, checks for active canonical runs, confirms an HTTP pull consumer has a DLQ, and peeks at the Queue without leasing messages. By default it performs only those read-only checks:

```sh
npm run soyuz:smoke
```

To submit one inspect-only run, provide `SOYUZ_BASE_URL`, `CLIENT_API_TOKEN`, `SOYUZ_WORKER_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SOYUZ_QUEUE_ID`, `SOYUZ_QUEUE_API_TOKEN`, `SMOKE_IDEMPOTENCY_KEY`, and `DISPOSABLE_REPO_URL` through the existing secret manager. Set `SOYUZ_SMOKE_ACK_EXECUTION=yes` only after authorizing the specific run. The helper fixes `taskMode` to `inspect` and `publishMode` to `none`, defaults to a 180-second run timeout, and verifies both start and completion events. If polling times out, it reports the run ID and does not cancel the job automatically. Reuse the same idempotency key when checking or retrying an uncertain submission.

```sh
SOYUZ_SMOKE_ACK_EXECUTION=yes npm run soyuz:smoke -- --run
```

Before enabling a production consumer, review active D1 runs and read-only peek at Queue messages. Resolve who owns any existing work; do not delete/cancel a run or pull a message to “inspect” it. Cloudflare's `messages/peek` endpoint does not lease messages.

Set `SOYUZ_BASE_URL`, `CLIENT_API_TOKEN`, `SOYUZ_WORKER_API_TOKEN`, `SMOKE_IDEMPOTENCY_KEY` (an RFC UUID), `DISPOSABLE_REPO_URL`, `CLOUDFLARE_ACCOUNT_ID`, `SOYUZ_QUEUE_ID`, and `SOYUZ_QUEUE_API_TOKEN`. Use tokens supplied through the existing secret manager, not shell history or committed files. First check canonical API health, the authenticated run list, Worker detail for a known run, and Queue backlog/peek. Then submit an approved smoke run using a unique idempotency key and inspect its D1/API, Queue, Kaseki mapping, Docker, event, and terminal states independently.

Example bounded request (replace the disposable URL and prompt with the authorized smoke task):

```sh
curl --fail-with-body --silent --show-error \
  --request POST "$SOYUZ_BASE_URL/v1/runs" \
  --header "Authorization: Bearer $CLIENT_API_TOKEN" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: $SMOKE_IDEMPOTENCY_KEY" \
  --data "{\"repoUrl\":\"$DISPOSABLE_REPO_URL\",\"taskPrompt\":\"Make one small, bounded change in the disposable test repository and report the result.\",\"taskMode\":\"patch\",\"publishMode\":\"none\"}"

# Set RUN_ID to data.id from the HTTP 202 response, then read canonical state.
curl --fail-with-body --silent --show-error \
  "$SOYUZ_BASE_URL/v1/runs/$RUN_ID" \
  --header "Authorization: Bearer $CLIENT_API_TOKEN"

curl --fail-with-body --silent --show-error \
  "$SOYUZ_BASE_URL/v1/worker/runs/$RUN_ID" \
  --header "Authorization: Bearer $SOYUZ_WORKER_API_TOKEN"
```

Check for a queued message without taking its lease:

```sh
curl --fail-with-body --silent --show-error \
  --request POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/$SOYUZ_QUEUE_ID/messages/peek" \
  --header "Authorization: Bearer $SOYUZ_QUEUE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"batch_size":10}'
```

Do not manually pull or acknowledge the test message while validating the Kaseki consumer; let the adapter exercise the production handoff and compare its one local mapping and Docker execution with the canonical run ID. Run a controlled failure only after the successful path is proven and explicitly authorized. Do not claim end-to-end success based only on `/health` or D1 connectivity.

## Worker configuration

`wrangler.jsonc` declares the Worker entry point, compatibility date, D1 binding and database ID, Queue producer binding, R2 bucket, static dashboard assets, required secret names, observability, and cron triggers for minutely reconciliation/culling and daily retention cleanup. Add the `OAUTH_KV` namespace ID returned during bootstrap. Queue pull mode remains an external consumer configuration. The D1 ID is a resource identifier; account IDs and production credentials are not committed here.

Migration `0002_run_liveness.sql` adds heartbeat and operational-health columns; `0003_run_artifacts.sql` adds run artifact metadata and a pending-plus-ready artifact cap; `0004_run_origin_retry.sql` adds authenticated run provenance, origin-scoped idempotency and retry lineage; `0005_request_payload_retention.sql` adds request redaction tracking; `0006_run_retention_outboxes.sql` adds durable idempotency and artifact-deletion ledgers; `0007_run_display_ids.sql` adds stable human-facing Soyuz run IDs and backfills existing runs. Apply all pending migrations with the separately authorized `npm run db:migrate:remote` procedure before deploying code that reads them. Never recreate the database or discard run history as a migration repair.

Generate runtime and binding types after changing Wrangler bindings:

```sh
npm run cf:types
```

For rollback, deploy the prior Worker version and keep D1 migrations backward compatible. Do not delete the D1 database or Queue as part of a code rollback.

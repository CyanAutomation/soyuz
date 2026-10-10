# Cloudflare setup and deployment

## Local setup

Use Node.js 22 or later. Install dependencies, copy the local variable template, replace both token values with different random strings of at least 32 characters, then apply the local D1 migration:

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
```

Copy the D1 `database_id` returned by Wrangler into `wrangler.jsonc`, replacing the all-zero local placeholder. The database name and Queue name should remain `soyuz-runs` unless the bindings are changed in the config at the same time.

Set distinct production Worker secrets before the first deploy. Apply the initial migration as a separately authorized manual operation, generate Worker/binding types, then deploy once with an account administrator so the `soyuz` Worker is created:

```sh
npx wrangler secret put CLIENT_API_TOKEN
npx wrangler secret put WORKER_API_TOKEN
npm run db:migrate:remote
npm run cf:types
npm run deploy
```

`npm run db:migrate:remote` changes production D1 and requires D1 Edit access. Run it only with separate authorization from the Worker deployment. CI/CD never runs production migrations.

## API token configuration

**[AUTH-MINIMUM-01]** Cloudflare secrets are not checked into the repository. Configure both API tokens with at least 16 characters. Use the same `WORKER_API_TOKEN` on the Kaseki callback client and status poller. Do not reuse the client token as the worker token. Soyuz does not expire these static secrets automatically; rotate them in Cloudflare and update clients together. A missing Worker-side key makes protected requests return 503 `AUTHENTICATION_UNAVAILABLE`; an outdated client key returns 401 `UNAUTHORIZED`.

## Configure external HTTP pull

Enable HTTP pull for the Queue from Cloudflare, or run:

```sh
npx wrangler queues consumer http add soyuz-runs
```

Create a separate API token for the Kaseki host with Queue read and write permissions. The host needs write permission because it must acknowledge or retry leases. Store that token in the host's secret manager; it is not a Soyuz Worker secret.

Create a separate dead-letter Queue, for example `soyuz-runs-dlq`, and configure the HTTP pull consumer with a finite `max_retries` value (for example, 5) and that DLQ. Verify the consumer settings in Cloudflare before enabling unattended Kaseki polling. Without a DLQ, messages that reach the retry limit are deleted. The host guide explains poison-message review and replay.

## GitHub Actions deployment

`.github/workflows/ci.yml` runs on pull requests to `main` and pushes to `main`. Pull requests run `npm ci`, `npm run typecheck`, `npm test`, and `npx wrangler deploy --dry-run`. Before a push to `main` deploys the Worker, the workflow reads D1's `d1_migrations` history and checks it against every numbered SQL file in `migrations/`. A missing, unexpected, or out-of-order migration blocks deployment. The check uses a separate D1 Read token; it does not apply migrations or use the Worker deployment token. The post-deploy `/health` check is still required, but it only proves basic Worker/D1 connectivity and does not replace the schema check.

Create a GitHub environment named `production` and add these environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_D1_READ_API_TOKEN`

Create `CLOUDFLARE_API_TOKEN` with Workers Editor restricted to the existing `soyuz` Worker. Set a one-year expiry and rotate the token in Cloudflare and GitHub before it expires. Give `CLOUDFLARE_D1_READ_API_TOKEN` D1 Read access only, scoped to the production account and `soyuz-runs` database where Cloudflare supports resource-level restriction. Do not grant D1 Edit to either CI token. Restrict the `production` environment to deployments from `main`; production deployments do not require an approval gate. Keep `CLIENT_API_TOKEN` and `WORKER_API_TOKEN` as Cloudflare Worker secrets, not GitHub repository files. The first deployment creates the Worker and therefore must be done separately with an account administrator. If a Wrangler step fails for missing permissions, record its exact command and Cloudflare error and request only the needed permission.

For an authorized production migration, first verify the target database name and ID in `wrangler.jsonc`, then run `npm run db:migrate:remote` manually. This invokes `wrangler d1 migrations apply soyuz-runs --remote` and requires D1 Edit. The Cloudflare account token interface currently applies D1 Edit account-wide, so use an administrator-approved manual session or another approved migration path; never add this permission to a CI token. After it completes, run `node scripts/verify-production-migrations.mjs` with the read-only account and D1 token environment variables, and confirm the reported migration count before deploying. The CI preflight blocks deployment until history matches.

## Authorized live acceptance check

Submitting a run creates executable work that an enabled Kaseki host may immediately consume. Do this only after explicit authorization for the live run and its resource costs, and use a disposable repository, `publishMode: none`, a non-production Queue where available, a short timeout, and a bounded task. Do not use the Soyuz or Kaseki source repositories as the smoke-test target.

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

`wrangler.jsonc` declares the Worker entry point, compatibility date, D1 binding and database ID, Queue producer binding, required secret names, observability, and the one-minute admission reconciliation cron. Queue pull mode remains an external consumer configuration. The D1 ID is a resource identifier; account IDs and production credentials are not committed here.

Migration `0002_run_liveness.sql` adds the heartbeat and operational-health columns. Apply all pending migrations with the separately authorized `npm run db:migrate:remote` procedure before deploying code that reads them. Never recreate the database or discard run history as a migration repair.

Generate runtime and binding types after changing Wrangler bindings:

```sh
npm run cf:types
```

For rollback, deploy the prior Worker version and keep D1 migrations backward compatible. Do not delete the D1 database or Queue as part of a code rollback.

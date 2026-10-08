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

## GitHub Actions deployment

`.github/workflows/ci.yml` runs on pull requests to `main` and pushes to `main`. Pull requests run `npm ci`, `npm run typecheck`, `npm test`, and `npx wrangler deploy --dry-run`. A push to `main` deploys the Worker and checks the deployed `/health` endpoint when both production secrets are configured. The health check exercises D1 through the Worker binding; deployment does not require direct D1 API access.

Create a GitHub environment named `production` and add these environment secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Create `CLOUDFLARE_API_TOKEN` with Workers Editor restricted to the existing `soyuz` Worker. Set a one-year expiry and rotate the token in Cloudflare and GitHub before it expires. Do not grant D1 permissions: the deployed Worker uses its existing D1 binding at runtime, while migrations remain manual. Restrict the `production` environment to deployments from `main`; production deployments do not require an approval gate. Keep `CLIENT_API_TOKEN` and `WORKER_API_TOKEN` as Cloudflare Worker secrets, not GitHub repository files. The first deployment creates the Worker and therefore must be done separately with an account administrator. If the `wrangler deploy` step fails with the Worker-only token, record the exact failing command and Cloudflare error and request only the missing Worker permission; do not add D1 Edit.

For an authorized production migration, run `npm run db:migrate:remote` manually. This invokes `wrangler d1 migrations apply soyuz-runs --remote` and requires D1 Edit. The Cloudflare account token interface currently applies D1 Edit account-wide, so use an administrator-approved manual session or another approved migration path; never add this permission to the CI token.

## One-time live acceptance check

Run this before a Kaseki host is polling the Queue. Set `SOYUZ_BASE_URL`, `CLIENT_API_TOKEN`, `SMOKE_IDEMPOTENCY_KEY` (an RFC UUID), `CLOUDFLARE_ACCOUNT_ID`, `SOYUZ_QUEUE_ID`, and `SOYUZ_QUEUE_API_TOKEN`. Use the Queue ID returned by Wrangler. The Queue token is a separate account-scoped Queue Read+Write credential.

Example request and persisted-state check:

```sh
curl --fail-with-body --silent --show-error \
  --request POST "$SOYUZ_BASE_URL/v1/runs" \
  --header "Authorization: Bearer $CLIENT_API_TOKEN" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: $SMOKE_IDEMPOTENCY_KEY" \
  --data '{"repoUrl":"https://github.com/CyanAutomation/soyuz","taskPrompt":"Deployment smoke test only; do not execute or publish work.","taskMode":"inspect","publishMode":"none"}'

# Set RUN_ID to data.id from the HTTP 202 response.
curl --fail-with-body --silent --show-error \
  "$SOYUZ_BASE_URL/v1/runs/$RUN_ID" \
  --header "Authorization: Bearer $CLIENT_API_TOKEN"

npx wrangler d1 execute soyuz-runs --remote \
  --command="SELECT id, status, contract_version FROM runs WHERE id = '$RUN_ID';"
```

For JSON messages, decode `result.messages[].body` before checking `contractVersion` and `runId`. Set `LEASE_ID` from the matching message and acknowledge only that message:

```sh
curl --fail-with-body --silent --show-error \
  --request POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/$SOYUZ_QUEUE_ID/messages/pull" \
  --header "Authorization: Bearer $SOYUZ_QUEUE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"visibility_timeout_ms":60000,"batch_size":5}'

curl --fail-with-body --silent --show-error \
  --request POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/$SOYUZ_QUEUE_ID/messages/ack" \
  --header "Authorization: Bearer $SOYUZ_QUEUE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data "{\"acks\":[{\"lease_id\":\"$LEASE_ID\"}],\"retries\":[]}"
```

## Worker configuration

`wrangler.jsonc` declares the Worker entry point, compatibility date, D1 binding and database ID, Queue producer binding, required secret names, observability, and the one-minute admission reconciliation cron. Queue pull mode remains an external consumer configuration. The D1 ID is a resource identifier; account IDs and production credentials are not committed here.

Generate runtime and binding types after changing Wrangler bindings:

```sh
npm run cf:types
```

For rollback, deploy the prior Worker version and keep D1 migrations backward compatible. Do not delete the D1 database or Queue as part of a code rollback.

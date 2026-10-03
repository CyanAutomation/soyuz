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

## Create Cloudflare resources

```sh
npx wrangler d1 create soyuz-runs
npx wrangler queues create soyuz-runs
```

Copy the D1 `database_id` returned by Wrangler into `wrangler.jsonc`, replacing the all-zero local placeholder. The database name and Queue name should remain `soyuz-runs` unless the bindings are changed in the config at the same time.

Apply the migration, generate Worker/binding types, configure distinct production secrets, and deploy:

```sh
npm run db:migrate:remote
npm run cf:types
npx wrangler secret put CLIENT_API_TOKEN
npx wrangler secret put WORKER_API_TOKEN
npm run deploy
```

Cloudflare secrets are not checked into the repository. Use the same `WORKER_API_TOKEN` on the Kaseki callback client and status poller. Do not reuse the client token as the worker token.

## Configure external HTTP pull

Enable HTTP pull for the Queue from Cloudflare, or run:

```sh
npx wrangler queues consumer http add soyuz-runs
```

Create a separate API token for the Kaseki host with Queue read and write permissions. The host needs write permission because it must acknowledge or retry leases. Store that token in the host's secret manager; it is not a Soyuz Worker secret.

## Worker configuration

`wrangler.jsonc` declares the Worker entry point, compatibility date, D1 binding, Queue producer binding, required secret names, observability, and the one-minute admission reconciliation cron. Queue pull mode remains an external consumer configuration. There are no account IDs, live D1 IDs, or production credentials committed here.

Generate runtime and binding types after changing Wrangler bindings:

```sh
npm run cf:types
```

For rollback, deploy the prior Worker version and keep D1 migrations backward compatible. Do not delete the D1 database or Queue as part of a code rollback.

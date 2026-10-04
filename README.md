# Soyuz

Soyuz is the Cloudflare control plane for Kaseki. It accepts authenticated run requests, persists canonical run state in D1, publishes versioned jobs to Cloudflare Queues, and records callbacks from Kaseki execution hosts. Kaseki continues to own Docker, repository access, Pi, validation, safety admission, and publication.

## Local development

Requirements: Node.js 22 or later and npm.

```sh
npm install
cp .dev.vars.example .dev.vars
# Set distinct random values in .dev.vars before starting the Worker.
npm run cf:types
npm run db:migrate:local
npm run dev
```

The local Worker uses Wrangler's local D1 database and Queue binding. `.dev.vars` and the generated `worker-configuration.d.ts` are ignored by Git. For Cloudflare's Worker runtime test harness, run `npm test`; `npm run typecheck` refreshes Wrangler's binding/runtime types and checks TypeScript.

## API overview

`GET /health` is public and checks that the Worker can read D1 and that both API keys are configured. If either check fails, it returns HTTP 503 with a message and request ID. Client endpoints use `Authorization: Bearer $CLIENT_API_TOKEN`:

```text
GET  /health
POST /v1/runs
GET  /v1/runs?limit=25&status=queued
GET  /v1/runs/:id
GET  /v1/runs/:id/events?after=0&limit=100
POST /v1/runs/:id/cancel
POST /mcp (Streamable HTTP MCP)
```

Worker callbacks use a separate `Authorization: Bearer $WORKER_API_TOKEN`:

```text
GET  /v1/worker/runs/:id
POST /v1/worker/runs/:id/claim
POST /v1/worker/runs/:id/started
POST /v1/worker/runs/:id/events
POST /v1/worker/runs/:id/completed
POST /v1/worker/runs/:id/failed
POST /v1/worker/runs/:id/cancelled
```

All Soyuz↔Kaseki messages carry `contractVersion: "1"`. See [the architecture](docs/ARCHITECTURE.md), [contract](docs/CONTRACT.md), [Kaseki integration plan](docs/KASEKI-INTEGRATION.md), and [Cloudflare setup](docs/DEPLOYMENT.md).

Client and worker keys are static bearer secrets; Soyuz does not assign them an automatic expiry time. Rotating or revoking a configured key makes earlier keys invalid. Authentication errors return 401 with guidance to use the current key; a missing server-side key returns 503 so it is distinguishable from a caller credential error.

The `/mcp` endpoint exposes the client-facing `create_run`, `list_runs`, `get_run`, `get_run_events`, and `cancel_run` tools over stateless Streamable HTTP. It uses the client bearer token; worker callbacks are not exposed through MCP. See [the MCP interface and security boundary](docs/MCP.md).

## Provisioning Cloudflare resources

Create a D1 database and Queue, then copy the D1 database ID into `wrangler.jsonc`:

```sh
npx wrangler d1 create soyuz-runs
npx wrangler queues create soyuz-runs
npm run db:migrate:remote
npx wrangler secret put CLIENT_API_TOKEN
npx wrangler secret put WORKER_API_TOKEN
npm run deploy
```

Enable the Queue's HTTP pull consumer for the Kaseki host separately in Cloudflare. See [deployment and secret setup](docs/DEPLOYMENT.md) and [Kaseki integration](docs/KASEKI-INTEGRATION.md) for the required pull permissions and acknowledgement contract.

## Scope

This repository implements the Soyuz side only. The queue consumer and callback client in `kaseki-agent` are a follow-up integration; Soyuz does not run containers or execute repository code.

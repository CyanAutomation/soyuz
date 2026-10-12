[![CI and deploy](https://github.com/CyanAutomation/soyuz/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CyanAutomation/soyuz/actions/workflows/ci.yml)

# Soyuz

Soyuz is the Cloudflare control plane for Kaseki. It accepts authenticated run requests, persists canonical run state in D1, publishes versioned jobs to Cloudflare Queues, and records callbacks from Kaseki execution hosts. Kaseki continues to own Docker, repository access, Pi, validation, safety admission, and publication.

## Local development

Requirements: Node.js 22 or later and npm. The local token check enforces a 16-character minimum; the example values are longer to encourage stronger secrets. Keep the client and worker tokens distinct.

```sh
npm install
cp .dev.vars.example .dev.vars
# Set distinct random values in .dev.vars before starting the Worker.
npm run cf:types
npm run db:migrate:local
npm run dev
```

The local Worker uses Wrangler's local D1 database and Queue binding. `.dev.vars` and the generated `worker-configuration.d.ts` are ignored by Git. To try a local request, keep `npm run dev` running in one terminal, then set `CLIENT_API_TOKEN` in a second terminal to the same value from `.dev.vars` and submit a run:

```sh
export CLIENT_API_TOKEN='the-client-token-from-.dev.vars'
curl --fail-with-body --silent --show-error \
  --request POST http://localhost:8787/v1/runs \
  --header "Authorization: Bearer $CLIENT_API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"repoUrl":"https://github.com/example/demo","taskPrompt":"Verify local Soyuz queue admission.","publishMode":"none"}'
```

An accepted request returns HTTP `202` with a JSON body containing `data.id`, `data.status` (`queued`), and `requestId`. This local request writes to local D1 and the local Queue; it does not execute the request unless a Queue consumer is separately configured. Each invocation without an idempotency key creates a new run.

The [transport contract](docs/CONTRACT.md) documents request fields, responses, pagination, and errors. For Cloudflare's Worker runtime test harness, run `npm test`; `npm run typecheck` refreshes Wrangler's binding/runtime types and checks TypeScript.

## API overview

`GET /health` is public and checks that the Worker can read D1 and that both API keys are configured. If either check fails, it returns HTTP 503 with a message and request ID. Client endpoints use `Authorization: Bearer $CLIENT_API_TOKEN`:

```text
GET  /health
POST /v1/runs
GET  /v1/runs?limit=25&status=queued
GET  /v1/runs/:id
GET  /v1/runs/:id/events?after=0&limit=100
GET  /v1/runs/:id/artifacts
GET  /v1/runs/:id/artifacts/:artifactId
POST /v1/runs/:id/cancel
POST /mcp (Streamable HTTP MCP)
GET  /dashboard/ (GitHub OAuth, read-only)
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
PUT  /v1/worker/runs/:id/artifacts/:artifactId
```

Artifact uploads require the current worker ID and claim callback ID as headers, are limited to 25 MB each and 100 per run, and are retained for 30 days. The dashboard uses OAuth with an explicit GitHub user-ID allowlist; it exposes read-only run and artifact data.

All Soyuz↔Kaseki messages carry `contractVersion: "1"`. See [the architecture](docs/ARCHITECTURE.md), [transport contract](docs/CONTRACT.md), [MCP interface](docs/MCP.md), [Kaseki integration](docs/KASEKI-INTEGRATION.md), and [Cloudflare setup](docs/DEPLOYMENT.md).

Client and worker keys are static bearer secrets; Soyuz does not assign them an automatic expiry time. Rotating or revoking a configured key makes earlier keys invalid. Authentication errors return 401 with guidance to use the current key; a missing server-side key returns 503 so it is distinguishable from a caller credential error.

The `/mcp` endpoint exposes the client-facing `create_run`, `list_runs`, `get_run`, `get_run_events`, and `cancel_run` tools over stateless Streamable HTTP. It uses the client bearer token; worker callbacks are not exposed through MCP. See [the MCP interface and security boundary](docs/MCP.md).

## Provisioning Cloudflare resources

Create a D1 database and Queue, then copy the D1 database ID into `wrangler.jsonc`:

```sh
npx wrangler d1 create soyuz-runs
npx wrangler queues create soyuz-runs
npx wrangler r2 bucket create soyuz-artifacts
# Create the soyuz-oauth KV namespace and add its returned ID as OAUTH_KV in wrangler.jsonc.
npx wrangler secret put CLIENT_API_TOKEN
npx wrangler secret put WORKER_API_TOKEN
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
# Only after separately authorizing a production D1 migration:
npm run db:migrate:remote
npm run deploy
```

Set `SOYUZ_PUBLIC_URL` and `SOYUZ_OAUTH_ALLOWED_GITHUB_IDS` as Worker variables or secrets. Apply remote D1 migrations only through the separately authorized migration procedure in the [deployment guide](docs/DEPLOYMENT.md).

Enable the Queue's HTTP pull consumer for the Kaseki host separately in Cloudflare. See [deployment and secret setup](docs/DEPLOYMENT.md) and [Kaseki integration](docs/KASEKI-INTEGRATION.md) for the required pull permissions and acknowledgement contract.

## Scope

The opt-in Queue consumer and callback client are implemented in [`kaseki-agent`](https://github.com/CyanAutomation/kaseki-agent/tree/main/src/integrations/soyuz); see the [host integration guide](https://github.com/CyanAutomation/kaseki-agent/blob/main/docs/SOYUZ_INTEGRATION.md) for configuration and recovery. The adapter is disabled by default, and direct Kaseki API and CLI runs remain available. Soyuz owns the control-plane API and canonical run state; the Kaseki host continues to run containers and execute repository code.

## Development and support

Run `npm run typecheck` to generate Wrangler types and check TypeScript, and `npm test` to run the Worker runtime test suite. The [CI workflow](.github/workflows/ci.yml) also validates the deployment bundle. See the [license](LICENSE) for reuse terms and [GitHub Issues](https://github.com/CyanAutomation/soyuz/issues) to report a problem.

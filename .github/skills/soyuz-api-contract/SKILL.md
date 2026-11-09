---
name: soyuz-api-contract
description: Use when changing Soyuz REST request or response shapes, UTCP agent tools, run contracts, or the Soyuz to Kaseki version 1 interface.
---

# Change a Soyuz API contract

Keep the public REST API, UTCP manual, agent HTTP adapter, shared application operations, and Kaseki wire format consistent. Start by reading `docs/CONTRACT.md`, `docs/ARCHITECTURE.md`, `docs/UTCP.md`, and `docs/TEST-REQUIREMENTS.md`.

## Locate the right layer

- Request and callback schemas live in `src/contracts/`.
- REST routing and response translation live in `src/api/`.
- Shared admission, reads, retries, and cancellation live in `src/application/runs.ts`.
- D1 persistence lives in `src/db/runs.ts`.
- UTCP input/output contracts live in `src/contracts/agent-tools.ts`; discovery is in `src/utcp/manual.ts`; agent routes and safe projections live in `src/api/agent-runs.ts`.
- Top-level route dispatch and authentication boundaries live in `src/index.ts`.

Keep business rules and persistence in the shared application layer. REST and UTCP agent routes should call the same operations rather than implementing separate run behavior.

## Preserve the contract boundaries

- Soyuz to Kaseki Queue messages and worker callbacks use `contractVersion: "1"`. Keep existing V1 behavior compatible; do not repurpose fields or silently accept a new message version.
- Soyuz validates request structure. Kaseki owns execution-context admission, host readiness, repository access, Docker, validation, and publication.
- Client, scoped Kaseki submission, worker, and OAuth credentials have separate permissions. UTCP agent routes accept only the client bearer token and must not expose worker routes or worker credentials.
- Idempotency keys are UUIDs scoped to the authenticated origin. Normalize them consistently, preserve replay behavior, and require callers to reuse the same key after an uncertain admission.
- Run UUIDs are canonical API and Queue identifiers. `soyuz-N` display IDs are for people and must not replace UUIDs in API calls.
- Keep REST success and error envelopes stable. Preserve documented status codes and error codes when adding validation or failure cases.
- Treat every serialized result as a data boundary. Return explicit allowlisted fields; scrub credentials and query components from URLs. Do not expose worker lease data, arbitrary database fields, raw execution output, or private artifacts through the agent API.
- V1 rejects `webhookConfig` because it can contain a signing secret and has no defined secret-storage or delivery owner. Do not pass secret-bearing fields through D1 or Queue without a separately designed contract.

## Update implementation and evidence together

When behavior changes, update the relevant schema, shared operation, adapter, public projection, and contract documentation as one change. For UTCP, also check the official manual schema, HTTP method/path/query/body mappings, client bearer auth metadata, response envelopes, pagination bounds, and safe data projection with the official TypeScript client.

Add or update focused tests in `tests/api.test.ts`, `tests/utcp.test.ts`, or the relevant contract tests. If the change establishes or alters a user-visible requirement, update its entry in `docs/TEST-REQUIREMENTS.md` and link it to the contract section. Check error, retry, duplicate-request, and unauthorized paths as appropriate; a success-only test is not sufficient for a boundary change.

Use `npm test` and `npm run typecheck` for verification when requested. For dashboard browser code, also use `npm run build` and the browser TypeScript configuration.

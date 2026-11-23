---
name: soyuz-a2ui-analysis
description: Use when changing the fixed A2UI run operations surface, dashboard rendering, host-loaded data projection, or JEV flow.
---

# Change dashboard A2UI run operations safely

Read `docs/RUN-OPERATIONS.md`, the dashboard sections of `docs/CONTRACT.md`, and the relevant OAuth and Senku configuration in `docs/DEPLOYMENT.md` before changing the run operations surface. For Senku request/response or Service Binding behavior, also follow `soyuz-senku-integration` and read `docs/SENKU-INTEGRATION.md`.

## Trace the flow

- Fixed A2UI template and bounded run summary projection: `dashboard/run-operations.ts`.
- Protocol validation and message limits: `a2ui/protocol.ts`.
- Native DOM renderer for the Basic Catalog subset: `dashboard/a2ui-renderer.ts`.
- Browser orchestration and reusable JEV controls: `dashboard/app.ts`, `dashboard/jev-panel.ts`, and `dashboard/jev-renderer.ts`.
- Server-built JEV evidence and decision flow: `src/jev/analysis.ts`, `src/jev/profiles.ts`, and `src/jev/senku-client.ts`.

## Preserve the execution boundary

- Treat A2UI messages, run records, and event values as untrusted. Bound message size, component count, nesting depth, and item count.
- Validate A2UI v1.0 messages with the official core processor and Soyuz's Basic Catalog, then apply Soyuz's component, binding, and action allowlists before rendering.
- Keep the template application-owned. Fetch run records through fixed, authenticated read routes, project only approved fields, and keep actions host-owned; there is no prompt or runtime model generation.
- Render untrusted values with text nodes. Do not add arbitrary HTML, code, URLs, catalogs, functions, network requests, or actions that mutate run state.
- JEV decisions are explicit user submissions through fixed profile IDs. Keep evidence selection and construction on the server; never let A2UI choose profiles, evidence, or credentials. Refreshes and heartbeats must not trigger assessments.

## Verify changes

Update focused coverage in `tests/a2ui.test.ts`, `tests/run-operations.test.ts`, `tests/a2ui-renderer.test.ts`, `tests/jev-panel.test.ts`, `tests/jev-renderer.test.ts`, `tests/dashboard-api.test.ts`, `tests/api/oauth-dashboard-api.test.ts`, or `tests/jev.test.ts`. Cover rejected protocol messages and actions, untrusted text, unauthorized and rate-limited requests, malformed Senku responses, and proof that assessments leave run state unchanged. The local two-Worker Senku integration test is `npm run test:cross-worker` and requires the documented Senku Wrangler config.

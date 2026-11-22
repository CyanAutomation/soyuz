---
name: soyuz-a2ui-analysis
description: Use when changing Google A2UI generation, the dashboard's A2UI renderer, read-only data hydration, or its JEV flow.
---

# Change dashboard A2UI analysis safely

Read `docs/A2UI-ANALYSIS.md`, the dashboard sections of `docs/CONTRACT.md`, and relevant OAuth and provider configuration in `docs/DEPLOYMENT.md` before changing the analysis flow. For Senku request/response or Service Binding behavior, also follow `soyuz-senku-integration` and read `docs/SENKU-INTEGRATION.md`.

## Trace the flow

- Generation and bounded provider request: `src/a2ui/generation.ts`.
- Protocol validation and message limits: `a2ui/protocol.ts`.
- Native DOM renderer for the Basic Catalog subset: `dashboard/analysis/a2ui-renderer.ts`.
- Browser orchestration and fixed JEV form: `dashboard/analysis/app.ts` and `dashboard/analysis/jev-renderer.ts`.
- Server-built JEV evidence and decision flow: `src/jev/analysis.ts`, `src/jev/profiles.ts`, and `src/jev/senku-client.ts`.

## Preserve the execution boundary

- Treat prompts, A2UI messages, run records, and event values as untrusted. Bound provider input/output, message size, component count, nesting depth, item count, and request duration.
- Validate A2UI v1.0 messages with the official core processor and Soyuz's Basic Catalog, then apply Soyuz's component, binding, and action allowlists before rendering.
- The model never supplies application data. Fetch run records through fixed, authenticated read routes, project only approved fields in the browser, and keep all updates and API writes host-owned.
- Render untrusted values with text nodes. Do not add arbitrary HTML, code, URLs, catalogs, functions, network requests, or actions that mutate run state.
- JEV decisions are explicit user submissions through fixed profile IDs. Keep evidence selection and construction on the server; never let A2UI choose profiles, evidence, or credentials.

## Verify changes

Update focused coverage in `tests/a2ui.test.ts`, `tests/a2ui-generation.test.ts`, `tests/a2ui-renderer.test.ts`, `tests/jev-renderer.test.ts`, `tests/dashboard-api.test.ts`, or `tests/jev.test.ts`. Cover rejected protocol messages and actions, untrusted text, unauthorized and rate-limited requests, malformed provider output, and proof that analysis leaves run state unchanged where relevant. The local two-Worker Senku integration test is `npm run test:cross-worker` and requires the documented Senku Wrangler config.

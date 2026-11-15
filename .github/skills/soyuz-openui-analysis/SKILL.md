---
name: soyuz-openui-analysis
description: Use when changing generated OpenUI analysis, its prompt and component library, browser rendering, read tools, or JEV interaction in the dashboard.
---

# Change dashboard OpenUI analysis safely

Read `docs/OPENUI-ANALYSIS.md`, the dashboard sections of `docs/CONTRACT.md`, and relevant OAuth and provider configuration in `docs/DEPLOYMENT.md` before changing the analysis flow. For Senku request/response or Service Binding behavior, also follow `soyuz-senku-integration` and read `docs/SENKU-INTEGRATION.md`.

## Trace the flow

- Generation and bounded provider request: `src/openui/generation.ts`.
- Core library, component schemas, and prompt: `openui/library.ts`.
- Tool schemas and fixed API mappings: `openui/tools.ts` and `openui/runtime.ts`.
- Parsing and DOM reconciliation: `openui/dom-renderer.ts` and `dashboard/analysis/components.ts`.
- Browser orchestration and approved JEV program: `dashboard/analysis/app.ts`.
- Server-built JEV evidence and decision flow: `src/jev/analysis.ts`, `src/jev/profiles.ts`, and `src/jev/senku-client.ts`.

## Preserve the execution boundary

- Treat generated programs, provider output, run records, and event values as untrusted input. Bound program size, component count, nesting, query count, provider input/output, and response duration.
- Parse and validate the complete program before installing it. Partial streaming output may preview safe headings only; it must not execute queries or actions.
- Components, functions, and read tools are explicit allowlists. Tool names map to fixed authenticated dashboard API paths; reject arbitrary URLs, methods, SQL, JavaScript, HTML, external navigation, and writes.
- Use text nodes for model and run data. Validate structured props, bound rendered data, and dispose event listeners when rendered nodes are removed.
- JEV decisions are explicit user submissions through the fixed app-authored program. Keep JEV out of the model-facing tool list; do not let generated prompts or programs choose evidence, profiles, or credentials.
- Build JEV inputs server-side from the profile's allowlisted run projection. Never send task prompts, repository URLs, raw logs, artifacts, unrestricted event payloads, or generated programs to Senku. Validate Senku responses and return only the documented safe fields.
- Analysis, decisions, and feedback must remain scoped to allowlisted `soyuz:read` OAuth users, rate-limited, non-cacheable as appropriate, and unable to mutate run or worker state.

## Verify behavior

Update focused coverage in `tests/openui.test.ts`, `tests/openui-generation.test.ts`, `tests/dashboard-api.test.ts`, `tests/jev.test.ts`, or `tests/jev-selection.test.ts`. Cover rejected generated inputs and tool arguments, untrusted display values, unauthorized/rate-limited requests, malformed provider responses, and proof that analysis leaves run state unchanged where relevant. The local two-Worker Senku integration test is `npm run test:cross-worker` and requires the documented Senku Wrangler config.

Use `npm test`, `npm run typecheck`, and `npm run build` for verification when requested.

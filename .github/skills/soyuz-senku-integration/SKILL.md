---
name: soyuz-senku-integration
description: Use when changing Soyuz's Senku Service Binding, JEV profile inputs or response validation, machine identity, or integration deployment and rollback.
---

# Change the Senku integration

Read `docs/SENKU-INTEGRATION.md`, `docs/OPENUI-ANALYSIS.md`, and the deployment sections of `docs/DEPLOYMENT.md` before changing the integration. Follow `soyuz-openui-analysis` for browser and generated analysis behavior.

## Locate the integration

- Service Binding and required secret configuration: `wrangler.jsonc` and `src/env.ts`.
- Fixed request, timeout, response-size bound, and response validation: `src/jev/senku-client.ts`.
- Soyuz-side response contracts and profile IDs: `src/jev/response-contracts.ts` and `src/jev/profile-ids.ts`.
- Server-built inputs and decision handling: `src/jev/analysis.ts`; authenticated dashboard dispatch is in `src/auth/oauth-resource.ts`.
- Cross-Worker test: `scripts/senku-cross-worker.test.ts`.

## Preserve identity and data boundaries

- Call Senku only through the `SENKU` Service Binding and fixed internal route. Do not use its public hostname, add a runtime backend selector, shadow request, or automatic provider fallback.
- Keep `SENKU_SOYUZ_API_TOKEN` server-side and configure matching machine identity values on both Workers. Never send it to the browser, include it in request bodies, or log it.
- Keep profile selection and evidence construction server-side. Send only the versioned, bounded input documented for the selected profile; do not include task prompts, repository URLs, logs, artifacts, event payloads, or generated OpenUI programs.
- Validate the response size, schema/profile version, provider metadata, answer keys and types, choices, score ranges, and nullable fields before returning it. Return only the existing safe dashboard response fields.
- Map timeouts, unavailable binding/provider, invalid requests, and malformed responses to documented safe error codes. Do not return or log raw Senku error bodies. A failed decision must not alter run state.

## Validate rollout and rollback

- Update mocked binding tests in `tests/jev.test.ts` and the two-Worker integration test when the wire contract changes. The integration test uses `SENKU_WRANGLER_CONFIG=/absolute/path/to/senku/wrangler.jsonc npm run test:cross-worker` and blocks unrelated outbound HTTP.
- Verify Senku is deployed and ready, the binding target is correct, machine identity matches, and profile authorization works before deploying a Soyuz switchover. The normal Soyuz health check does not exercise the binding.
- After deployment, use the documented bounded assessment on a non-sensitive retained run; confirm the response shape, one provider attempt, logs without sensitive evidence, and unchanged run state. Keep rollback credentials available through the rollback window.
- Run the post-deploy assessment only as described in `docs/SENKU-INTEGRATION.md` and within the task's authorization; it sends a real inference request even though the run itself is unchanged.

Use `npm test`, `npm run typecheck`, and `npm run test:cross-worker` for verification when requested and when the Senku checkout is available.

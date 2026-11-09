# Senku integration

Soyuz sends explicit dashboard JEV assessments to Senku through a Cloudflare Service Binding. Soyuz continues to own dashboard authentication, authorization, run records, rate limiting, and feedback. Senku owns the three Soyuz decision profiles, their questions, and JEV provider inference.

## Binding and machine identity

`wrangler.jsonc` binds `SENKU` to the Worker named `senku`. The request uses the binding's `fetch()` method and an internal URL; it does not call the public `workers.dev` hostname.

Configure `SENKU_SOYUZ_API_TOKEN` as a Soyuz Worker secret and configure the same value as Senku's `SENKU_SOYUZ_API_TOKEN` secret. Do not send the token through the browser, include it in request bodies, or log it. Senku's bearer authentication and profile permission checks remain in force for Service Binding requests.

The integration is a direct switchover. There is no backend selector, shadow request, duplicate inference, or automatic OpenRouter fallback. When Senku is unavailable, Soyuz returns the existing safe JEV error categories and leaves run state unchanged.

## Profile mapping and evidence boundary

| Soyuz profile | Senku profile | Input sent |
| --- | --- | --- |
| `run_operations_triage_v1` | `run_operations_triage_v1` | `{ run: { status, stage, operationalHealth, failureClass, createdAt, queuedAt, startedAt, completedAt, lastHeartbeatAt } }` |
| `kaseki_output_review_v1` | `kaseki_output_review_v1` | `{ canonicalRun: { status, failureClass, exitCode, changedFileCount }, summary }` |
| `kaseki_output_review_v2` | `kaseki_output_review_v2` | `{ canonicalRun: { status, failureClass, exitCode, changedFileCount }, summary }` |

Soyuz wraps each input as `{ "schemaVersion": "1", "input": ... }`. The output-review summary remains bounded to 2,000 characters. Nullable fields are sent as `null`; exit codes are passed through without inventing a value. Missing or unsupported changed-file counts and missing summaries are represented as `null`.

Soyuz does not send raw task prompts, repository URLs, event payloads, validation logs, artifacts, OpenUI programs, or caller-defined questions. Senku constructs the state projection and JEV questions for its profile. Soyuz validates the returned profile ID/version, schema version, provider, model, request ID, duration, attempt count, usage, answer keys, answer types, choice sets, score legends, probability ranges, and nullable confidence. Only `model` and validated `answers` are returned in the existing dashboard success response.

## Timeout and error mapping

Senku's checked-in provider timeout defaults to 15 seconds and accepts values up to 30 seconds. Soyuz allows 35 seconds for the full Service Binding request, leaving five seconds for Senku's response validation and transport. This is longer than the current default and covers Senku's configured maximum; it is not identical to the former 45-second direct OpenRouter timeout.

| Senku condition | Soyuz response |
| --- | --- |
| Missing Soyuz machine token | `JEV_UNAVAILABLE` |
| Missing or unavailable Service Binding | `JEV_PROVIDER_UNAVAILABLE` |
| Senku/provider timeout | `JEV_PROVIDER_TIMEOUT` |
| Malformed, oversized, or incompatible success response | `JEV_RESPONSE_INVALID` |
| Invalid server-built profile input | `JEV_REQUEST_INVALID` |
| Unavailable retained run | Existing Soyuz run/application error |

Raw Senku error bodies are not returned or logged. A rejected or malformed decision does not alter a run.

## Dashboard compatibility and feedback

The browser request remains `POST /dashboard/api/analysis/decisions` with the same approved `profileId` and run UUID. OAuth, allowlist checks, `soyuz:read`, and the existing per-user decision rate limiter remain in the request path. Successful responses retain the current Soyuz shape, `{ data: { model, answers }, requestId }`. The browser renderer and `jev_feedback` schema and endpoints are unchanged.

The unit and API tests use a mocked `SENKU` binding. The two-Worker integration test runs both Wrangler Workers locally, exercises the real binding and Senku bearer authorization, and replaces the outbound OpenRouter call with a synthetic response. Run it from the Soyuz checkout with `SENKU_WRANGLER_CONFIG=/absolute/path/to/senku/wrangler.jsonc npm run test:cross-worker`. It verifies the exact Senku profile projection, one provider attempt, the compatible dashboard response, and unchanged run state. It blocks all other outbound HTTP and requires no Cloudflare secrets or paid inference.

Soyuz's run-management UTCP remains independent. It continues to expose run operations and does not expose Senku decision tools.

## Deployment order and rollback

The Soyuz GitHub Actions workflow deploys successful pushes to `main`. Do not merge this direct switchover until Senku has been deployed and independently verified, the Service Binding target exists in the intended Cloudflare account, both matching machine secrets are configured, and readiness/authentication/profile checks pass. No D1 migration is required for this integration.

After Senku is ready, deploy Soyuz through its existing CI and production preflight. Then run one bounded dashboard assessment against a non-sensitive retained run, verify the unchanged response shape, check Senku and Soyuz logs, confirm exactly one provider attempt, and confirm that no run state changed.

If the integration must be rolled back, use the existing approved Cloudflare version rollback process for Soyuz, or revert and redeploy the previous Soyuz revision that still uses the direct OpenRouter adapter. Keep Soyuz's existing OpenRouter secret through the rollback window. Do not remove the Senku binding or machine credential as part of that code rollback. No runtime flag is provided.

## Operational measurements

The existing `soyuz_jev_decision` log event includes `backend: "senku"`, profile, resolved model when available, duration, outcome, safe error code, provider attempt count, Senku request ID, and usage when supplied. It omits run UUIDs, credentials, evidence, answers, and raw response bodies. Compare decision success and failure rates, latency, provider usage, and Worker CPU from Cloudflare's deployed telemetry. Ratings are feedback, not accuracy labels.

Both Workers must be available in the same Cloudflare account. Cloudflare documents Service Binding calls under the Workers Free internal-service subrequest limits, while its no-additional-request-fee pricing treatment applies to Workers Standard. Senku is planned for Free and its Worker is not present in the account inventory checked for this change, so confirm the deployed request/CPU metrics and applicable limits before release; do not assume Standard billing on Free. See Cloudflare's [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), [Worker-to-Worker limits](https://developers.cloudflare.com/workers/platform/limits/#worker-to-worker-subrequests), and [Service Binding pricing](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings).

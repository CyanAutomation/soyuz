# Senku integration

Soyuz delegates dashboard JEV assessments to a configured Senku service. Soyuz continues to own dashboard authentication, authorization, run records, rate limiting, and feedback. Senku owns the profile questions, profile schemas, and decision response.

## Binding and credential boundary

Configure the Service Binding target in the environment's Worker configuration. A Service Binding request uses an internal synthetic request origin; this guide does not record a deployed hostname or service name.

Configure a dedicated Soyuz client credential through the runtime's secret manager. The corresponding Senku identity must be provisioned with access only to the profiles required by Soyuz. Keep values out of repository settings, logs, test artifacts, and request payloads. Use the deployment system's credential-rotation procedure to overlap old and new values safely.

The client sends an approved profile identifier and the structured input required by that profile. Senku constructs the profile questions and validates provider output. Soyuz does not send raw task prompts, repository URLs, event payloads, validation logs, artifacts, generated UI messages, caller-defined questions, model selections, or provider credentials.

## Profile mapping and evidence boundary

Soyuz supports its configured decision profiles through the Senku REST contract. The static profile identifiers and response shapes are checked against the pinned contract artifact in this repository. Update the artifact and `.senku-contract.sha256` together when reviewing a Senku contract change; CI checks the pinned bytes.

Each Senku request carries a correlation ID and an absolute deadline. Soyuz uses a 35-second outer timeout, reserves response-processing time, and gives Senku at most its 30-second provider timeout. Soyuz makes one HTTP call and does not retry it. Senku may make one additional provider attempt after a qualifying 429, so `attemptCount` can be 1 or 2; the response parser accepts unknown top-level envelope fields and any positive attempt count while checking the fields Soyuz consumes. Nested answer and profile metadata remain strictly validated.

## Timeout and error mapping

The client reserves time for local response validation and transport. Senku and provider failures map to stable Soyuz-facing error categories. A service-level `RATE_LIMITED` response is distinct from the provider's `PROVIDER_RATE_LIMITED` response:

| Senku result | Soyuz result |
| --- | --- |
| Missing credential or binding | JEV unavailable |
| Provider timeout | JEV provider timeout |
| Provider unavailable | JEV provider unavailable |
| Provider rate limited | JEV rate limited, with a bounded retry hint |
| Invalid response | JEV invalid response |

## Dashboard compatibility and feedback

The dashboard continues to use its existing authenticated decision route and approved profile identifier. OAuth, allowlist checks, authorization, and the existing per-user decision limiter remain in the request path. Senku-specific provider details are not exposed to the dashboard user.

## Deployment order and rollback

Deploy only after the target service, binding, identity credential, and profile permissions have been configured and verified. Use synthetic inputs for preflight checks. Keep deployment order, environment-specific hostnames, live status, version identifiers, and rollback records in the approved operations system.

If verification fails, restore the prior consumer configuration through the deployment system and confirm that the previous service path is healthy before resuming traffic.

## Operational measurements

Use the approved monitoring system to review status, duration, resolved model, provider attempts, safe error code, correlation ID, and usage when available. Do not copy live metrics, request content, or service identifiers into this public guide. Review account quotas, provider spending limits, and log sampling before each rollout.

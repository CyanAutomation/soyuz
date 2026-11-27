# Senku integration

Soyuz delegates dashboard JEV assessments to a configured Senku service. Soyuz continues to own dashboard authentication, authorization, run records, rate limiting, and feedback. Senku owns the profile questions, profile schemas, and decision response.

## Binding and credential boundary

Configure the Service Binding target in the environment's Worker configuration. A Service Binding request uses an internal synthetic request origin; this guide does not record a deployed hostname or service name.

Configure a dedicated Soyuz client credential through the runtime's secret manager. The corresponding Senku identity must be provisioned with access only to the profiles required by Soyuz. Keep values out of repository settings, logs, test artifacts, and request payloads. Use the deployment system's credential-rotation procedure to overlap old and new values safely.

The client sends an approved profile identifier and the structured input required by that profile. Senku constructs the profile questions and validates provider output. Soyuz does not send raw task prompts, repository URLs, event payloads, validation logs, artifacts, generated UI messages, caller-defined questions, model selections, or provider credentials.

## Profile mapping and evidence boundary

Soyuz supports its configured decision profiles through the Senku REST contract. The static profile identifiers and response shapes are checked against the pinned contract artifact in this repository.

Each request carries a correlation ID and a bounded deadline. Request bodies and provider work are constrained by the configured budgets. The response parser accepts additive envelope fields while validating the fields Soyuz relies on.

## Timeout and error mapping

The client reserves time for local response validation and transport. Senku and provider failures map to stable Soyuz-facing error categories:

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

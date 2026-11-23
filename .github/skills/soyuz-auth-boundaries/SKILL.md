---
name: soyuz-auth-boundaries
description: Use when changing bearer-token roles, credential rotation, request authorization, origin scoping, OAuth access policy, or authentication error handling.
---

# Change Soyuz authentication boundaries

Read the authentication sections of `docs/ARCHITECTURE.md` and `docs/CONTRACT.md`, plus API token and OAuth configuration in `docs/DEPLOYMENT.md`. For dashboard consent or browser-session changes, also follow `soyuz-dashboard-auth`; for request or response shape changes, follow `soyuz-api-contract`.

## Locate the policy and tests

- Bearer credential matching and role selection: `src/auth/bearer.ts`.
- OAuth policy, resources, and callback flow: `src/auth/oauth-policy.ts`, `src/auth/oauth-resource.ts`, and `src/auth/oauth.ts`.
- Route dispatch and environment bindings: `src/index.ts` and `src/env.ts`.
- Authentication tests: `tests/http-auth.test.ts`, `tests/oauth.test.ts`, and the relevant cases in `tests/api/runs-api.test.ts`, `tests/api/oauth-dashboard-api.test.ts`, and `tests/dashboard-api.test.ts`.

## Keep credentials and principals separate

- `CLIENT_API_TOKEN` authorizes client and UTCP operations. Worker routes require `WORKER_API_TOKEN`. Kaseki submissions require the separately scoped `KASEKI_SUBMISSION_API_TOKEN`. Never accept one role's credential on another role's routes.
- Derive run origin and authorization from the matched credential, never from request fields. Preserve origin checks for reads, retry, cancellation, and idempotency replay.
- Keep credentials in the existing secret manager and server-side bindings. Do not expose secrets in responses, UTCP discovery, browser code, command output, logs, or committed files.
- Preserve the bounded previous-token rotation window and expiry behavior documented in `docs/DEPLOYMENT.md`. Do not log token values or extend the overlap silently.
- Dashboard OAuth requires the explicit numeric GitHub user-ID allowlist and `soyuz:read`. Preserve PKCE, same-origin consent submission, transaction-cookie binding, the minimal `read:user` scope, and the rule that GitHub access tokens are not retained.
- Return documented safe errors for missing or invalid credentials. Keep public discovery limited to schemas and placeholders, and preserve rate limits and non-cacheable authenticated responses.

## Verify the boundary

Cover missing, wrong-role, expired-previous, and rotated credentials, plus allowlist denial and malformed OAuth flows where affected. Verify both permitted and rejected principals; a success-only test does not establish the boundary. Use `npm test` and `npm run typecheck` when requested. Do not use real production credentials for tests.

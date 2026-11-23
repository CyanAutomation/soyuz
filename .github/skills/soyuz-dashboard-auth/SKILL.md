---
name: soyuz-dashboard-auth
description: Use when changing the private run dashboard, its GitHub OAuth flow, dashboard API, consent handling, or browser authentication state.
---

# Change the private dashboard and OAuth flow

Read the dashboard and OAuth sections in `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, and `docs/CONTRACT.md`. Run and worker lifecycle operations are unavailable from the dashboard. Its JEV decision and feedback endpoints are authenticated POSTs that do not create or mutate runs. For cross-cutting credential roles, rotation, or origin authorization, also follow `soyuz-auth-boundaries`. For run operations and rendering boundaries, read `docs/RUN-OPERATIONS.md` and follow `soyuz-a2ui-analysis` and `soyuz-senku-integration`.

## Find the implementation

- Browser UI: `dashboard/` and `public/dashboard/`.
- Fixed A2UI run operations UI and runtime: `dashboard/run-operations.ts`, `dashboard/a2ui-renderer.ts`, `a2ui/`, and `src/jev/`.
- Dashboard data and OAuth routes: `src/auth/oauth.ts`, `src/auth/oauth-policy.ts`, `src/auth/oauth-resource.ts`, and the dispatch in `src/index.ts`.
- Private API projections and artifacts: `src/api/` and the OAuth provider configuration.
- Browser and auth coverage: `tests/oauth.test.ts`, `tests/dashboard-api.test.ts`, `tests/dashboard-ui.test.ts`, `tests/a2ui.test.ts`, `tests/run-operations.test.ts`, `tests/a2ui-renderer.test.ts`, `tests/jev-panel.test.ts`, `tests/jev.test.ts`, and `tests/api.test.ts`.

## Preserve security and product boundaries

- Do not add run creation, retry, cancellation, or worker lifecycle operations to the dashboard. Keep generation, decision, and feedback POST routes limited to the documented authenticated, allowlisted, rate-limited purposes; see `docs/CONTRACT.md`.
- Access requires the explicit numeric GitHub user-ID allowlist. Preserve the `read:user`-only GitHub scope and do not retain GitHub access tokens.
- Keep OAuth resource binding, PKCE, same-origin consent submission, transaction-cookie binding, and allowlist checks intact. Escape registered client metadata rendered in consent UI.
- Dashboard API results must not include worker identity, claim lease fields, credentials, arbitrary internal database fields, raw logs, or unbounded payloads.
- Keep HTML and sensitive responses non-cacheable. Preserve the restrictive CSP, framing protection, `no-referrer`, and MIME-sniffing protections applied to dashboard assets.
- Artifact downloads must remain authenticated and streamed as attachments; do not make the R2 bucket or artifact objects public.

Update deployment documentation if OAuth configuration or required bindings change. Cover signed-out, busy, signed-in, denied, expired, and malformed-input paths in focused tests where relevant. For shared visual patterns, follow `soyuz-dashboard-ui`. Use `npm run typecheck` and `npm run build` for verification when requested.

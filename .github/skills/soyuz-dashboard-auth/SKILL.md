---
name: soyuz-dashboard-auth
description: Use when changing the private run dashboard, its GitHub OAuth flow, dashboard API, consent handling, or browser authentication state.
---

# Change the private dashboard and OAuth flow

Read the dashboard and OAuth sections in `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, and `docs/CONTRACT.md`. This dashboard is a private, read-only view of Soyuz run data; it is not an operator control surface for execution.

## Find the implementation

- Browser UI: `dashboard/` and `public/dashboard/`.
- Dashboard data and OAuth routes: `src/auth/oauth.ts`, `src/auth/oauth-policy.ts`, `src/auth/oauth-resource.ts`, and the dispatch in `src/index.ts`.
- Private API projections and artifacts: `src/api/` and the OAuth provider configuration.
- Browser and auth coverage: `tests/oauth.test.ts`, `tests/dashboard-api.test.ts`, and `tests/api.test.ts`.

## Preserve security and product boundaries

- The dashboard is read-only. Do not add run creation, retry, cancellation, or worker lifecycle operations to it.
- Access requires the explicit numeric GitHub user-ID allowlist. Preserve the `read:user`-only GitHub scope and do not retain GitHub access tokens.
- Keep OAuth resource binding, PKCE, same-origin consent submission, transaction-cookie binding, and allowlist checks intact. Escape registered client metadata rendered in consent UI.
- Dashboard API results must not include worker identity, claim lease fields, credentials, arbitrary internal database fields, raw logs, or unbounded payloads.
- Keep HTML and sensitive responses non-cacheable. Preserve the restrictive CSP, framing protection, `no-referrer`, and MIME-sniffing protections applied to dashboard assets.
- Artifact downloads must remain authenticated and streamed as attachments; do not make the R2 bucket or artifact objects public.

Update deployment documentation if OAuth configuration or required bindings change. Cover signed-out, busy, signed-in, denied, expired, and malformed-input paths in focused tests where relevant. Use `npm run typecheck` and `npm run build` for verification when requested.

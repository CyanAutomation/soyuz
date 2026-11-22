# Soyuz repository skills

Use the skill whose trigger matches the changed behavior. Follow linked companion skills when a change crosses a boundary.

| Skill | Use it for | Common companion |
| --- | --- | --- |
| `soyuz-api-contract` | REST, UTCP, Queue, callback, or public projection shape changes | `soyuz-worker-lifecycle`, `soyuz-kaseki-integration`, `soyuz-openui-analysis` |
| `soyuz-artifacts-retention` | Artifact upload/download, R2, expiry, or deletion outbox changes | `soyuz-d1-schema`, `soyuz-worker-lifecycle` |
| `soyuz-auth-boundaries` | Bearer credentials, token rotation, origin authorization, or OAuth policy changes | `soyuz-dashboard-auth`, `soyuz-api-contract` |
| `soyuz-cloudflare-release` | GitHub Actions, Wrangler, deployment, or release-gate changes | `soyuz-production-operations`, `soyuz-senku-integration` |
| `soyuz-d1-schema` | D1 migrations, persisted run data, migration checks, or retention schema | `soyuz-artifacts-retention`, `soyuz-worker-lifecycle` |
| `soyuz-dashboard-auth` | Dashboard GitHub OAuth, consent, browser session, or dashboard API access | `soyuz-auth-boundaries`, `soyuz-openui-analysis` |
| `soyuz-dashboard-ui` | Dashboard layout, components, styles, or interaction accessibility | `soyuz-dashboard-auth`, `soyuz-openui-analysis` |
| `soyuz-kaseki-integration` | Soyuz/Kaseki handoff, Queue consumption, callback protocol, or rollout compatibility | `soyuz-worker-lifecycle`, `soyuz-api-contract`, `soyuz-d1-schema` |
| `soyuz-openui-analysis` | Generated analysis, read tools, rendering, or JEV flow | `soyuz-dashboard-auth`, `soyuz-senku-integration` |
| `soyuz-production-operations` | Production checks, smoke submissions, migrations, or recovery | `soyuz-cloudflare-release`, `soyuz-kaseki-integration`, `soyuz-senku-integration` |
| `soyuz-senku-integration` | Senku binding, JEV profile contract, machine identity, or provider rollout | `soyuz-openui-analysis`, `soyuz-cloudflare-release` |
| `soyuz-worker-lifecycle` | Run transitions, claims, callbacks, cancellation races, or stale-run recovery | `soyuz-api-contract`, `soyuz-kaseki-integration`, `soyuz-d1-schema` |

Soyuz-specific skills live under `.github/skills/`. The separately vendored `modern-web-guidance` skill lives under `.agents/skills/modern-web-guidance/`; its local references are in that directory's `guides/` folder. These locations may be discovered by different agent hosts, so confirm the consuming host loads the intended location before relying on automatic skill selection.

Run `npm run skills:check` to verify backticked repository paths referenced by Markdown under `.github/skills/`.

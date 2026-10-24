---
name: soyuz-cloudflare-release
description: Use when changing Soyuz's GitHub Actions workflow, Wrangler configuration, Cloudflare release process, or production deployment checks.
---

# Change or operate the Soyuz release path

Read `.github/workflows/ci.yml`, `wrangler.jsonc`, and the GitHub Actions and production sections of `docs/DEPLOYMENT.md` before editing release behavior.

## Understand the current pipeline

- Pull requests run dependency review, migration impact checks, workflow lint/security scans, type checking, tests, dashboard build, and a Wrangler deployment dry run.
- A push to `main` builds and uploads a short-lived Worker artifact. The deploy job downloads and deploys that validated artifact instead of rebuilding it.
- Before deployment, the production D1 preflight checks the configured database identity and applied migration names with a D1 read-only token.
- Production D1 migrations are a separate manual operation. CI deploy credentials must not receive D1 Edit access, and deployment must not bypass the preflight.
- The deployed Worker health check verifies required D1 schema as well as connectivity.

## Keep workflow changes constrained

- Retain least-privilege job permissions, production environment scoping, serialization of production jobs, and `persist-credentials: false` on checkout steps.
- Pin GitHub Actions to reviewed commit SHAs with version comments. Keep actionlint and zizmor checks in the validation job when adding or changing workflow files.
- Keep D1 migration preflight read-only. Never add a production migration command to CI or grant its tokens D1 Edit.
- Do not place Cloudflare or Worker secrets in files, workflow output, shell arguments, or logs. Use the existing secret manager and GitHub environment secrets described in the deployment guide.
- Treat `npm run deploy` as a real Cloudflare deployment. Use `wrangler deploy --dry-run` to validate a bundle; do not deploy unless the task explicitly calls for a deployment.

## Smoke checks

`npm run soyuz:smoke` defaults to read-only health, run, and Queue checks. Passing `--run` submits executable work that an enabled Kaseki host can consume; follow the explicit authorization and disposable-repository procedure in `docs/DEPLOYMENT.md` before using it. Do not turn a deployment check into an unapproved production run.

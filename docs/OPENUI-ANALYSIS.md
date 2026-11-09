# OpenUI run analysis

Soyuz's optional `/dashboard/analysis/` page turns a natural-language question into an interactive, read-only view of retained run data. It uses the official `@openuidev/lang-core` package for OpenUI Lang definitions, system prompts, parsing, streaming, expressions, state, query management, and statement merging. The browser presentation uses native TypeScript and DOM APIs; no UI framework or OpenUI framework renderer is included.

## Request and rendering flow

1. The page signs in through Soyuz's existing GitHub OAuth flow, requests only `soyuz:read`, and checks the same GitHub numeric-ID allowlist as the run dashboard.
2. It sends the user's question to `POST /dashboard/api/analysis/generate`. That narrowly allowed authenticated POST asks a configured OpenAI-compatible chat-completions endpoint for OpenUI Lang. The Worker keeps the provider credential server-side and relays bounded server-sent events.
3. The browser uses Core's `createStreamingParser()` to inspect partial output. It may preview safe headings during a new generation, but it does not run queries or actions from the partial output. It parses and validates the complete program before installing it.
4. Core's store, expression evaluator, and query manager resolve the generated view. The query adapter permits only bounded `list_runs`, `get_run`, `get_run_events`, and `get_run_artifacts` requests to the existing OAuth-protected dashboard APIs.
5. `OpenUIDOMRenderer` maps validated Core `ElementNode`s to registered native renderers. Its small reconciliation layer reuses stable statement IDs, preserves focusable controls where possible, and disposes listeners when nodes are removed.

JEV decisions use the existing `POST /dashboard/api/analysis/decisions` endpoint. The page calls it only after the user submits the explicit JEV form; its profile and run UUID are fixed in an app-authored OpenUI program. Selecting a run in the generated table fills the run UUID and suggests Kaseki outcome review for completed runs or operational triage otherwise. JEV is never exposed to the prompt-generated OpenUI program.

The OpenUI generation model receives the question and valid current program for an edit, not run records. Run data is loaded afterward through the approved browser queries. Soyuz sends Senku only the bounded, server-built input for the selected profile. Stored values remain untrusted display data and cannot change the OAuth identity, machine credential, profile, or action policy.

## Component and tool registration

`openui/library.ts` defines the Zod schemas, Core components, pure functions, actions, component library, and system prompt from the library specification. The initial components are `Stack`, `Heading`, `Text`, `MetricCard`, `RunTable`, `StatusChart`, `EventTimeline`, `Notice`, and `ActionButton`. The prompt is generated from that same specification so its descriptions and schemas stay aligned.

The approved JEV display components are `DecisionSummary`, `ChoiceProbabilities`, `ScoreScale`, and `ConfidenceDisplay`. They render normalized answer data with text and native progress elements. To add a component, define it with `defineComponent()` in `openui/library.ts`, add its ref to the `Stack` child schema, then add a native renderer in `dashboard/analysis/components.ts`. The renderer must use text nodes for model content, validate structured props, keep limits bounded, and clean up any listeners through the provided context. Use stable statement IDs when building generated programs so the renderer can reconcile a component across updates.

Approved tool definitions and Zod input/output schemas live in `openui/tools.ts`. `openui/runtime.ts` maps each explicit tool name to a fixed API path; it does not accept URLs or arbitrary tool names from the model. To add a read tool, add its bounded schemas and prompt metadata, add a fixed mapping to an existing authenticated read endpoint, and cover both the positive request and rejected inputs in tests. Never route write operations through this adapter.

## Senku decision client and profile mapping

`src/jev/senku-client.ts` calls Senku through the `SENKU` Service Binding using the dedicated `SENKU_SOYUZ_API_TOKEN` Worker secret. The client sends one versioned profile envelope to the fixed Senku route, bounds the response to 64 KiB, validates the profile version and answer shapes, and returns only the resolved model and validated answers. It does not call the public Senku URL or fall back to direct provider inference.

`src/jev/profiles.ts` contains only local response contracts for the three existing profile identifiers. Senku owns the question wording, criteria, and profile input validation. `run_operations_triage_v1` receives a `{ run: ... }` projection containing only operational status, stage, health, failure class, and timestamps. `kaseki_output_review_v1` and `kaseki_output_review_v2` receive `{ canonicalRun, summary }`; the summary is capped at 2,000 characters, and canonical exit codes are passed through only when present and supported. Missing changed-file counts and summaries are represented as `null`. No request includes the task prompt, repository URL, artifacts, event payloads, validation logs, or generated OpenUI program. The browser cannot supply questions, evidence, or the machine credential.

`jev_decisions` is defined for the shared OpenUI runtime but excluded from the model-facing tool list. The parser allows it only when the analysis page validates its own fixed JEV program. Its query must have fixed arguments, no reactive state dependencies, and no automatic refresh. Normal generated OpenUI programs cannot invoke it. Selecting a completed run suggests the v2 outcome review; failed, admission-failed, and suspect-stalled runs suggest operational triage. These are suggestions only: the user must submit each assessment. Healthy or in-progress runs do not automatically trigger a model call. The endpoints require the existing allowlisted OAuth `soyuz:read` access and share a limit of five JEV decisions and feedback requests per GitHub user per minute.

JEV is advisory. The page displays probabilities and confidence when supplied and tells the user to check the underlying run record. No JEV answer triggers an action or changes Soyuz/Kaseki state. A person must confirm consequential decisions independently.

Another vanilla TypeScript application can reuse `OpenUIDOMRenderer` with its own Core `Library`, component renderer map, store, query manager, and validated action dispatcher. Soyuz's components, data schemas, OAuth calls, and read-only tool adapter stay application-specific; this repository does not publish a shared npm package.

## Local and provider configuration

The checked-in `.dev.vars.example` enables a deterministic fixture with `OPENUI_DEMO_MODE=true`. The fixture is useful for checking parsing and the interface without an inference service. Signing in to the page still requires the existing local GitHub OAuth credentials, KV binding, and allowlist. For real OpenUI generation, set `OPENUI_PROVIDER_URL`, `OPENUI_PROVIDER_API_KEY`, and `OPENUI_MODEL` in `.dev.vars`; the URL must be a full HTTPS OpenAI-compatible chat-completions endpoint. The Cloudflare AI Gateway OpenAI-compatible endpoint can be used. For local JEV calls, configure the Soyuz Service Binding and set `SENKU_SOYUZ_API_TOKEN` to the same local-only value as Senku's Soyuz identity token. The machine credential is read only by the Worker and is never sent to the browser. The provider key and model alias belong to Senku, not Soyuz.

For deployment, configure `OPENUI_PROVIDER_URL` and `OPENUI_MODEL` as Worker variables, and set the credential with `npx wrangler secret put OPENUI_PROVIDER_API_KEY`. Configure `SENKU_SOYUZ_API_TOKEN` as a Soyuz Worker secret and bind `SENKU` to the Worker named `senku`. Senku must be deployed and ready before deploying the Soyuz switchover. `OPENUI_DEMO_MODE` is an explicit local/testing opt-in and should not be enabled in production.

Core's package documentation describes pseudonymous installation telemetry during `postinstall`; its runtime telemetry is opt-in, and browser/Worker runtimes do not send runtime telemetry. The CI workflow sets the supported `OPENUI_TELEMETRY_DISABLED=1` opt-out for package installation. Local contributors can use the same variable when installing dependencies if they prefer to suppress installation telemetry.

## Security and limits

- The analysis page uses the existing GitHub OAuth allowlist and `soyuz:read` scope.
- The OpenUI generation, JEV decision, and JEV feedback endpoints are the only POST exceptions under `/dashboard/api/**`. They require the allowlisted `soyuz:read` scope, use per-user rate limits, and cannot create, cancel, retry, or otherwise change runs.
- Provider credentials remain in Worker configuration. The access token stays in page memory and is sent only to Soyuz's same-origin APIs.
- Components and actions are explicit allowlists. Core mutations, arbitrary HTTP/SQL, generated JavaScript/HTML, and external navigation are unsupported.
- Query schemas cap run pages at 30, event pages at 50, and each program at four queries. Run history remains subject to Soyuz's newest-30 retention policy.
- JEV state is assembled server-side from allowlisted fields. Its decisions, probabilities, and confidence are transient advisory output; they are not persisted or used to authorize actions.
- JEV emits structured operational metadata logs with backend, profile, model, duration, attempt count, outcome, safe error code, Senku request ID, and returned provider usage where available. Logs omit run IDs, credentials, evidence, answers, and raw response bodies. Users may rate an assessment; Soyuz stores only the run ID, profile, allowlisted GitHub user ID, rating, and timestamps in `jev_feedback`, never the model answer. Ratings can be updated by the same user for the same run and profile.
- To review response usefulness, query the stored unique ratings by profile and rating: `SELECT profile_id, rating, COUNT(*) AS responses FROM jev_feedback GROUP BY profile_id, rating ORDER BY profile_id, rating;`. Combine those counts with `soyuz_jev_decision` logs for call volume, latency, model, outcome, attempts, and safe failure category; check Senku's configured provider usage source for spend. Ratings are directional feedback, not ground-truth accuracy labels.
- Programs are limited to 32,000 characters, 100 rendered components, and eight render levels. Provider input, output, duration, and response bodies are bounded.
- Metrics derive from returned timestamps, statuses, or approved Core/custom functions. Soyuz does not expose token costs or stage durations unless they are actually present in recorded data.
- Generated programs and query state are held in page memory, not persisted to D1 or shared between users. Edits use Core's `mergeStatements()` and the full merged program is revalidated before it is applied.

Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:unit` to verify the Worker, dashboard bundle, and deterministic OpenUI tests.

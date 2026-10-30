# OpenUI run analysis

Soyuz's optional `/dashboard/analysis/` page turns a natural-language question into an interactive, read-only view of retained run data. It uses the official `@openuidev/lang-core` package for OpenUI Lang definitions, system prompts, parsing, streaming, expressions, state, query management, and statement merging. The browser presentation uses native TypeScript and DOM APIs; no UI framework or OpenUI framework renderer is included.

## Request and rendering flow

1. The page signs in through Soyuz's existing GitHub OAuth flow, requests only `soyuz:read`, and checks the same GitHub numeric-ID allowlist as the run dashboard.
2. It sends the user's question to `POST /dashboard/api/analysis/generate`. That narrowly allowed authenticated POST asks a configured OpenAI-compatible chat-completions endpoint for OpenUI Lang. The Worker keeps the provider credential server-side and relays bounded server-sent events.
3. The browser uses Core's `createStreamingParser()` to inspect partial output. It may preview safe headings during a new generation, but it does not run queries or actions from the partial output. It parses and validates the complete program before installing it.
4. Core's store, expression evaluator, and query manager resolve the generated view. The query adapter permits only bounded `list_runs`, `get_run`, `get_run_events`, and `get_run_artifacts` requests to the existing OAuth-protected dashboard APIs.
5. `OpenUIDOMRenderer` maps validated Core `ElementNode`s to registered native renderers. Its small reconciliation layer reuses stable statement IDs, preserves focusable controls where possible, and disposes listeners when nodes are removed.

JEV decisions use a separate `POST /dashboard/api/analysis/decisions` adapter because the OpenRouter decisions API returns typed JSON answers, not OpenUI Lang. The page calls it only after the user submits the explicit JEV form; its profile and run UUID are fixed in an app-authored OpenUI program. JEV is never exposed to the prompt-generated OpenUI program.

The OpenUI generation model receives the question and valid current program for an edit, not run records. Run data is loaded afterward through the approved browser queries. The separate JEV provider receives only the bounded state projection for the selected server-owned profile. Stored values remain untrusted display data and cannot change the OAuth identity, provider configuration, query allowlist, or action policy.

## Component and tool registration

`openui/library.ts` defines the Zod schemas, Core components, pure functions, actions, component library, and system prompt from the library specification. The initial components are `Stack`, `Heading`, `Text`, `MetricCard`, `RunTable`, `StatusChart`, `EventTimeline`, `Notice`, and `ActionButton`. The prompt is generated from that same specification so its descriptions and schemas stay aligned.

The approved JEV display components are `DecisionSummary`, `ChoiceProbabilities`, `ScoreScale`, and `ConfidenceDisplay`. They render normalized answer data with text and native progress elements. To add a component, define it with `defineComponent()` in `openui/library.ts`, add its ref to the `Stack` child schema, then add a native renderer in `dashboard/analysis/components.ts`. The renderer must use text nodes for model content, validate structured props, keep limits bounded, and clean up any listeners through the provided context. Use stable statement IDs when building generated programs so the renderer can reconcile a component across updates.

Approved tool definitions and Zod input/output schemas live in `openui/tools.ts`. `openui/runtime.ts` maps each explicit tool name to a fixed API path; it does not accept URLs or arbitrary tool names from the model. To add a read tool, add its bounded schemas and prompt metadata, add a fixed mapping to an existing authenticated read endpoint, and cover both the positive request and rejected inputs in tests. Never route write operations through this adapter.

## JEV decision adapter and reusable primitive

`src/jev/decision.ts` exports `runJevDecision(env, { state, questions }, fetcher?)`, a reusable server-side primitive for any Soyuz feature that needs typed JEV answers. Each caller must build a small server-owned state projection and define its question map in code. The primitive sends a bounded request to OpenRouter's fixed `/api/alpha/decisions` endpoint using `OPENROUTER_API_KEY` and `JEV_MODEL`, then validates answer keys, answer types, choice sets, probability ranges and totals, score ranges, and score legends. It normalizes NouL answers into true/false probabilities and returns only the model and validated answers. It does not log or persist provider responses.

`src/jev/profiles.ts` currently defines two versioned profiles: `run_operations_triage_v1` receives operational run metadata only; `kaseki_output_review_v1` receives canonical run status and exit code, a changed-file count, and at most 2,000 characters of the recorded Kaseki summary. The summary is explicitly marked as untrusted data. Neither profile sends the task prompt, repository URL, artifact contents, event logs, or generated OpenUI program to JEV. The browser carries display labels and answer keys only; it does not contain the server question instructions or criteria. Add future uses as separate profiles or server call sites with similarly narrow projections; do not accept arbitrary questions or state from the browser.

`jev_decisions` is defined for the shared OpenUI runtime but excluded from the model-facing tool list. The parser allows it only when the analysis page validates its own fixed JEV program. Its query must have fixed arguments, no reactive state dependencies, and no automatic refresh. Normal generated OpenUI programs cannot invoke it. The endpoint requires the existing allowlisted OAuth `soyuz:read` access and has a separate limit of five decisions per GitHub user per minute.

JEV is advisory. The page displays probabilities and confidence when supplied and tells the user to check the underlying run record. No JEV answer triggers an action or changes Soyuz/Kaseki state. A person must confirm consequential decisions independently.

Another vanilla TypeScript application can reuse `OpenUIDOMRenderer` with its own Core `Library`, component renderer map, store, query manager, and validated action dispatcher. Soyuz's components, data schemas, OAuth calls, and read-only tool adapter stay application-specific; this repository does not publish a shared npm package.

## Local and provider configuration

The checked-in `.dev.vars.example` enables a deterministic fixture with `OPENUI_DEMO_MODE=true`. The fixture is useful for checking parsing and the interface without an inference service. Signing in to the page still requires the existing local GitHub OAuth credentials, KV binding, and allowlist. For real OpenUI generation, set `OPENUI_PROVIDER_URL`, `OPENUI_PROVIDER_API_KEY`, and `OPENUI_MODEL` in `.dev.vars`; the URL must be a full HTTPS OpenAI-compatible chat-completions endpoint. The Cloudflare AI Gateway OpenAI-compatible endpoint can be used. For local JEV calls, set `OPENROUTER_API_KEY` and optionally `JEV_MODEL` (default `~typesafe/jev-latest`). These are separate providers and credentials: JEV does not use the OpenUI chat-completions adapter. Secrets are read only by the Worker and are never sent to the browser.

For deployment, configure `OPENUI_PROVIDER_URL` and `OPENUI_MODEL` as Worker variables, and set the credential with `npx wrangler secret put OPENUI_PROVIDER_API_KEY`. `JEV_MODEL` is a Worker variable and `OPENROUTER_API_KEY` is a separate Worker secret; if the secret is not already configured, set it with `npx wrangler secret put OPENROUTER_API_KEY`. The existing OpenRouter key can serve this feature and other server-side JEV uses. Each adapter returns a clear unavailable response when its provider is not configured. `OPENUI_DEMO_MODE` is an explicit local/testing opt-in and should not be enabled in production.

Core's package documentation describes pseudonymous installation telemetry during `postinstall`; its runtime telemetry is opt-in, and browser/Worker runtimes do not send runtime telemetry. The CI workflow sets the supported `OPENUI_TELEMETRY_DISABLED=1` opt-out for package installation. Local contributors can use the same variable when installing dependencies if they prefer to suppress installation telemetry.

## Security and limits

- The analysis page uses the existing GitHub OAuth allowlist and `soyuz:read`; it does not request `soyuz:write`.
- The OpenUI generation and JEV decision endpoints are the only POST exceptions under `/dashboard/api/**`. Both require the allowlisted `soyuz:read` scope, have separate per-user rate limits, and cannot create, cancel, retry, or otherwise change runs.
- Provider credentials remain in Worker configuration. The access token stays in page memory and is sent only to Soyuz's same-origin APIs.
- Components and actions are explicit allowlists. Core mutations, arbitrary HTTP/SQL, generated JavaScript/HTML, and external navigation are unsupported.
- Query schemas cap run pages at 30, event pages at 50, and each program at four queries. Run history remains subject to Soyuz's newest-30 retention policy.
- JEV state is assembled server-side from allowlisted fields. Its decisions, probabilities, and confidence are transient advisory output; they are not persisted or used to authorize actions.
- Programs are limited to 32,000 characters, 100 rendered components, and eight render levels. Provider input, output, duration, and response bodies are bounded.
- Metrics derive from returned timestamps, statuses, or approved Core/custom functions. Soyuz does not expose token costs or stage durations unless they are actually present in recorded data.
- Generated programs and query state are held in page memory, not persisted to D1 or shared between users. Edits use Core's `mergeStatements()` and the full merged program is revalidated before it is applied.

Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:unit` to verify the Worker, dashboard bundle, and deterministic OpenUI tests.

# A2UI run analysis

The optional `/dashboard/analysis/` page turns a natural-language question into a generated, read-only view over retained Soyuz run data. It uses Google's A2UI v1.0 protocol and the official `@a2ui/web_core` package with the Basic Catalog. Soyuz renders the approved component subset with native TypeScript and DOM APIs.

## Request and rendering flow

1. The browser signs in through the existing GitHub OAuth flow and receives an in-memory `soyuz:read` token.
2. The user submits a question to `POST /dashboard/api/analysis/generate`. The Worker sends the prompt and protocol instructions to the configured server-side model provider; it does not send run records.
3. The provider returns A2UI JSONL. The Worker validates each message against the official v1.0 schema and core processor, then enforces Soyuz's catalog, component, binding, action, size, and topology limits.
4. The Worker emits validated messages as `a2ui` server-sent events and ends with `done`. A malformed or incomplete response ends with `error`; the browser validates the complete surface before installing it.
5. The browser loads run summaries and selected-run details from fixed authenticated read routes. It projects only bounded fields into its local A2UI data model. The model provider never receives that data.
6. The native renderer supports `Column`, `Row`, `Card`, `Text`, `Button`, `Divider`, and `List`. It renders model and run values with `textContent`; event lists stay inside a native collapsed disclosure.

The generation body is `{ "prompt": "...", "mode": "generate" | "edit", "existingSurface"?: "..." }`. Edits must include the current validated A2UI messages and may only update that surface. The response stream carries complete A2UI messages, not provider token deltas.

## Protocol and action boundary

`a2ui/protocol.ts` validates v1.0 messages with the official `MessageProcessor` and `STRICT_VALIDATION` from Google's core package. The schema-only Basic Catalog document at `a2ui/basic-catalog-v1.json` is the published A2UI v1.0 catalog shipped with `@a2ui/web_core@0.15.0`; its adjacent license is retained. This avoids importing the package's Lit web-component renderer into the Worker. Refresh the snapshot when updating the pinned core package. The surface must use the Basic Catalog ID and a single connected root. The model cannot supply a data model, update data, delete a surface, invoke functions, add catalogs, render arbitrary components, or select arbitrary bindings.

Supported UI actions are limited to selecting a run already loaded by the browser, refreshing the fixed run list, resetting host filters, and navigating to the analysis page. Run creation, cancellation, retry, feedback, and JEV are not available through A2UI actions. All server writes remain host-owned and separately authenticated.

The browser reads at most 30 run summaries, 50 events for a selected run, and 100 artifact metadata records. It uses fixed dashboard API routes, validates UUIDs before building paths, bounds displayed fields, and never fetches artifact contents from a generated message. Status filters, sorting, and refresh are native labelled controls outside the generated surface.

## JEV decision support

JEV decisions use `POST /dashboard/api/analysis/decisions`. The user must submit the native form with one of the fixed profiles and a retained run UUID. Selecting a run can suggest a profile based on its status, but never submits an assessment automatically. Soyuz constructs the profile-specific evidence on the server and calls Senku through the existing Service Binding. The fixed JEV renderer uses text nodes and native progress meters; A2UI cannot invoke JEV or choose its evidence, profile, or credential.

Decision and feedback requests share the existing per-user limit of five per minute. Feedback stores only the user's rating, not the answer or input. See [Senku integration](SENKU-INTEGRATION.md) for the profile contract and deployment order.

## Configuration

The checked-in `.dev.vars.example` enables a deterministic local fixture with `ANALYSIS_DEMO_MODE=true`. For live generation, configure `ANALYSIS_PROVIDER_URL`, `ANALYSIS_PROVIDER_API_KEY`, and `ANALYSIS_MODEL`. The URL must be a full HTTPS OpenAI-compatible chat-completions endpoint. The key is a Worker secret and is never sent to the browser. Any configured model provider must be instructed and able to emit A2UI v1.0 JSONL; the protocol itself is provider independent.

The generation endpoint requires the allowlisted OAuth `soyuz:read` scope and the per-user generation limit of five requests per minute. It fails closed when its Cloudflare rate limiter is unavailable. Generation, JEV decisions, and JEV feedback are the only POST exceptions under `/dashboard/api/**`; none can mutate run state.

## Verification

The protocol tests cover schema, catalog, component, action, binding, topology, and size rejection. Generation tests cover local fixtures, server-side provider credentials, malformed provider output, edit messages, and unavailable providers. Renderer tests cover data binding, fixed actions, and text-safe display. Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:unit` to verify the Worker, dashboard bundle, and analysis flow.

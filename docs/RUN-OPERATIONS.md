# Run operations workspace

Soyuz presents run health, execution, outcomes, publication, and JEV decision support on the authenticated `/dashboard/` page. The workspace is application-owned: A2UI v1.0 templates are checked into Soyuz and bind only to bounded data loaded by the authenticated dashboard. There is no prompt box, runtime surface generation, or model access to run records.

## Overview and refresh

The run operations view groups the 30 most recent retained runs into attention, active, completed, and publication sections. Search, status filtering, and sorting apply only to those 30 runs; outcome aggregates continue to cover all unexpired runs. Host rules classify failed and admission-failed runs, as well as active runs with `suspect_stalled` health, as needing attention. The existing run cards remain the source for detailed event history, artifacts, failure detail, and result information.

Summaries include status, stage, run age, queue and execution durations, heartbeat age, a bounded outcome summary, and publication status. Missing measurements display as unknown; a measured duration of zero remains zero. Publication is a separate lifecycle from execution, so a completed run can have a pending or retryable publication. The dashboard API reads only the publication status columns needed for this view. Manifest content, R2 keys, provider internals, repository details, and raw errors are excluded from the A2UI data model. If the publication ledger is unavailable, run history remains usable and the view reports publication status as unavailable.

The browser refreshes run data every 60 minutes, when a hidden tab becomes visible, and when the user presses **Refresh runs**. Refresh updates host bindings against the fixed template; it does not call a model or change run state. The Worker lifecycle and retention cron remains independent and continues its minutely reconciliation work.

## JEV decision support

Fixed host rules suggest `run_operations_triage_v1` for failed, admission-failed, or suspect-stalled runs, and `kaseki_output_review_v2` for completed runs with output to review. Healthy active runs do not suggest an assessment. The run card offers an explicit one-click request; refreshes and heartbeats never invoke JEV automatically.

Soyuz builds the bounded profile input and sends it to Senku over the Service Binding. Responses are validated and shown as advisory information. The user can submit a helpful/not-helpful rating. Assessment answers and inputs are transient in the browser session; Soyuz persists ratings only. See [Senku integration](SENKU-INTEGRATION.md) for profile inputs and service boundaries.

## A2UI and renderer boundary

The A2UI template uses the official Basic Catalog and a native DOM renderer for a small component and action subset. The boundary rejects unapproved components, actions, data paths, malformed topology, and oversized messages. The host supplies all bound values. Run and outcome values are written as text, and actions only select a run or invoke existing host-owned refresh/filter behavior.

The dedicated validation, renderer, and projection tests are `tests/a2ui.test.ts`, `tests/a2ui-renderer.test.ts`, and `tests/run-operations.test.ts`. Dashboard refresh, JEV controls, summary timing, and publication API projections are covered by `tests/dashboard-refresh.test.ts`, `tests/jev-panel.test.ts`, `tests/run-metrics.test.ts`, and `tests/api.test.ts`.

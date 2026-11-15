---
name: soyuz-dashboard-ui
description: Use when changing dashboard layout, styles, shared DOM components, run cards, analysis views, or interaction accessibility.
---

# Change the dashboard UI consistently

Read `docs/DASHBOARD-UI.md` and the relevant dashboard sections of `docs/OPENUI-ANALYSIS.md`. For OAuth, API data, or analysis security changes, also follow `soyuz-dashboard-auth` or `soyuz-openui-analysis`.

## Reuse the current patterns

- Shared design tokens and theme behavior live in `public/dashboard/tokens.css`; component styles live in `public/dashboard/style.css`.
- Semantic DOM builders and state helpers live in `dashboard/ui/components.ts`.
- Run cards and lists are in `dashboard/run-card.ts` and `dashboard/run-list.ts`; analysis renderers are in `dashboard/analysis/components.ts`.
- Keep page headers inside the main landmark, use native labelled controls, preserve source and keyboard order, and keep actions separate from card surfaces.
- Render user, model, run, and event values as text. Validate any structured component input and keep dynamic lists bounded.

## Check accessibility and behavior

Cover changed interactions in `tests/dashboard-ui.test.ts`, `tests/dashboard-markup.test.mjs`, or focused dashboard tests. Review keyboard operation, visible focus, labels and names, zoom/reflow, forced colors, reduced motion, and status communication for rendered changes. Automated tests do not replace checking the rendered page where layout or assistive technology behavior is affected.

Use `npm run typecheck` and `npm run build` for verification when requested.

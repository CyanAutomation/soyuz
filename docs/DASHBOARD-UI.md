# Dashboard UI foundation

Soyuz keeps its dashboard in plain HTML, CSS, and TypeScript. The shared UI
foundation provides design tokens, layout primitives, reusable CSS components,
and small DOM builders without adding a framework or a runtime dependency.
These are Soyuz-owned implementations of the useful Kihon patterns; the
provisional, private Kihon package is not a runtime dependency.

## Design tokens

`public/dashboard/tokens.css` is imported by `style.css` and defines the shared
dashboard values for page and surface colours, text, borders, status tones,
spacing, radii, shadows, typography, and focus. The dark values follow
`prefers-color-scheme`, preserving the current system-theme behavior. Keep the
Soyuz navy accent and status-specific colours when extending the token set.

## CSS components

The public component classes live in `public/dashboard/style.css`:

| Component | Classes | Use |
| --- | --- | --- |
| Page header | `.page-header`, `__content`, `__title`, `__description`, `__meta`, `__actions` | Place one page title and its context inside the page's `main` landmark. |
| Toolbar | `.toolbar`, `__group`, `__group--search`, `__group--filters`, `__group--end`, `__summary` | Arrange labelled controls and related actions; groups wrap without changing source order. |
| Card | `.card`, `.card--padded`, `.card--structured`, `__header`, `__title`, `__description`, `__body`, `__footer` | Give related content a shared surface and stable content slots. |
| Badge | `.badge`, `--active`, `--warning`, `--success`, `--danger`, `--neutral` | Show a short, text-labelled status or category. |

Page headers belong inside the existing `main`; application identity,
navigation, and authentication stay in the app header. Toolbars are groups of
native controls, not ARIA composite toolbars, so normal Tab navigation is
preserved. Inputs and selects need visible labels. Cards do not make their
entire surface clickable; actions remain independent controls.

## DOM components

`dashboard/ui/components.ts` exports the common builders and state helpers:

- `createCard({ className, tagName }, document)` returns an article, section,
  or div with `header`, `body`, and `footer` slots.
- `createDefinitionList(entries, className, document)` builds a semantic `dl`
  using text content for labels and values.
- `createField({ id, label, control, helpText, errorText }, document)` builds a
  labelled field and associates its help and validation messages with the
  control.
- `createTimestamp(label, value, className, document)` pairs a readable label
  with a semantic `<time>` element.
- `createBadge`, `setNotice`, and `setButtonBusy` share status and loading
  presentation across dashboard views.

Use `createCard` for a related content unit and its slots. Keep larger dynamic
views application-owned. The reusable run-card component lives in
`dashboard/run-card.ts`; the dashboard owns its data fetching and clipboard
effects. Soyuz status tones intentionally include warning and danger in addition
to the neutral, active, and success states.

## Page patterns

The dashboard keeps the two current destinations in its horizontal navigation.
If the management console grows enough to need persistent section navigation,
revisit a sidebar and shell layout. The Recent runs page keeps its newest-first
run cards and native disclosure sections; the toolbar groups search, sorting,
status filtering, refresh, and result count. The Run analysis page uses the same
page header and padded card primitive for its prompt and JEV controls.

Soyuz retains at most 30 runs and the dashboard requests that full page on its
initial load. Search therefore covers the retained history in normal use; the
visible help text states this scope. Keep pagination support for smaller page
sizes and future retention changes.

These patterns establish consistency, but they do not certify accessibility.
Review keyboard use, zoom and reflow, forced colours, reduced motion, and
assistive technology behavior in the rendered pages when changing the UI.

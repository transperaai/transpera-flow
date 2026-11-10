# UI cleanup plan

Status: proposal (2026-11-10). Built from a code review of `apps/web/src` (four parallel area reviews) and screenshots of the test harness pages at 1440px and 1920px. The harnesses mount the page component without the Next layout or sidebar, and without the Inter font. So "edge-to-edge" layouts and serif text in those shots come from the harness. Width caps, card nesting and header styles do come from the real components.

## What is wrong

### 1. No layout system, so content sits in a narrow centred column

- `components/shell/page.tsx:19,26`: `Page` sets `mx-auto` with `width` typed as only `max-w-3xl | max-w-5xl | max-w-6xl`, and the default is `max-w-5xl` (1024px). Nothing in the app is wider than 1152px.
- At 1920px with the sidebar open, that leaves about 270–400px empty on each side. Only 10 `xl:` or `2xl:` classes exist in the app, so nothing grows on big screens.
- Four places copy the wrapper by hand instead of using `Page`: `overview/overview.tsx:353`, `process-page.tsx:271`, `history/history-page.tsx:37`, and `shell/skeletons.tsx:177,204,254`.
- Widths differ across sections:
  - The Issues, Solutions, Sources, Settings and Blocks pages are 1024px.
  - The Processes, Sandbox, Capacity, issue detail, solution detail and Settings sub-pages are 1152px, so the width jumps as you move around Settings.
  - Restore is 768px.
  - The empty-workspace start page (`start-overview.tsx:48–111`) is five `max-w-3xl` cards centred in the middle of the screen.
- Removing the cap alone would cause the opposite problem. Inside the cap, forms and bars are already `w-full`. For example, the Settings "Availability floor" `%` input stretches to 900px, and the driver sliders and capacity bars run the whole row. We need fluid pages and limits on how wide controls can grow.
- `SidebarInset` sets no rules for height or overflow, so no page can own the viewport. Canvas pages scroll the whole page instead of scrolling their own panes.

### 2. Every area looks different

- **Page headers.** There are two different components called `PageHeader`:
  - `shell/page.tsx` is a bare header, `font-heading font-semibold`. It is used by Issues, Processes, Restore and Home.
  - `page-kit/page-header.tsx` is a header inside a Card, `font-display font-bold`. It is used by Overview, Settings, Sources, Solutions, the detail pages, Sandbox and Tokens.
  - The process page (`process-nav.tsx`, `process-header.tsx`) and the Editor (`editor-bar.tsx`, `text-[17px]`) each have their own as well.
  - `ShellHeader` repeats the page title above the `h1`.
  - `settings/tokens` renders one header while its `loading.tsx` renders the other.
- **Section headings: about six styles.**
  - The Overview uses a `border-b-2 border-fg` rule with `text-lg`.
  - `SectionCard` uses `text-base font-bold`.
  - The process page uses `text-sm font-bold` h3s.
  - Forecast uses `font-heading text-lg font-semibold`.
  - The Editor uses an 11px uppercase label.
  - Settings uses raw `<h3 class="mb-2 font-semibold">`.
- **Type.** There are 104 `text-[Npx]` uses (`text-[11px]` appears 59 times, even though `text-2xs` is 11px), and `text-xs` (555) is used more than `text-sm` (393). `font-display` and `font-heading` are both Inter. Titles alternate between bold and semibold.
- **Surfaces.**
  - `ui/card` uses `ring-1 rounded-xl`, while hand-rolled sections use `border border-line rounded-token`.
  - `rounded-token` is the same value as `rounded-md`.
  - Shadows `xs`/`sm` and `md`/`lg` resolve to the same values.
  - Cards sit inside cards up to three deep: Overview company map, process page "What the process shows", Sources library, Capacity tiles.
- **Lists.** Issues, Solutions, Sources, People/roles, Processes and Blocks each build their list differently:
  - The wrappers vary: `Card p-0`, `rounded-lg border bg-panel`, `rounded-token border bg-card`, and a CSS grid of `div role=button`.
  - Filters work three ways: a URL-synced `FilterMenu` (Issues), the same toolbar with local state (Solutions), and labelled `NativeSelect`s (Sources).
  - The primary action sits in three different places.
  - None of these lists uses `ui/table`, and none has sortable columns.
- **Duplicate primitives.**
  - Two `EmptyState`s: `shell/` (dashed) and `page-kit/` (tinted with an icon), plus bare dashed `<p>`s and `Card`s.
  - Pill systems: `StatusPill`, `TagPill`, `RatingPill`, `SourcePill`, `DiscrepancyPill`, the canvas pills and `ui/badge`.
  - `ui/select` has no importers; there are 27 `NativeSelect` uses and 9 raw `<select>` elements.
  - Raw elements in place of the `ui/*` primitives: 119 `<button>`, 25 `<table>`, 38 `<input>`.
  - The conic-gradient logo is pasted into `app-header`, `login` and `privacy` instead of using `TransperaMark`.
- **Toolbars.** The editor bar (`onBar` button overrides), the scenario bar (a Card), the playback bar (its own button class and a native select), the map controls and two hand-built segmented toggles in Sandbox all differ in height, radius and button size. `ui/toggle-group` exists and isn't used for them.
- **Charts.** Each sandbox, capacity and forecast chart has its own fixed SVG height, its own `useWidth` hook, its own axes, tooltip and palette. `compare-chart` uses `--edit` as a series colour.
- **Loading skeletons don't match the pages, so the layout jumps on load:**
  - Overview: the skeleton shows the map first.
  - Process page: the skeleton shows a 6-column property grid that the page doesn't have.
  - Issue detail: the skeleton has a side rail; the page is one column.
  - Solutions and Blocks: card-grid skeletons for table pages.
  - History: a table skeleton for a list of rows.
  - Every skeleton prints "Loading…" as the description.

### 3. The order of content doesn't match what matters

- **Overview.** The page is about 10 cards in one long scroll, ordered Money, then People, then Processes. The company map, the product's centrepiece, is last and boxed three deep. The 2-up grids have uneven card heights and leave holes when a card is missing.
- **Process page.** The canvas is about 360px tall inside a 1152px column. Facts, issues and sources are stacked cards underneath, and issues, the most actionable part, come last.
- **Sandbox.** Users see the header, explanatory text and the map before any lever. The verdict ("worst month") is below the map and the levers. Three charts stack in a column about 780px wide that never gets wider. The levers panel is sticky inside a page that also scrolls, so there are two scroll areas at once.
- **Settings.** It is one long scroll of six to eight cards with no sub-navigation. Some fields save on blur, others have explicit Save buttons, and others save per row. Users cannot tell which is which.

## Target design system

### Page variants (one container, owned by `Page`)

Replace `width` with `variant`:

| Variant | Width | Used for |
|---|---|---|
| `fluid` (default) | no cap; gutter `px-4 sm:px-6 lg:px-8` | lists, dashboards, detail pages, History |
| `workbench` | full width and `h-[calc(100svh-var(--shell-header))]`, `overflow-hidden`; each pane scrolls itself | process page, Sandbox, Editor (already full screen), Forecast |
| `form` | `max-w-screen-xl` content beside a sub-nav | Settings |
| `narrow` | `max-w-3xl` | Restore, Privacy, sign-in and holding pages |

Rules that stop fluid pages from stretching:
- Paragraphs get `max-w-prose`.
- Inputs get a size: `xs` for numbers and percentages (about 8rem), `md` for text (about 28rem), and full width only for textareas.
- Bars and sliders sit inside a grid of label, control and value, with the control column capped at about 40rem.
- Card grids use `grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]` or `lg:grid-cols-12`, never a fixed `md:grid-cols-2`.

Give `SidebarInset` a `min-h-svh flex flex-col` contract so a `workbench` page can fill the viewport. Make `PageSkeleton` render through `Page` with the same variant, so a skeleton can't pick a different width from its page.

### Page archetypes (build each once, reuse it everywhere)

1. **ListPage.** Header (title, one-line description, one primary action on the right), then a `Toolbar` (search, `FilterMenu`s, view toggle, count), then a `DataTable` (built on `ui/table`: sticky header, sortable columns, filters and sort kept in the URL, shared `EmptyState`, pagination or "show more"). Row click opens a detail page or a right `Sheet`. No card around the table, just a bordered table surface. Use it for Issues, Solutions, Sources, Processes, Blocks, People and roles, Home workspaces, and Tokens.
2. **DetailPage.** Breadcrumb above the header, then a header with title, status pill and actions. Below that, from `xl` up, a main column plus a sticky metadata rail of about 20rem. Use it for issue, solution, history (version list on the left, selected version on the right), and the block detail.
3. **DashboardPage.** Header, then a flat `KpiStrip` (tiles with no outer card), then a 12-column grid of panels of equal row height. Use it for Overview and Capacity.
4. **WorkbenchPage.** A one-row 48px `Toolbar`, then `[left panel?] canvas or main [right inspector]`. Panels can be resized and collapsed, and their widths are saved. The canvas runs edge to edge with no card border. Use it for the process page, Sandbox and Editor.
5. **SettingsLayout.** A left sub-nav (about 15rem) listing Workspace, Simulation, Purposes, Churn drivers, Demand, Tiers and clients, People and roles, Access, each as its own route at the same width. Form rows are `label (12rem) | control (sized) | hint`. Use one save pattern: autosave per field, with a "Saved" or "Not saved" status. Retire `LinkRows`.

### Primitives: keep, merge, delete

- **PageHeader.** Keep one, the page-kit version, made flat by default (no Card) with `eyebrow`, `pills`, `meta` and `actions` slots. Delete the shell version. `ShellHeader` keeps only the sidebar toggle and breadcrumbs, not a second title. `app-header` uses `TransperaMark` and the same 48px bar.
- **SectionHeading.** One component with two sizes: `section` (text-base semibold) and `label` (2xs uppercase, for panels). It replaces `OverviewSection`'s rule, the process-page h3s, the editor `text-[11px]` labels and the Settings h3s.
- **EmptyState.** Keep the page-kit version and add `variant="inline" | "panel"`. Delete `shell/empty-state.tsx` and the bare dashed `<p>`s.
- **Pills.** `StatusPill` becomes the base, with tones. Rebuild Tag, Rating, Source, Discrepancy and the canvas pills on top of it. Delete the extra copies, or fold `ui/badge` into it.
- **Select.** Pick `NativeSelect` (it already has 27 uses and works well on phones) and delete `ui/select.tsx`. Move the raw `<select>`s in the playback bar and elsewhere onto it.
- **Toolbar and SegmentedControl.** Use one height (32px controls inside a 48px bar) and one button size. Build SegmentedControl on `ui/toggle-group`. Replace the editor's `onBar` overrides with `Button variant="onEdit"`. Replace the Sandbox horizon and heat toggles, the playback bar, the map controls and `ScenarioBar`'s Card.
- **ChartFrame.** Title, help, legend (up to 5 items inline, the rest behind a "Key" popover), a height that follows the aspect ratio, and one axis, gridline and tooltip style. Charts take series colours from `chart-1..5` only. Share one `useElementWidth` hook. Use it for play, compare, time, capacity bars and the forecast timeline.
- **KpiTile.** One tile, with an optional status edge and a sparkline. It replaces the tiles in `kpi-strip`, `capacity/widgets.tsx:201`, the overview hero and the forecast money tiles.
- **Dead code.** `components/people-page.tsx` (629 lines; no route imports it, and `/people` redirects to `/capacity`), `ui/select.tsx`, and `shell/empty-state.tsx`.

### Tokens

- **Type scale.** Page title is 2xl semibold. Section is base semibold. Body is sm. Label is xs medium. Caption is 2xs. Replace every `text-[Npx]` with these, and add an ESLint rule (`no-restricted-syntax` on class strings matching `text-\[\d`) so they don't come back. Merge `font-display` and `font-heading` into one name. Titles are always semibold.
- **Radius.** Cards and panels `rounded-xl`, controls `rounded-md`, pills `rounded-full`. Drop `rounded-token`. Surfaces use `border border-line`; drop the `ring-1` card look.
- **Shadow.** A real four-step scale, used sparingly. Most surfaces should have a border and no shadow.
- **Spacing.** Add `--space-page-x`, `--space-section` (24px) and `--space-panel` (16px). Card padding is always `--space-panel`.
- **Colour.**
  - Add dark values for `--purpose-*`, `--auto`, `--aug` and `--man`.
  - Merge the duplicated dark block (`prefers-color-scheme` and `[data-theme=dark]`) into one shared selector list.
  - Add a theme toggle.
  - Separate cards from the background in dark mode a little more.
- **Purple.** `--edit` is the colour that means "this is an editing screen" (#104). Today it also colours "New process" and "Edit company map" on the Processes page and the start page, so those pages have a purple primary button where others have a teal one. Proposal: primary actions are always teal, and purple is used only for the Editor chrome and a small edit icon or badge on buttons that open the Editor. **Decision for the owner.**

## Page-by-page changes

| Page | Change |
|---|---|
| Overview | `DashboardPage`, fluid. KPI strip at the top, then the company map full width with no card, at about 60svh. Below it, a 2/3 + 1/3 grid: Team load and Where time goes on the left; Open issues, Busiest people and Time split in the right rail. Drop the anchor nav and the `border-b-2` section rules. Collapse the "How this works" disclosures into a `?` beside each panel title. |
| Start (empty workspace) | Fluid. Setup checklist on the left (8 of 12 columns) and "Other ways to start" on the right (4 columns). No `max-w-3xl`. |
| Processes | `ListPage`. One primary "New process"; Upload and Company map are secondary. All columns visible from 1280px. Clicking a row opens a 420px preview sheet showing the map, instead of expanding the row inline. Use `Button` for the History / Edit / Open buttons in each row. |
| Process page | `WorkbenchPage`. The canvas fills the page. A 380px right inspector has tabs for Step, Facts, Issues and Sources. The headline numbers (hours, cost, headline) go into the toolbar strip. Hours by role, Time split and Key person move to a "Details" tab or a 3-column row below the fold, with no outer card. |
| History | `DetailPage` master-detail: version list on the left, the selected version's changes and a read-only map preview on the right, with Restore and Duplicate in the header. |
| Editor | Keep the three panes, but make them resizable and collapsible (palette 240px, which collapses to an icon rail; inspector 320–420px). Canvas edge to edge. The bar becomes one 48px row that doesn't wrap. The hint, block and solution forms move into the inspector or a popover. |
| Sandbox | `WorkbenchPage`. Toolbar: version, horizon, Reset, Export, with the long explanatory text behind a `?`. Levers in a 320px panel on the left, collapsible, with collapsible groups. Main area: a verdict KPI strip first, then the charts in an auto-fit grid (two or three across from 1440px). The map is collapsible or on a tab, Map / Results. |
| Capacity | `DashboardPage`. Flat KPI strip (remove the teal-tinted container and the `[&_[data-slot=card]]` overrides). Panels in a `xl:grid-cols-2 2xl:grid-cols-3` grid. Sticky section links if it stays long. Bars use `ChartFrame` with a capped track width. |
| Forecast | Its own `WorkbenchPage` or a Capacity tab. The timeline runs full width, with money tiles in a strip above it. |
| Issues / Solutions / Sources / Blocks | `ListPage` with `DataTable`. Solutions keeps its filters in the URL. Sources loses the "Library" card and moves to `FilterMenu`. Blocks gets a list plus a detail pane, with the block map at full pane size. |
| Issue / Solution detail | `DetailPage`: main column plus a metadata rail (rating, status, owners, process, dates, linked items). The breadcrumb comes out of the card eyebrow. |
| Settings (all) | `SettingsLayout` with a sub-nav, one width, sized inputs and one save pattern. People and roles becomes a real `DataTable` that opens the existing Sheet. In the people list at the bottom of Simulation, the bare `<details>` rows become proper rows. |
| Home / Tokens | Fluid `ListPage`; "New workspace" becomes a dialog. Login and the holding page share one `AuthCard`. |
| Restore | `narrow`. One `SectionCard` per step and a proper drop zone. |
| All `loading.tsx` | Render the same archetype with skeleton content and no "Loading…" description. |

## Order of work (each step is a reviewable PR)

1. **Foundation** (low risk, the most visible change): `Page` variants plus the `SidebarInset` contract; one `PageHeader`; `ShellHeader` without the duplicate title; type-scale tokens, merged fonts, radius and shadow clean-up; the ESLint guard against arbitrary sizes; delete dead code. Switch every page to `fluid` / `narrow` and add the input-size rules. This step alone fixes most of the "tiny widget in the middle" complaint.
2. **Shared primitives:** `SectionHeading`, the merged `EmptyState`, `StatusPill` tones, `Toolbar` and `SegmentedControl`, `KpiTile`, `ChartFrame`, `DataTable`.
3. **List pages** on `ListPage`: Issues, Solutions, Sources, Processes, Blocks, Home, Tokens.
4. **Detail pages** on `DetailPage`: issue, solution, history.
5. **Dashboards:** Overview restructure, Capacity, Start.
6. **Workbenches:** process page, Sandbox, Editor panels and bar, Forecast.
7. **Settings** layout with sub-nav and one save pattern.
8. **Skeletons and visual baselines:** match every `loading.tsx`, then regenerate the Storybook baselines (`pnpm --filter @transpera-flow/web visual:docker`, see `docs/visual-regression.md`), and fix the e2e phone and tablet checks.

Every step changes pixels, so the committed baselines in `apps/web/visual/__screenshots__` and the harness screenshot tests (q1, q3, q8, q11b, q14, …) need regenerating as part of each PR, not saved up until the end.

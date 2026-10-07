# C5 build brief: empty and loading states, dark mode and the phone pass (#44)

Scoped 7 Oct 2026 against `origin/main` at bf61be0e (C6 #229 and the handover #231 merged). Read
`docs/plans/builder-brief.md` first. This brief adds to it and wins where they differ. Build strictly from it. If
something here doesn't match the code, **ask; don't guess.** Every open question has a default: use it.

## The short version

C5 (#44) is Austin's polish ticket. He picked three parts to build now. This brief covers two of them; Sentry has its
own brief (`docs/plans/c5-sentry-brief.md`, branch `claude/c5-sentry`).

1. **Loading states.** Today only Sources has a `loading.tsx`. Every other workspace page shows nothing while its server
   loaders run. Add a `loading.tsx` to every page folder under `src/app/w/[slug]`, built from a small set of skeletons
   that match each page's final layout. Maps that load late get a map-shaped skeleton. A map whose first simulation is
   still running gets an animated "Running the first simulation…" status over it.
2. **Empty states.** Most lists already have one. Fill the few gaps found below (a process with no steps, the People
   page with nobody, the MRR chart with no months, utilisation with no roles) with one shared `EmptyState`.
3. **Dark mode.** The code is already almost free of raw colours. Fix the four places that aren't, add two tokens and
   one foreground token, and add a test that fails on any raw colour outside the tokens, plus a browser check that no
   page draws a light surface in dark mode.
4. **Phones.** No page scrolls sideways at 400 px today (checked on 7 Oct; see the audit). Phones (under 640 px) become
   **read-only**: the Editor shows a notice instead, every edit entry point is hidden, and settings forms are disabled.
   Tablets (640 px and up) keep everything.
5. **Checks.** A Playwright suite (`apps/web/e2e/`) runs against `next start` in demo mode after the build in CI. It
   crawls every demo page at 400 px (no sideways scroll, no edit controls), at 768 and 1024 px (no sideways scroll, the
   Editor works) and in dark mode at 1280 px (no light surfaces).

Austin will do a visual design pass himself later. **Invent no new visual style.** Every skeleton, notice and empty
state uses classes that already exist in the app (listed under Patterns). No new colours apart from the four tokens in
Part 2b, which are dark-mode fixes.

### Two PRs, in this order

| PR | Branch | Contents | Closes |
|---|---|---|---|
| **2a** | `claude/c5-states-dark-mobile` (this brief is on it; `git merge origin/main` first) | Parts 1 and 2: skeletons, `loading.tsx` files, the map placeholder and first-run status, empty states, stories | nothing (comment on #44) |
| **2b** | `claude/c5-dark-mobile-2b`, from `origin/main` **after 2a merges** | Parts 3, 4 and 5: tokens and the raw-colour test, phone read-only, the e2e suite and its CI step, stories | nothing (comment on #44) |

2b goes second because its 400 px crawl and dark crawl then cover 2a's new UI too. Neither PR closes #44: the
onboarding wizard, the backup-restore check and Austin's visual pass are still open on it. No migrations. No engine
change. Commit and push after each numbered step.

---

## Decisions (verbatim)

**#44, Austin, 7 Oct**, choosing the C5 parts to build now:
> Empty and loading states

> Dark mode and mobile pass

> Sentry error reporting

On the rest of C5:
> i would like to do a UI pace but thats not a functional blocker

(He means a UI pass: he will do a visual design pass himself later. So keep changes functional and consistent with the
existing tokens.)

On the onboarding wizard:
> skip it for now

**#44's acceptance criteria this brief answers** (the issue body):
> - Every screen passes a dark-mode review with no hard-coded colours
> - On phone widths the app is read-only, with no horizontal scroll
> - Every list, chart and canvas has designed empty and loading states

and from "What to build":
> - Dark mode parity on every screen.
> - A read-only mobile view (tablet stays fully usable).
> - Designed empty and loading states: skeletons that match the final layout, and an animated canvas placeholder while
>   the first run computes.

Earlier rules that still hold: the tokens file says "Components use these via Tailwind theme names; no raw hex in
components", and "every animation stops under prefers-reduced-motion" (`src/styles/tokens.css`). `useIsMobile`'s
comment: "1024 (not 768) keeps the map usable on tablets" (`src/hooks/use-mobile.ts`).

---

## Audit: what exists on `origin/main`

I ran the app in demo mode (`next dev`, no Supabase env) and crawled every demo page with Chromium at 400, 768 and
1440 px, light and dark, on 7 Oct. Script results are summarised here; the builder re-runs the same checks as tests.

### Loading

| Route (under `/w/[slug]`) | Has `loading.tsx`? | What the page loads on the server |
|---|---|---|
| `/` and `/overview` | no | `WorkspaceOverview`: ~10 loaders, then the client runs the company simulation |
| `/processes` | no | process rows |
| `/p/[processId]` | no | the bundle, issues, findings, sources, solutions |
| `/p/[processId]/edit` | no | `WorkspaceEditorPage`: live and draft bundles |
| `/p/[processId]/history` | no | versions |
| `/p/[processId]/first-principles` | no | the bundle and first principles |
| `/issues`, `/issues/[number]` | no | issues; one issue with its process |
| `/solutions`, `/solutions/[id]` | no | solutions; one solution with its base |
| `/blocks`, `/suggestions`, `/people`, `/forecast` | no | as named |
| `/sources` | **yes** (`sources/loading.tsx` with `SourcesLibrarySkeleton`) | the source library |
| `/settings` (and `access`, `ai`, `branding`, `calibration`, `levers`) | no | the settings bundle |
| `/share`, `/restore` | no | share links; the empty-workspace check |

Client-side loading that already exists and stays as it is: the Overview's trend charts and team timeline
(`chartLoading`, `overview.tsx:82`), the health cards (`health-cards.tsx:29`), findings by process
(`findings-by-process.tsx:49`), insights (`insights.tsx:96`), forecast chart (`forecast-view.tsx:549`), the processes
table's row card, the issue page's and solution compare's maps (all `dynamic(..., { loading: () => <Skeleton
className="h-64 w-full" /> })`), "Simulating 3 months…" over the Overview's company map (`overview.tsx:527`),
"Simulating…" in supporting data (`process-supporting-data.tsx:29`).

**Gaps:**
- No route-level loading anywhere but Sources.
- The three `dynamic` maps fall back to a plain `h-64` grey box, not a map shape.
- **No map shows that its first run is computing.** `useSimulation` starts as `{ status: "running", run: null }`; the
  process page (`process-page.tsx:152`), the Overview's company map, the issue page, the Larkspur view
  (`process-view.tsx:466`) and solution compare draw the map with no numbers until the run lands.
- `Skeleton` (`components/ui/skeleton.tsx`) uses `animate-pulse` with no reduced-motion stop.

### Empty

Already handled (leave these alone; restyling them is Austin's pass): issues page (`issues-page.tsx:164`), issues
register (`issues-register.tsx:241`), processes table and archived list, sources library, suggestions and proposals,
blocks library, history (process and company), forecast alerts, share links, solution cards, saved scenarios, imports
history, insights and facts, trend charts (four `data-empty` states), wait by step, supporting data, agency workspace
list (`app/page.tsx`), API tokens, an empty workspace's Overview (`EmptyOverview` in `workspace-overview.tsx`).

**Gaps:**
- **A process with no steps.** `ProcessCanvas` read-only draws an empty frame. (The Editor must keep its empty
  canvas: "Opens the Editor on an empty map" is how a new block starts.)
- **People page with nobody.** `people-page.tsx:375` renders the table whenever `!onlyOwn`, so a workspace with no
  people shows headers and no rows.
- **`MrrChart` with no points** (`overview/charts.tsx:54,63`) reads `ticks[ticks.length - 1]!` and
  `points[points.length - 1]!`: it throws on an empty series.
- **`UtilisationBars` with no roles** (`utilisation-bars.tsx:63`) renders an empty box.
- `SolutionsList`'s `NewSolutionButton` returns null with no processes (fine), but the page then has no hint; the
  existing "No solutions yet" card covers it. No change.

### Dark mode

Raw colours outside `src/styles/tokens.css` (comment `#123` issue references excluded):

| File | What | Verdict |
|---|---|---|
| `src/components/editor/editor-tour.tsx:133` | `boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)"` spotlight | **fix**: new `--scrim` token |
| `src/components/ui/dialog.tsx:42`, `ui/sheet.tsx:40` | overlay `bg-black/10` (shadcn default; nearly invisible on the dark background) | **fix**: new `--overlay` token |
| `src/components/step-issue-badges.tsx:46`, `process-canvas.tsx:487`, `scenario-library.tsx:164` | `text-white` on `bg-crit` (3.7:1 on dark `--crit` #e66767) | **fix**: new `--crit-fg` token |
| `src/lib/export/map-image.ts:30–43,301` | hex palette of the exported PNG | **allowed**: the export is always drawn light (a file, not the screen) |
| `src/lib/branding/contrast.ts:120–175` | the token values for contrast maths | **allowed**: arithmetic, mirrors tokens.css |
| `src/components/branding/branding-settings.tsx:21,292`, `app/w/[slug]/settings/branding/actions.ts:45` | "like #0b6e8a" in help text | **allowed**: words, not a colour |
| `src/app/privacy/page.tsx:22`, `login/page.tsx:17`, `app-header.tsx:9`, `shell/transpera-mark.tsx:12`, `s/[token]/page.tsx:107` | `bg-[conic-gradient(...var(--accent)...)]` | fine: tokens |

No Tailwind palette classes (`bg-gray-*`, `text-slate-*`, `bg-white`…) apart from the three above. No inline SVG
`fill`/`stroke` with a literal colour. Tokens: `--chart-1`…`--chart-5` have no dark values; they are used only by the
brand mark gradient, which reads well on both. Leave them.

Screenshots at 1440 px dark of every demo page looked right (map cards, badges, Editor purple, ratings). Pages the demo
can't reach (Settings and its subpages, Access, Share links, Restore, API tokens, the agency list, `/s/[token]`,
`/login`) use only token classes, by the grep above; the browser tests' harnesses for them (`settings-harness`,
`share-harness`, `restore-harness`, `people-harness`) are where to look if the builder wants a picture.

There is no theme switch: the app follows the OS (`prefers-color-scheme`), with `data-theme` honoured if set. Keep it
that way (a switch is a visual design decision for Austin).

### Phones and tablets

Page-level sideways scroll at **400 px: none** on all 21 demo pages (`scrollWidth === clientWidth`). Elements that run
past the edge without a clipping or scrolling ancestor: **only the Editor's keyboard-shortcut popover**
(`w-80`, right edge 469 px), which the phone gate removes. Wide tables already scroll inside their own frame: issues
(`issues-page.tsx:169`, `min-w-[44rem]` in an `overflow-x-auto` card), People, version history. The Larkspur KPI strip
is a deliberate snap carousel (`kpi-strip.tsx:135`). Truncated text (`truncate`) is intended.

At **768 px**: no page-level overflow; the People table scrolls in its frame. At 1024+ everything fits.

Nothing is read-only on a phone today: the Editor opens and works at 400 px, "Open in Editor", "+ New issue", "✎ New
solution", settings forms and the rest are all live.

`useIsMobile` (`hooks/use-mobile.ts`) is `max-width: 1023px` and only decides the sidebar sheet. Don't change it.

---

## Part 1 (PR 2a): loading states

### 1a. Skeleton reduced motion

`src/components/ui/skeleton.tsx`: add `motion-reduce:animate-none` to the class list. Nothing else changes. (The
visual suite already screenshots with animations disabled, so no baseline moves.)

### 1b. Shared skeletons: `src/components/shell/skeletons.tsx` (new, no `"use client"`)

Each export renders a `role="status"` wrapper with an `aria-label` ("Loading the Overview", …), `data-loading="<name>"`,
and an `sr-only` "Loading…" sentence, exactly like `SourcesLibrarySkeleton` (`sources/sources-library.tsx:264`). Build
them only from `Skeleton`, `Card` and the layout classes the real page uses, so the frame doesn't jump when content
arrives. Read each real page before drawing its skeleton and match its column structure and the heights of its first
screen.

| Export | Matches | Shape |
|---|---|---|
| `PageSkeleton({ title, eyebrow, children })` | `Page` (`shell/page.tsx`) | renders `<Page title eyebrow description="Loading…">` (the real title, so the header doesn't jump) with `children` as the body |
| `ListSkeleton({ rows = 5, filters = true })` | issues, processes, solutions, suggestions, blocks, share links | optional row of 2–3 `h-8` pills, then a bordered list of `h-12` rows (the Sources pattern) |
| `CardGridSkeleton({ cards = 4 })` | solution cards, Overview health cards, block cards | `grid gap-3 md:grid-cols-2` of `Card`s with three skeleton lines |
| `TableSkeleton({ columns = 5, rows = 6 })` | People, version history, share links | a `Card` with a header row and `rows` lines |
| `MapSkeleton({ height = 360 })` | `ProcessCanvas` | see 1c |
| `OverviewSkeleton()` | the Overview | header, `MapSkeleton`, a 4-card health row (`CardGridSkeleton` with `xl:grid-cols-4`), findings list |
| `ProcessPageSkeleton()` | the process page | sticky top bar, the pill row, About (a 6-column `dl` of short lines), First principles card, `MapSkeleton` |
| `EditorSkeleton()` | the Editor | the purple bar (a `bg-edit` strip, `h-12`), palette column on the left, `MapSkeleton` fill on the right |
| `SettingsSkeleton()` | Settings | three `Card`s with a heading line and four field rows |
| `FormSkeleton()` | Restore, Share links' form, AI analysis, Branding, Levers, Calibration, Access | one `Card` with four field rows |

Pages outside the `Page` frame (process page, Editor, Overview) draw their own top bar: use `ShellHeader` where the real
page does, so the sidebar toggle is there while loading.

### 1c. The map placeholder: `src/components/map/map-placeholder.tsx` (new, `"use client"` not needed)

- **`MapSkeleton({ height })`**: the canvas frame's own classes (`relative isolate flex min-w-0 flex-col rounded-lg
  border bg-card`, from `process-canvas.tsx:1598`), a toolbar strip (`border-b border-line px-3 py-2` holding three
  `Skeleton h-7` pills), then an area of `height` px holding four step-card-shaped skeletons (`Skeleton h-14 w-40
  rounded-token`) in a row, joined by `border-t border-line-2` lines, vertically centred. On a phone the row wraps.
  `role="status"`, `aria-label="Loading the map"`. Animated by `Skeleton`'s pulse (and so still under reduced
  motion).
- **`FirstRunStatus()`**: the chip shown over a drawn map while its first run computes. Absolutely positioned
  `top-2.5 right-2.5 z-10` inside the map area (the diff legend's spot, `process-canvas.tsx:1643`; the two never show
  together because the diff only exists in the Editor after a run), classes copied from that legend: `rounded-token
  border border-line bg-panel/95 px-2 py-1 text-[11px] text-fg-2 shadow-token`. Content: a `size-1.5 rounded-full
  bg-accent animate-pulse motion-reduce:animate-none` dot (the "Viewing live" pill's dot, `process-page.tsx:269`) and
  "Running the first simulation…". `role="status"`, `aria-live="polite"`, `data-first-run`.

Wire them:
1. `ProcessCanvas` gets an optional prop `computing?: boolean` (default `false`), documented "The first run is still
   computing: shows FirstRunStatus over the map." Render `{computing && <FirstRunStatus />}` inside the map area div
   (`process-canvas.tsx:1630`, the `relative min-h-0` div).
2. Callers pass `computing={sim.status === "running" && sim.run === null}` (only the **first** run; a later run keeps
   the old numbers on screen and shows nothing new, as today):
   - `components/process-page.tsx` (the `ProcessCanvas` at the Map section; `sim` from line 152);
   - `components/overview/overview.tsx` (the company map; use the simulation whose result feeds the map,
     `horizonSim`; leave the "Simulating 3 months…" text as it is);
   - `components/process-view.tsx:466` (Larkspur; `sim`);
   - `components/issues/issue-page.tsx` and `components/solutions/solution-compare.tsx`: pass it only if the page
     already holds a `useSimulation` state for that map. **Don't add a simulation to a page that has none.**
   - **Not** the Editor (it simulates on demand with its own footer) and not the processes table's card (no run).
3. Replace the three `loading: () => <Skeleton className="h-64 w-full" />` fallbacks (`processes-table.tsx:18`,
   `solution-compare.tsx:34`, `issue-page.tsx:41`) with `loading: () => <MapSkeleton height={256} />`.

### 1d. `loading.tsx` files (server components, default export, no data)

Create one in each folder below. Each is a few lines: the right skeleton with the page's real title. Copy
`src/app/w/[slug]/sources/loading.tsx` (keep it as it is).

| File | Renders |
|---|---|
| `src/app/w/[slug]/loading.tsx` | `OverviewSkeleton` (covers `w/[slug]/page.tsx`, the Overview) |
| `src/app/w/[slug]/overview/loading.tsx` | `OverviewSkeleton` |
| `src/app/w/[slug]/processes/loading.tsx` | `PageSkeleton title="Processes"` + `ListSkeleton` |
| `src/app/w/[slug]/p/[processId]/loading.tsx` | `ProcessPageSkeleton` |
| `src/app/w/[slug]/p/[processId]/edit/loading.tsx` | `EditorSkeleton` |
| `src/app/w/[slug]/p/[processId]/history/loading.tsx` | `PageSkeleton title="History"` + `TableSkeleton columns={4}` |
| `src/app/w/[slug]/p/[processId]/first-principles/loading.tsx` | `PageSkeleton title="First principles"` + `FormSkeleton` |
| `src/app/w/[slug]/issues/loading.tsx` | `PageSkeleton title="Issues" eyebrow="Improve"` + `ListSkeleton` |
| `src/app/w/[slug]/issues/[number]/loading.tsx` | issue-page shape: breadcrumb line, title, `MapSkeleton height={256}`, two field cards |
| `src/app/w/[slug]/solutions/loading.tsx` | `PageSkeleton title="Solutions" eyebrow="Improve"` + `CardGridSkeleton` |
| `src/app/w/[slug]/solutions/[id]/loading.tsx` | solution-page shape: title, verdict card, two `MapSkeleton height={256}` side by side on `lg` |
| `src/app/w/[slug]/blocks/loading.tsx` | `PageSkeleton title="Block library" eyebrow="Improve"` + `CardGridSkeleton` |
| `src/app/w/[slug]/suggestions/loading.tsx` | `PageSkeleton title="Suggestions" eyebrow="Improve"` + `ListSkeleton` |
| `src/app/w/[slug]/people/loading.tsx` | `PageSkeleton title="People" eyebrow="Company"` + `TableSkeleton` |
| `src/app/w/[slug]/forecast/loading.tsx` | `PageSkeleton title="Forecast" eyebrow="Company"` + chart block (`Skeleton h-[320px]`, the forecast chart's own fallback) |
| `src/app/w/[slug]/settings/loading.tsx` | `PageSkeleton title="Settings" eyebrow="Company"` + `SettingsSkeleton`; it also covers `access`, `ai`, `branding`, `calibration`, `levers` (nearest `loading.tsx` wins, so those get the same skeleton; that is fine) |
| `src/app/w/[slug]/share/loading.tsx` | `PageSkeleton title="Share links" eyebrow="Company"` + `TableSkeleton columns={4}` |
| `src/app/w/[slug]/restore/loading.tsx` | `PageSkeleton title="Restore a backup"` + `FormSkeleton` |

Check each title and eyebrow against the real page's `Page` props before you write it. Read
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md` first: a `loading.tsx` wraps the
page and everything below it in `<Suspense>`, and sits inside the segment's `layout.tsx`, so the sidebar stays.

**Demo routes get no `loading.tsx`**: their pages read fixtures in memory and render at once. `/settings/tokens` and
the agency list (`app/page.tsx`) are outside the workspace shell: give `src/app/settings/tokens/loading.tsx` a
`FormSkeleton` inside the same `main` frame as its page; leave `app/page.tsx` alone (it redirects).

### 1e. Coverage test: `apps/web/test/loading-coverage.test.ts`

Walks `src/app/w/[slug]` and fails, naming the folder, when a folder with a `page.tsx` has no `loading.tsx` of its own,
except the settings subfolders (`access`, `ai`, `branding`, `calibration`, `levers`), which are listed in the test with
the reason "inherit settings/loading.tsx". Also asserts each `loading.tsx` imports from `@/components/shell/skeletons`
or `@/components/sources/sources-library` and exports a default function, and that none imports from `@/lib/data`,
`@/lib/supabase` or anything with `"use server"` (a loading state loads nothing).

## Part 2 (PR 2a): empty states

### 2a. `src/components/shell/empty-state.tsx` (new)

```tsx
/** A list, chart or map with nothing to show yet (issue #44): one sentence, and optionally what to do next. */
export function EmptyState({ title, children, action, className, ...rest }: { title?: string; children: ReactNode; action?: ReactNode; className?: string } & Omit<ComponentProps<"div">, "title">)
```

Classes: `rounded-token border border-dashed border-line p-6 text-sm text-muted-foreground` (the most common existing
empty state: `processes-table.tsx:60`, `company-history-view.tsx:35`, `workspace-overview.tsx` `EmptyOverview`).
`title` renders as `<p className="font-medium text-fg">`; `action` sits below in a `mt-3 flex gap-2` row. Root has
`data-empty`. Use it **only** for the new empty states below. Don't migrate the existing ones (that's restyling).

### 2b. The four gaps

| Where | Condition | Shows |
|---|---|---|
| `ProcessCanvas` (`process-canvas.tsx`) | read-only (`editor === null`) and the bundle has no steps but start/end (use `processSteps`/`bundle.steps` filtered by `kind !== "start" && kind !== "end"`; check how the canvas counts them) | inside the map area, centred: `EmptyState` "Nothing to draw yet: this process has no steps." plus, when an `emptyAction` prop is given, that node (the process page passes an "Open in Editor" link when `editHref` exists). Copy the wording from `processes-table.tsx:208`. |
| `components/people-page.tsx:375` | `!onlyOwn && rows.length === 0` | `EmptyState` "No people yet. Add them in Settings, People." with a link to the settings people heading when the page has a settings href (check what it receives; if none, no link) |
| `components/overview/charts.tsx` `MrrChart` | `points.length === 0` | return `<p className="text-sm text-muted-foreground" data-empty>No months to show yet.</p>` before any indexing (the trend charts' pattern, `trend-charts.tsx:109`) |
| `components/utilisation-bars.tsx` `UtilisationBars` | no roles to draw | the same `data-empty` paragraph: "No roles to show. Add roles in Settings." |

Re-check the audit table above while you build: if you find another list, chart or map with no empty state, add one in
the same way and list it in the PR. If you find one of the "already handled" ones is wrong, report it; don't fix it.

### 2c. Stories (PR 2a)

- `stories/shared/skeletons.stories.tsx`, title `Shared/Skeletons`: one story per page skeleton (`Overview`,
  `ProcessPage`, `Editor`, `Settings`, `List`, `CardGrid`, `Table`, `Form`), each tagged `visual-phone`. `Page` needs
  the shell: wrap in `SidebarProvider` as `stories/shared/shell.stories.tsx` does.
- `stories/map/map-placeholder.stories.tsx`, title `Map/Placeholder`: `MapSkeleton`, and a `FirstRun` story that renders
  `ProcessCanvas` with the Northbeam fixture bundle and `computing` (copy how `stories/map/process-canvas.stories.tsx`
  mounts the canvas, including its `data-visual-pending` handling), tagged `visual-phone`.
- `stories/shared/empty-state.stories.tsx`, title `Shared/EmptyState`: plain, with a title, with an action; and an
  `EmptyMap` story (`ProcessCanvas` read-only with a bundle whose steps are only start and end).
- Add to `SHARED` in `test/stories-coverage.test.ts`: `["shell/skeletons", <each export>]`, `["shell/empty-state",
  "EmptyState"]`, `["map/map-placeholder", "MapSkeleton"]`, `["map/map-placeholder", "FirstRunStatus"]`.
- After the push, approve with `[visual-update]` (new stories have no baseline). Check in the PR's PNGs that only the new
  stories and the dialog/sheet stories changed. In 2a nothing else should move.

---

## Part 3 (PR 2b): dark mode

### 3a. Tokens (`src/styles/tokens.css`, `src/app/globals.css`)

Add to `:root`, to the `@media (prefers-color-scheme: dark)` block **and** to `:root[data-theme="dark"]` (all three;
the file keeps them in step by hand):

| Token | Light | Dark | Used by |
|---|---|---|---|
| `--crit-fg` | `#ffffff` | `oklch(0.145 0 0)` (the dark `--bg`) | text on `bg-crit` |
| `--overlay` | `rgba(0, 0, 0, 0.1)` (today's `bg-black/10`) | `rgba(0, 0, 0, 0.5)` | dialog and sheet backdrops |
| `--scrim` | `rgba(0, 0, 0, 0.45)` (today's tour value) | `rgba(0, 0, 0, 0.65)` | the Editor tour spotlight |

In `globals.css` `@theme inline`, add `--color-crit-fg: var(--crit-fg);` and `--color-overlay: var(--overlay);`.
`--scrim` is used in a `style` (`boxShadow`), so it needs no theme colour.

Light values are today's values, so **no light screenshot moves**. Dark dialog and sheet stories will move (a visible
backdrop): intended.

`src/lib/branding/branding.ts` writes a client's accent into both themes; it does not touch these three. Leave it.

### 3b. Replace the raw colours

- `step-issue-badges.tsx:46`, `process-canvas.tsx:487`, `scenario-library.tsx:164`: `text-white` → `text-crit-fg`.
- `ui/dialog.tsx:42`, `ui/sheet.tsx:40`: `bg-black/10` → `bg-overlay`. (These are vendored shadcn files; the
  `ui-tokens` test already guards them.)
- `editor-tour.tsx:133`: `"0 0 0 9999px rgba(0,0,0,0.45)"` → `"0 0 0 9999px var(--scrim)"`.

### 3c. The raw-colour test: `apps/web/test/raw-colours.test.ts`

Scans every `.ts`, `.tsx` and `.css` file under `apps/web/src` (not `prototype/`, not `stories/`, not `test/`) and fails,
naming file and line, on:

1. a hex colour: after removing `//` line comments and `/* */` block comments, the regex
   `/(?<=["'`(\[:,=\s])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9A-Za-z_-])/`;
2. a colour function: `/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/`;
3. a Tailwind palette colour class:
   `/\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|caret|accent|placeholder|shadow)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/`;
4. a named colour in a `style`, `fill=` or `stroke=` (`white`, `black`): `/(?:fill|stroke|color|background(?:Color)?)\s*[=:]\s*["'{]\s*["']?(?:white|black)\b/`.

Allow-list (each entry is a path plus a reason string, printed when the test is run with `--reporter verbose`):

- `src/styles/tokens.css`: the tokens themselves.
- `src/lib/export/map-image.ts`: the exported PNG is always light.
- `src/lib/branding/contrast.ts`: contrast maths on the token values.
- Lines matching `/like #[0-9a-fA-F]{6}/` (help text that shows how to type a colour).

The test has a self-check block: a list of strings that must match (`"bg-white"`, `"text-slate-500"`, `"#fff"`,
`"'#1baf7a'"`, `"rgba(0,0,0,.4)"`, `"oklch(0.5 0 0)"`, `"fill=\"white\""`) and must not (`"issue #104"`, `"(#173)"`,
`"bg-panel"`, `"text-crit-fg"`, `"var(--accent)"`, `"#123 adds"` inside a comment). Keep `ui-tokens.test.ts` as it is.

### 3d. Dark-surface browser check

In the e2e suite (Part 5), `dark.spec.ts`: at 1280 x 800 with `colorScheme: "dark"`, on every demo route, collect every
visible element whose computed `background-color` has alpha > 0.5 and relative luminance > 0.6, and every visible text
node whose computed `color` has luminance < 0.1 where its nearest opaque background also has luminance < 0.1 (dark on
dark). Fail listing them, except elements inside `[data-allow-light]`. Mark the two logo tiles
(`workspace-switcher.tsx:41`, `branding-settings.tsx:236`, class `bg-logo-tile`) with `data-allow-light` (a client logo
always sits on white, issue #34). Parse colours with `getComputedStyle` (Chromium returns `rgb()`/`rgba()`/`oklch()`/
`color(srgb …)`; handle all four or convert with a 1 x 1 canvas `fillStyle` read-back). If this finds real problems, fix
them with existing tokens and list them in the PR.

---

## Part 4 (PR 2b): phones are read-only

**Definition:** a phone is a viewport **under 640 px wide** (Tailwind `sm`). 640 px and wider (tablets, small laptops)
keep every feature. Width only: a phone turned sideways (over 640 px) gets the tablet layout (Q2).

### 4a. `src/hooks/use-mobile.ts`: add `useIsPhone`

Same file, same `useSyncExternalStore` pattern, query `"(max-width: 639px)"`, exported as `PHONE_QUERY` and
`useIsPhone()`. Server snapshot `false`. Leave `useIsMobile` alone.

### 4b. The Editor: `src/components/editor/editor-phone-gate.tsx` (new, `"use client"`)

```tsx
/** The Editor needs a wider screen (issue #44: phones are read-only). Under 640 px it shows a notice instead of its children. */
export function EditorPhoneGate({ backHref, children }: { backHref: string; children: ReactNode })
```

Under 640 px it renders, instead of `children`, a `Page`-less block: `ShellHeader title="Editor"` then
`EmptyState` (from 2a) with title "Editing needs a wider screen" and "Open this on a tablet or computer to edit the
process. On a phone you can read everything." and an action `Button asChild variant="outline"` linking to `backHref`
("Back to the process"). `data-phone-gate`. Otherwise it renders `children`.

Wrap both Editor entries: `src/app/demo/edit/page.tsx` (`backHref` = its `back`) and
`src/components/editor/workspace-editor-page.tsx` (`backHref` = the exit href it already computes; check
`exitHref` in `lib/editor/modes.ts`). The Block library's "new block" opens the Editor too and is covered by the same
gate.

Accepted: on a phone the server renders the Editor's HTML and the gate swaps it for the notice right after hydration
(the server can't know the width). Say so in a comment.

### 4c. Edit entry points: hidden under 640 px

Add to `src/lib/phone.ts` (new):

```ts
/** On a phone (under 640 px) the app is read-only (issue #44): add this to every control that changes something. */
export const EDIT_ONLY = "max-sm:hidden";
```

Every button, link or menu item that **changes** workspace data, or opens a screen or dialog whose purpose is to
change it, gets `EDIT_ONLY` in its `className` and the attribute `data-edit-entry`. Reading controls stay: navigation,
filters, tabs, the horizon picker, playback, zoom, Expand, Export (CSV, PNG, PDF), History, the (i) help, version links,
"Explain this run".

Start from this list (found by grepping for the labels), then sweep with the e2e test in 5b, which fails on anything
missed:

- `process-page.tsx`: "✎ Open in Editor"; the empty-map "Open in Editor" from 2b; the Share button.
- `process-issues.tsx`, `issues-register.tsx`, `issues-page.tsx`: "+ New issue", Acknowledge, Edit, Resolve, the build
  links in `IssueTrackView`.
- `insights.tsx`, `findings/analysis-panel.tsx`, `findings/finding-dialog.tsx` trigger, `ai/ai-review-panel.tsx`:
  Analyse, Accept, Dismiss, "Add a finding".
- `issues/issue-page.tsx`, `issues/resolve-dialog.tsx` trigger: Edit, Resolve, Reopen, "Build a solution".
- `solutions/solutions-list.tsx` (`NewSolutionButton`), `solutions/delete-solution.tsx`, `solutions/solution-page.tsx`
  (Publish, Edit, Delete).
- `processes/processes-page.tsx`, `processes/processes-list.tsx`, `new-process-dialog.tsx` trigger,
  `processes/upload-process-dialog.tsx` trigger, `processes/archived-banner.tsx` (Restore), the row admin menu.
- `blocks/block-library.tsx`: "New block", Delete, Rename.
- `suggestions-review.tsx`, `proposals-review.tsx`, `idea-card.tsx`: Accept, Reject, Build it, Dismiss, Reply.
- `sources-page.tsx`, `sources/link-chips.tsx` and `sources/linking.tsx` ("+ Link a source", unlink), the source
  dialog's Edit and Delete.
- `forecast/plan-bar.tsx`, `forecast/forecast-view.tsx`: New plan, Save, Rename, Delete, marker drag handles (on a phone
  the timeline is read-only: pass `readOnly` if the component already has such a prop; otherwise hide the add-marker
  controls with `EDIT_ONLY`).
- `history/history-view.tsx`, `history/company-history-view.tsx`, `history/version-dialogs.tsx` triggers: Restore this
  version, Discard draft.
- `first-principles/first-principles-card.tsx` and `first-principles-flow.tsx`: Edit and the field inputs (the flow page
  is a form: wrap its body in `PhoneReadOnly`, 4d).
- `overview/overview.tsx`: "Edit the company map" (`companyEditHref`), Analyse.
- `share/share-dialog.tsx` (`ShareButton`), `save-run.tsx`, `levers/saved-scenarios.tsx`, `scenario-library.tsx`.
- `people-page.tsx`: any edit link to Settings people.
- `shell/workspace-switcher.tsx`: "New workspace" if present.

Don't hide controls inside the Editor (the gate covers it) or on `/s/[token]` (already read-only; a play link's "Send
this idea" stays: a visitor may only have a phone, Q3).

### 4d. Forms: `src/components/shell/phone-read-only.tsx` (new, `"use client"`)

```tsx
/** Disables every control inside on a phone (issue #44), with one line saying why. Wrap form bodies, not whole pages. */
export function PhoneReadOnly({ children }: { children: ReactNode })
```

Renders `<fieldset disabled={isPhone} className="contents" data-phone-read-only={isPhone || undefined}>`, preceded on a
phone by one `PhoneNotice`: `<p className="rounded-token border border-line bg-panel-2 px-3 py-2 text-xs text-fg-2"
data-phone-notice>Read only on a phone. Open this on a tablet or computer to make changes.</p>` (classes from the
"Viewing live" pill family; no new style). Export `PhoneNotice` too.

`fieldset disabled` disables every input, select, textarea and button inside, including (i) help buttons in those
forms: accepted (the help text is also in the field's description; Q4).

Wrap:
- `src/app/w/[slug]/settings/section.tsx` `SettingsSection`: wrap the `CardContent` children (one notice per page, not
  per card: give `PhoneReadOnly` a `notice={false}` prop for sections and put one `PhoneNotice` (phone only) at the top
  of the Settings page body in `settings/page.tsx`).
- the bodies of: `components/levers/levers-settings.tsx`, `components/ai/ai-settings.tsx`,
  `components/branding/branding-settings.tsx`, `components/calibration/*-panel.tsx` and `import-wizard.tsx` (wrap at the
  page level in `settings/calibration/page.tsx` and `demo/settings/calibration/page.tsx` instead if simpler),
  `settings/access/page.tsx`'s forms, `restore/restore-backup.tsx`, `share/share-dialog.tsx`'s form (the list stays
  readable), `app/settings/tokens/create-token-form.tsx`, `first-principles/first-principles-flow.tsx`.

### 4e. Stories (PR 2b)

- `stories/shared/phone.stories.tsx`, title `Shared/Phone`: `PhoneNotice`; `PhoneReadOnly` around a few `fields`
  (`TextField`, `NumberField`, `ToggleField`) tagged `visual-phone` (at 400 px they render disabled with the notice; at
  1280 px enabled); `EditorPhoneGate` with a dummy child, tagged `visual-phone`.
- Add `["shell/phone-read-only", "PhoneReadOnly"]`, `["shell/phone-read-only", "PhoneNotice"]`,
  `["editor/editor-phone-gate", "EditorPhoneGate"]` to `SHARED`.
- Existing stories tagged `visual-phone` that contain an edit control (e.g. `Shared/Shell` `PageHeader` with "New
  solution", `Shared/Solutions`) will change at 400 px only if those controls get `EDIT_ONLY`. Stories use their own
  buttons, so most won't. Approve what moves with `[visual-update]` and list it in the PR.

---

## Part 5 (PR 2b): the e2e suite and CI

### 5a. Files

- `apps/web/playwright.e2e.config.ts` (new): copy the shape of `playwright.visual.config.ts` without the baseline
  checks and snapshots. `testDir: "./e2e"`, `fullyParallel: true`, `workers: process.env.CI ? 2 : 1`, `retries: 0`,
  `timeout: 60_000`, `use: { baseURL: "http://127.0.0.1:3210", locale: "en-GB", timezoneId: "Europe/London",
  launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined } }`, `webServer: { command: "pnpm exec next
  start -p 3210 -H 127.0.0.1", url: "http://127.0.0.1:3210/demo", reuseExistingServer: !process.env.CI, timeout:
  60_000, env: { NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" } }` (empty Supabase settings
  force demo mode: `lib/supabase/env.ts` treats `""` as unset). It needs a finished `next build`; a build made with
  Supabase settings inlines them, so build without them (CI does).
- `apps/web/package.json`: `"e2e": "playwright test -c playwright.e2e.config.ts"`.
- `apps/web/e2e/routes.ts`: `DEMO_ROUTES: { path: string; route: string }[]`, one entry per `src/app/demo/**/page.tsx`
  (`route` is the file's route pattern, `path` a concrete URL: the Northbeam pipeline id is
  `c0000000-0000-4000-8000-000000000001`, issue `1`). `/demo/solutions/[id]` has no sample solution (the demo's
  solutions live in the tab and start empty): list it in `SKIPPED` with that reason. Add `/privacy` as an extra path.
- `apps/web/e2e/phone.spec.ts`, `tablet.spec.ts`, `dark.spec.ts`, and a helper `apps/web/e2e/checks.ts`.
- `apps/web/test/e2e-routes.test.ts` (vitest): every `src/app/demo/**/page.tsx` is in `DEMO_ROUTES` or `SKIPPED`.
- tsconfig and ESLint already include every `.ts` file under `apps/web`, so `e2e/` is type-checked and linted with no
  change (check that `pnpm typecheck` and `pnpm lint` see it).
- `.github/workflows/ci.yml`, job `check`, after `- run: pnpm --filter @transpera-flow/web build`:
  `- run: pnpm --filter @transpera-flow/web e2e`. The job already installs Chromium for `playwright-core` 1.63.0,
  the same version `@playwright/test` uses. Upload `apps/web/playwright-report` on failure (copy the `visual` job's
  upload step, artifact name `e2e-report`).
- `.gitignore`: nothing new (`test-results/` and `playwright-report/` are ignored).

### 5b. What each spec checks

For every route, after `goto` with `waitUntil: "networkidle"`, wait until no `[data-first-run]` and no
`[role=status][data-loading]` is visible (timeout 20 s), then:

**`phone.spec.ts`** at 400 x 900, light:
1. **No sideways scroll:** `document.documentElement.scrollWidth <= clientWidth`.
2. **Nothing escapes the screen:** no visible element whose right edge is past `clientWidth + 1`, unless it is
   `position: fixed`, `.sr-only`, inside `.react-flow`, or has an ancestor with `overflow-x` other than `visible` whose
   own right edge is inside the screen (it is clipped or scrolls in its frame). (`checks.ts` holds this; it is the
   probe I ran for the audit.)
3. **Read only:** no visible `[data-edit-entry]`; no enabled `input, select, textarea` inside a
   `[data-phone-read-only]`; and no visible, enabled `button`, `a` or `[role=menuitem]` whose accessible name matches
   `/^(\+ |✎)|open in editor|new (issue|process|solution|block|plan|workspace)|upload|acknowledge|resolve|analyse|accept|dismiss|reject|build|link a source|delete|archive|rename|publish|restore|discard|save/i`
   outside `[data-allow-on-phone]` (put that attribute on a control the regex catches wrongly, with a comment saying
   why).
4. On `/demo/edit`: `[data-phone-gate]` is visible and `.react-flow` is not.
5. No console errors or page errors (copy the listener from `visual/stories.spec.ts`).

**`tablet.spec.ts`** at 768 x 1024 and 1024 x 768: checks 1, 2 and 5; `/demo/edit` shows `.react-flow` and no
`[data-phone-gate]`; the process page shows "Open in Editor"; no `[data-phone-notice]` anywhere.

**`dark.spec.ts`** at 1280 x 800, `colorScheme: "dark"`: check 5 and the dark-surface check from 3d.

**Sanity:** `phone.spec.ts` also loads the process page at 1280 px and asserts the read-only regex **does** find
"Open in Editor" there, so the check can't pass by matching nothing.

---

## Patterns to copy

- Skeleton page: `src/app/w/[slug]/sources/loading.tsx` and `SourcesLibrarySkeleton` (`components/sources/sources-library.tsx:264`).
- Dynamic map with a fallback: `components/processes/processes-table.tsx:16`.
- Empty states: `processes-table.tsx:60` (dashed card), `trend-charts.tsx:109` (chart paragraph with `data-empty`).
- Overlay chip on the map: the diff legend, `process-canvas.tsx:1643`.
- matchMedia hook: `hooks/use-mobile.ts`.
- Coverage-style tests: `test/stories-coverage.test.ts`; source-text tests: `test/ui-tokens.test.ts`.
- Playwright config and console-error listener: `playwright.visual.config.ts`, `visual/stories.spec.ts`.
- Stories with the map: `stories/map/process-canvas.stories.tsx` (`data-visual-pending`).

## Edge cases

- **Second and later runs** don't show `FirstRunStatus` (`sim.run` is set); a model that fails (`status: "error"`)
  hides it (the page's error alert takes over).
- **A model that can't be built** (`useEngineModel` returns an error, `model === null`): `useSimulation` never runs and
  stays `running` with `run: null`. Pass `computing` only when `model !== null`, or the chip spins forever next to "This
  process can't be simulated yet".
- **Reduced motion:** `Skeleton` and the first-run dot stop pulsing; the chip text still says it is running.
- **Share pages** (`/s/[token]`) render the process page and Overview through `components/share/shared-view.tsx`: they
  get `FirstRunStatus` too (it's the same component), which is right. They are read-only already; `EDIT_ONLY` controls
  don't render there anyway.
- **Readonly members and viewers** already see no edit controls; `EDIT_ONLY` on a control that isn't rendered changes
  nothing.
- **`PhoneReadOnly` and server actions:** a disabled fieldset stops clicks, not a save already in flight. Nothing to do.
- **Rotating a phone** from 400 to 800 px re-enables everything live (the hook listens to `change`).
- **The Editor tour** (`editor-tour.tsx`) never runs on a phone (the gate). Its spotlight uses `--scrim` everywhere else.
- **Branding:** a client's accent (`lib/branding/branding.ts`) rewrites `--accent` and friends; the new tokens don't
  depend on the accent.
- **Print / PDF reports** (ADR 0010): untouched; they don't use `dark`.

## Tests

PR 2a:
- `test/loading-coverage.test.ts` (1e).
- Unit (vitest, existing browser-harness style if a render is needed): `MrrChart` with `points=[]` renders the empty
  paragraph and doesn't throw; `UtilisationBars` with a model with no roles renders its empty paragraph.
- Browser harness test (`test/map-harness/entry.tsx` mounts `ProcessCanvas` for `test/map-browser.test.ts`; add a
  query-string switch there and cases in that test): `computing`
  shows `[data-first-run]`, and a read-only canvas with no steps shows `[data-empty]` while an editable one doesn't.
- `stories-coverage` passes with the new `SHARED` entries; `visual` passes after `[visual-update]`.

PR 2b:
- `test/raw-colours.test.ts` (3c), including its self-check.
- `test/e2e-routes.test.ts` (5a).
- The e2e suite (5b), run locally against a build: `pnpm --filter @transpera-flow/web build && pnpm --filter
  @transpera-flow/web e2e`, twice, to show it's stable.
- A unit test for `useIsPhone`'s query string (`PHONE_QUERY === "(max-width: 639px)"`), and the browser harness test:
  `PhoneReadOnly` at 400 px disables a text field and shows `[data-phone-notice]`, at 1024 px doesn't.
- `visual` passes after `[visual-update]`.

Both PRs: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @transpera-flow/web build`, and the
builder-brief's light/dark screenshots at 1440 and 400 px of the pages touched, attached to the PR as text evidence.

## Out of scope

- The onboarding wizard ("skip it for now"), the Supabase backup-restore check, and Sentry (its own brief).
- Any restyle: new colours beyond the three tokens, spacing, typography, motion beyond the existing pulse, migrating the
  existing empty states to `EmptyState`. Austin's visual pass.
- A theme switch in the app.
- A phone layout for the map (it already fits and pans), or a mobile card layout for wide tables (they scroll in their
  frame, Q1).
- `loading.tsx` for demo routes; `error.tsx` files (the Sentry brief adds them).
- Changing `useIsMobile` or the sidebar breakpoint.
- Visual regression for whole pages (`docs/visual-regression.md`, "Not covered yet").

## Done when

PR 2a:
- [ ] Every page folder under `src/app/w/[slug]` has a `loading.tsx` (or inherits settings'), checked by a test.
- [ ] Skeletons match each page's first screen (screenshot each skeleton next to its page at 1440 and 400 px in the PR).
- [ ] Maps that load late show `MapSkeleton`; a map whose first run is computing shows "Running the first simulation…".
- [ ] The four empty-state gaps are filled; `MrrChart` no longer throws on an empty series.
- [ ] New stories exist and are approved; `Skeleton` stops under reduced motion.

PR 2b:
- [ ] No raw colour outside the allow-list (test); `--crit-fg`, `--overlay`, `--scrim` in all three token blocks.
- [ ] The dark crawl finds no light surface and no dark-on-dark text on any demo page.
- [ ] At 400 px: no sideways scroll, nothing escapes, no edit control visible or enabled, the Editor shows the notice.
- [ ] At 768 and 1024 px: everything works, including the Editor.
- [ ] The e2e suite runs in CI's `check` job after the build and passes.
- [ ] Stories added and approved; `README.md` "Checks" mentions `pnpm --filter @transpera-flow/web e2e` (needs a
      build first) and `docs/visual-regression.md` gets one line pointing to it.

## Open questions (each with the default the builder uses)

1. **Wide tables on a phone** (issues, People, history): scroll inside their own frame, or turn into stacked cards?
   **Default: scroll in the frame**, as today. The page itself never scrolls sideways, which is what the criterion says;
   stacked cards are a layout decision for Austin's pass.
2. **What counts as a phone:** width under 640 px only, or also touch devices up to 1023 px? **Default: width under
   640 px.** Tablets and phones turned sideways keep editing ("tablet stays fully usable").
3. **Play links on a phone:** a visitor's "Send this idea" on `/s/[token]` is a write. **Default: keep it** on phones;
   it's the visitor's only way to respond and it's already limited and checked (D48).
4. **(i) help inside disabled phone forms** can't be opened. **Default: accept.** Field descriptions carry the same
   text; the visual pass can revisit.
5. **Dark `--overlay` at 0.5 and `--scrim` at 0.65:** **Default: those values** (the shadcn dark convention). Light
   values don't change.
6. **`--crit-fg` in light stays white** (3.9:1 on `#e34948`, under 4.5:1 for the small bold badge text). **Default:
   leave light as it is**; it's a visual call for Austin's pass. Dark gets the fix because white there is 3.7:1 and the
   same pattern (`--edit-fg`) already uses dark text.
7. **Demo `loading.tsx`:** **Default: none** (the demo renders at once).
8. **A theme toggle:** **Default: none**; the app follows the OS.

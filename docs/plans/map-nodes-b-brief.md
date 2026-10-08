# Map nodes: rating tile (option B), build brief

Scoped 8 Oct 2026 against `origin/main` at 53835548 (handover #241). Read `docs/plans/builder-brief.md` first (its GitHub,
branch and commit rules apply). This brief wins where they differ. Build strictly from it. If the code doesn't match what
this brief says, **ask; don't guess.** Every open question has a default below (Defaults taken): use it. Austin is away.

Issue: #242 (sub-issue of Milestone C, #3). Branch: `claude/map-nodes-b` (this brief is on it; `git merge origin/main` first). One PR. No migration, no engine change,
no database or snapshot change. Commit and push after every numbered build step.

---

## 1. Goal

Austin's decision (handover "Map node design: pick A (ledger card), B (rating tile) or C (capsule) from the prototype"),
verbatim:

> for the UI, i like the tile look option B

The prototype is https://claude.ai/artifact/Tsk94fmnFB4MPj66xxTihd ("Map Node Designs", tab "B · Tile"). Option B's own
note:

> Optimises for the read-only process page: "where does it hurt?" in one glance. The whole tile takes its rating colour,
> as PRD §8.3 asks. One headline number says why it got that rating; the rest is in the step's detail. Zoomed out, the map
> becomes a heat map.

PRD §8 item 3 asks for "bigger nodes coloured by rating … and red badges only for confirmed issues". Today a step card is
a white card with a 6 px rating stripe; B fills the whole tile with the rating's soft tint, edges it in the rating colour,
names the rating in words at the top, and gives one headline number.

**What "the tile look" means here:** B's anatomy, colours and states, at a footprint that keeps existing maps laid out.
Austin picked a look, not new data: every number on a tile is one the map already receives (section 3).

## 2. The short version

1. Redraw the three node kinds in `apps/web/src/components/process-canvas.tsx` (`StepNode`, `TerminalNode`, `GroupNode`
   closed) as B tiles: rating row, name, headline row, foot. Same width as today (192 px); a little taller (section 5.1).
2. The headline is the run's **queue wait** for a staffed step (`result.steps[id].avgWait`, with `avgQueue`), or the
   step's **planned wait** for a step nobody works (decision, wait, no role). `—` when there is no value. Nothing else.
3. Edge pills: Bottleneck flag and draft labels on the top-left edge, the issue count on the top-right edge, Conflict and
   Assumption on the bottom-left edge.
4. Restyle the issue badge (`StepIssueBadges`) and the closed group's count as B's "N issues" pill, in an AA-contrast red.
5. Draw the same tiles in the map image export (`lib/export/map-image.ts`), without the headline (the export has no run).
6. Update the size constants, one stale literal, the focus-ring CSS, and the tests; add two stories; approve the baselines
   with `[visual-update]`.

---

## 3. Where a process-map node is drawn today (inventory)

Every screen below draws nodes through **one** set of components, `StepNode`, `TerminalNode` and `GroupNode` in
`apps/web/src/components/process-canvas.tsx` (registered as `nodeTypes = { step, terminal, group }`, line ~767), fed by the
`nodes` `useMemo` in `Canvas` (~1052–1204). Changing those three changes every screen.

| Screen | File (call site) | What the canvas is given | Notes |
|---|---|---|---|
| Process page (workspace, demo, share, play) | `components/process-page.tsx:381` | `result`, `openIssues`, `rating`, `stepExtras`, `highlight`, `computing` | Badges via `issuesUi.badges` (`StepIssueBadges` portal, `components/process-issues.tsx:302`). Archived processes and history versions open this page read-only. |
| Process view (Larkspur demo, older view) | `components/process-view.tsx:512` | same, plus `editor` when editable | |
| Editor (process and company map) | `components/editor/editor-view.tsx:431` | `result` (draft run), `editor`, `diff`, `highlight`; **no `rating`, no `openIssues`** | `handoffs` on the company map. |
| Overview company map | `components/overview/overview.tsx:532` | `result` (horizon run), `openIssues`, `rating`, `highlight`, `handoffs`, `computing` | Process cards are closed `GroupNode`s (holders with `child_process_id`). Also in share snapshots. |
| Issue page map | `components/issues/issue-page.tsx:230` | `openIssues`, `rating`, `highlight`; no `result` | Badges via `StepIssueBadges` (`MapWithBadges`). Also in share snapshots. |
| Solution compare (live vs solution) | `components/solutions/solution-compare.tsx:167` | `diff` on the solution side; no `result`, no `rating` | Also in share snapshots (`SolutionPage`). |
| Processes list preview | `components/processes/processes-table.tsx:231` | `openIssues`, `rating`; no `result` | No `StepIssueBadges` here today; stays so. |
| Share and play links | `components/share/shared-view.tsx` → `Overview`, `ProcessPage`, `IssuePage`, `SolutionPage` | the redacted `ShareSnapshot` only | Same components, `mode="share"`. |
| Map image export (PNG/SVG) | `lib/export/map-image.ts` `buildMapImage`, called by `components/export/export-menu.tsx` | steps, edges, `rating`, `issues`, `who` | Draws its own SVG cards. |
| Issue count badges | `components/step-issue-badges.tsx` | portal into `.react-flow__node[data-id]` | Process page and issue page only. |
| Playback badges and pulse | `components/playback-layer.tsx`, `.bottleneck-pulse` in `app/globals.css` | node positions from the store | Out of scope except the pulse's radius. |
| Loading skeleton | `components/map/map-placeholder.tsx` `MapSkeleton` | none | Out of scope (grey shapes, not nodes). |
| Block library thumbnails | `components/blocks/block-map.tsx` `BlockMap` | a block's steps | Out of scope (tiny SVG outline boxes, not map nodes). |
| Stories | `stories/map/process-canvas.stories.tsx` (ReadOnly, GroupsOpen, Highlight, CompanyMap, Editable), `stories/map/map-placeholder.stories.tsx` (FirstRun), `stories/shared/empty-state.stories.tsx` (EmptyMap) | fixtures in `stories/fixtures.ts` | Baselines in `apps/web/visual/__screenshots__/`. |

Size constants that assume today's card: `apps/web/src/lib/map/groups.ts` (`CARD_SIZE` 192×92, `TERMINAL_SIZE` 96×34,
`GROUP_CARD` 192×124), a literal `{ width: 192, height: 92 }` and `192` in `apps/web/src/lib/overview/company-map.ts:114`
and `:160`, `COMPANY_CARD` 192×124 in `packages/db/src/company-map.ts`, MCP placement (240 px columns, 140 px rows) in
`packages/mcp/src/building.ts` `placeStep`/`layoutSteps`, and the Editor's add-step overlap guess (180×90) in
`process-canvas.tsx` `addAt`.

---

## 4. Design spec

### 4.1 Tokens (existing CSS variables only)

All colours are existing tokens from `apps/web/src/styles/tokens.css`, which already has light and dark values (dark under
both `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and `:root[data-theme="dark"]`). **No new token,
no raw colour.** `apps/web/test/raw-colours.test.ts` must pass. Rating colours go through `RATING_STYLE` in
`apps/web/src/lib/map/rating.ts` (`stripe` = `var(--rate-*)`, `soft` = `var(--rate-*-soft)`), as `Stripe` does today.

| Use | Token (Tailwind name or inline `var()`) |
|---|---|
| Tile fill, rated | `RATING_STYLE[r].soft` (inline `background`) |
| Tile fill, unrated or no ratings on this map | `var(--panel)` (`bg-panel`) |
| Tile edge, rated | `RATING_STYLE[r].stripe` (inline `borderColor`) |
| Tile edge, unrated | `var(--line-2)` |
| Tile edge, bottleneck | `var(--crit)` (inline `borderColor`) plus `ring-[1.5px] ring-crit` |
| Rating dot | `RATING_STYLE[r].stripe`, or `var(--line-2)` unrated |
| Name, headline value | `text-fg` |
| Rating label, headline caption, foot | `text-fg-2` |
| Foot divider | inline `borderTopColor: color-mix(in oklab, <stripe or var(--line-2)> 35%, transparent)` (passes the raw-colour test: no colour literal) |
| Issue count pill, Bottleneck flag | `bg-destructive text-crit-fg` (light `#c93534` on white ≈ 5.2:1; dark `#e66767` on `oklch(0.145 0 0)` ≈ 6:1). **Not** `bg-crit`: white on `#e34948` is ≈ 3.9:1 and fails AA for 11 px text. |
| Conflict pill | `border-crit bg-crit-soft text-fg` (unchanged) |
| Assumption pill | `border-warn bg-warn-soft text-fg` (unchanged) |
| Draft labels | `border-edit bg-edit-soft text-fg`, Removed `border-crit bg-crit-soft text-crit` (unchanged) |
| Terminal fill | start and `done` ends `bg-accent-soft`, won `bg-good-soft`, lost `bg-panel-2` (today's mapping) |
| Shadow | `shadow-token` (`--shadow`); hover `hover:shadow-md` (`--shadow-overlay`) |
| Radius | `rounded-lg` (= `calc(var(--radius) + 2px)`, 12 px; the prototype's 14 px has no token) |

Dark mode needs no code: every token above has a dark value (`--rate-great-soft` `oklch(0.3 0.05 155)`, `--rate-good-soft`
`oklch(0.32 0.06 128)`, `--rate-bad-soft` → `--warn-soft` `#45360f`, `--rate-risk-soft` → `--crit-soft` `#4a2424`).

### 4.2 Step tile (`StepNode`: kinds task, decision, wait, subprocess without a child process)

Prototype markup (B, `step(s)`): `.body` (228 px, radius 14, 1.5 px rating border, rating-soft fill, padding 10/13/11),
`.rlab` (dot + rating label, 10 px uppercase), `.name` (15.5 px, 650), `.head` (`.hv` 20 px mono + `.hc` caption),
optional `.flags` row (Conflict, Assumption), `.foot` (role dot + role, `N h work` mono, divider above), `.count`
(top-right "N issues"), `.bflag` (top-left "⧗ Bottleneck") and `.pulse`.

The app's tile, top to bottom (exact classes; the builder may reorder class names but not change values):

```
<div data-lit data-tile="step" data-rating={rating ?? "none"}
     class="relative w-48 rounded-lg border-[1.5px] px-2.5 pt-2 pb-2 shadow-token transition-[box-shadow,opacity]
            hover:shadow-md motion-reduce:transition-none {bottleneck ? 'ring-[1.5px] ring-crit' : ''}
            {changeClass} {litClass} {selected ? selectedRing : ''}"
     style={{ background, borderColor }}>
  [pulse span, edge pills, Handle target]
  1. rating row   (only when the map has ratings, see "rated" below)
  2. was-name     (draft only, unchanged from today)
  3. name
  4. headline row
  5. was-wait     (draft only, staffed steps only)
  6. foot
  [Warning, Handle source]
</div>
```

1. **Rating row** `<p class="flex min-w-0 items-center gap-1.5 text-[11px] leading-[14px] font-semibold tracking-[0.06em] text-fg-2 uppercase">`
   with `<i aria-hidden class="size-2 shrink-0 rounded-full" style={{ background: dot }} />` and
   `<span class="truncate">{label}</span>`. Label: `RATING_LABELS[rating]` (engine: "Great", "Good, could improve",
   "Bad, not urgent", "Operational risk"), or **"Nothing to fix"** when the step has no rating. Never the label the
   `rating` callback returns (fixtures pass short labels).
2. **Was-name**: today's `<p class="text-[11px] leading-tight text-fg-3 line-through">`, unchanged.
3. **Name** `<p data-field="name" class="mt-0.5 text-sm leading-tight font-semibold text-fg">{step.name}</p>`. 14 px as
   today (not the prototype's 15.5 px), so names wrap exactly as they do now. Not clamped.
4. **Headline row** `<p class="mt-1 flex min-w-0 items-baseline gap-1.5" title={headline.title}>` with
   `<span data-field={staffed ? undefined : "wait_hours"} class="font-mono text-base leading-none font-medium text-fg tabular-nums">{value}</span>`
   and `<span class="min-w-0 truncate text-[11.5px] leading-4 text-fg-2">{caption}</span>`. Values in 4.3.
5. **Was-wait** (only when `data.wasWait !== null` and the step is staffed):
   `<p data-field="wait_hours" class="mt-0.5 font-mono text-[11px] text-fg-2 tabular-nums"><Was was={data.wasWait}>{formatHours(step.wait_hours)} wait</Was></p>`.
6. **Foot** `<div class="mt-1.5 flex items-baseline justify-between gap-2 border-t pt-1 text-xs text-fg-2" style={{ borderTopColor }}>`:
   left `<p data-field={person ? "person_id" : "role_id"} class="min-w-0 truncate">` with today's role dot
   (`size-2 rounded-full`, `role?.color ?? "var(--line-2)"`, shown only when there is a who), `<Was was={data.wasWho}>`
   the who, and today's `<span class="text-fg-3"> · pinned</span>` for a pinned person; right
   `<span data-field="work_hours" class="shrink-0 font-mono tabular-nums"><Was was={data.wasWork}>{work}</Was></span>`.

**Data, field by field** (all already in the `nodes` `useMemo`; nothing new is loaded):

| Element | Shows | Comes from (today) | Missing value |
|---|---|---|---|
| Fill, edge, dot, rating label | the step's rating | `rating?.(step.id)?.rank` → `ratingOfRank` → `data.rating`. The `rating` prop is `stepRatingOf(confirmedRatings(entries))` (`lib/issues/register.ts`): the worst rating among the step's **confirmed open** issues, never Great, never an unacknowledged insight (D24, D40) | no confirmed issue: "Nothing to fix", `--panel` fill, `--line-2` edge |
| `rated` (new boolean in `StepNodeData`) | whether to draw the rating row | `rating !== undefined` (the canvas prop) | Editor, solution compare, `Highlight` story: no row, no tint |
| Name | `step.name` | bundle row | never empty (validation) |
| Headline | see 4.3 | `result?.steps[step.id]` (`avgWait`, `avgQueue`), `step.wait_hours` | `—` |
| Who (foot left) | the pinned person's name, else the role's name | `data.person.name` (people come from `namedForViewer(viewerOf(bundle), bundle.people)`, so members and viewers get "Team member N" / "A team member"; a share snapshot is already redacted), `data.role.name` | today's fallbacks: "Decision", "Wait", "No role" |
| Role dot | `role.color` | `bundle.roles` | `var(--line-2)` |
| Work (foot right) | `formatHours(step.work_hours) + " work"` | bundle row | `—` when 0 (today's rule: `Number(work) \|\| wasWork`) |
| Bottleneck | flag, crit edge and ring | `result?.bnStep === step.id` (`data.bottleneck`) | no run: none |
| Pulse | while playback plays | `data.pulse` (unchanged) | |
| Issue count | "N issue(s)" pill | `StepIssueBadges` (`badges` from `mapFeed`, confirmed open issues) | none: no pill |
| Conflict, Assumption | pills | `data.conflict`, `data.estimate`, `data.quote` (unchanged) | |
| Draft | New / Changed / Removed, `Was` values | `data.change`, `wasName`, `wasWho`, `wasWork`, `wasWait` (unchanged) | |
| Warning (Editor) | "!" | `data.warning` (unchanged) | |

**Dropped from the tile** (Option B leaves them to the step's detail): the planned wait of a staffed step (except the
draft's was-wait line), the rework line "↺ 15% back to …", and today's "queue N" as its own text (it moves into the
headline caption). The screen-reader label keeps all three (see 4.8). On read-only maps the detail (`StepDetail`) already
shows Wait; add a **Rework** row there (section 6) so nothing visible today is lost.

**Prototype elements not in the app, dropped:** the per-step hand-written headlines ("82% busy", "68% lost", "4.8 h lead
to qualified"), role "% busy" (`result.roles`), the decision's "% lost", "Decision · client", the "⧗" glyph, the hover lift
(`translateY(-1px)`, it would move the handles off the edges by 1 px), and the zoomed-out compact mode (section 9).

### 4.3 The headline (one number)

A pure helper, `tileHeadline(input)` in a new file `apps/web/src/lib/map/tile.ts`, so it is unit-tested:

```ts
export interface HeadlineInput {
  staffed: boolean;            // data.role !== null || data.person !== null (today's queue condition)
  run: { avgWait: number; avgQueue: number } | null; // result?.steps[step.id] when result exists, else null
  waitHours: number;           // Number(step.wait_hours)
}
export interface Headline { value: string; caption: string; title: string; phrase: string | null }
```

| Case | `value` | `caption` | `title` (hover) | `phrase` (screen reader) |
|---|---|---|---|---|
| staffed, `run` present | `formatHours(avgWait)` | `` `waiting · queue ${formatNumber(avgQueue)}` `` | "Average time an item waits in the queue before work starts, and the average number waiting, in this run" | `` `waits ${formatHours(avgWait)} in the queue on average, average queue ${formatNumber(avgQueue)}` `` |
| staffed, no run (no `result`, still computing, or the step isn't in the result) | `—` | `waiting` | "Not simulated yet" | `null` |
| not staffed, `waitHours > 0` | `formatHours(waitHours)` | `wait` | "Planned wait at this step" | `null` (the label already says "N h wait") |
| not staffed, `waitHours` 0 | `—` | `wait` | "No wait entered" | `null` |

`avgWait` is hours an item queues before anyone starts it (`packages/engine/src/model.ts` `StepResult`; the "Waiting by
step" chart already shows it). `avgQueue` is what today's "queue N" shows. The row is always drawn, so a tile keeps its
height when the first run lands. The "Running the first simulation…" state is `FirstRunStatus` over the map (unchanged)
plus `—` in every staffed headline.

Add `avgWait: number | null` to `StepNodeData` (`result?.steps[step.id]?.avgWait ?? null`; ghosts `null`). Keep it a
number: `sameNode` compares data fields with `===`.

### 4.4 Edge pills

All absolutely positioned on the tile's border, outside the flow, so they never change a tile's size.

- **Top-left row** `pointer-events-none absolute -top-2.5 left-2.5 flex gap-1 whitespace-nowrap`, in this order:
  - **Bottleneck flag** (when `data.bottleneck` and not editing or ghost): `<span title="The bottleneck in this run" class="rounded-full bg-destructive px-2 text-[10px] leading-[18px] font-semibold tracking-[0.02em] text-crit-fg">Bottleneck</span>`.
  - **Draft label** New / Changed / Removed: today's classes from `Badges` (`rounded-full border px-1.5 text-[10px] leading-4 font-semibold`).
- **Top-right**: the issue count (read-only maps) or the Editor's Warning "!" (unchanged, `-top-2 -right-2`). They never
  meet: the Editor has no issue badges.
- **Bottom-left row** `pointer-events-none absolute -bottom-2.5 left-2.5 flex gap-1`: **Conflict**, then **Assumption**,
  today's markup and `title` text (`pointer-events-auto` on each, for the tooltip).

Split today's `Badges` into `TopPills` (bottleneck + draft label) and `FlagPills` (conflict + assumption). The prototype put
Conflict and Assumption inside the tile; on the Northbeam demo that pushes "Audit & proposal" onto the "Lost" end below it,
and on the top edge they collide with the issue count (Audit is the bottleneck, has a conflict and has issues). The bottom
edge costs no height and collides with nothing.

**Issue count pill** (`components/step-issue-badges.tsx`, and the closed group's own count): B's "N issues" pill.
`absolute -top-2.5 right-2.5 z-10 flex h-5 items-center rounded-full border-2 border-panel bg-destructive px-2 text-[11px] leading-none font-bold text-crit-fg shadow-token`,
text `` `${count} ${count === 1 ? "issue" : "issues"}` ``. Keep the button, `data-issue-badge`, `title`, `aria-label`,
`nodrag nopan`, the click and double-click handlers and the portal mechanism exactly as they are. The rating row's text
starts below the pill (`pt-2` plus the border), so they don't overlap.

### 4.5 Terminal tile (`TerminalNode`: start, end)

Prototype `terminal(s)`: 150 px tile, tone fill, `--line-2` border, "Start"/"End" label, name 14 px.

```
<div class="relative w-max min-w-24 max-w-[150px] rounded-lg border-[1.5px] border-line-2 px-2.5 py-1.5 {tone} ...">
  <p class="text-[11px] leading-[14px] font-semibold tracking-[0.06em] text-fg-2 uppercase">{step.kind === "start" ? "Start" : "End"}</p>
  <p data-field="name" class="text-[13px] leading-tight font-semibold break-words {lost ? 'text-fg-2' : 'text-fg'}"><Was was={wasName}>{step.name}</Was></p>
</div>
```

Tone as today (start and `done` `bg-accent-soft`, won `bg-good-soft`, lost `bg-panel-2`). Handles, editing (`w-44
rounded-lg border-accent bg-panel`), ghost, Badges split (4.4), Warning and `litClass` as today. No rating, no headline.

### 4.6 Closed group, child process, company-map process card (`GroupNode`, `open === false`)

Prototype `group(g)`: dashed 2 px border in the worst rating's colour, soft fill, "Worst inside: …", name, headline "4 steps"
+ "25 h work", foot "Group" + Expand, count "1 issue".

```
<div data-group="closed" class="relative w-48 rounded-lg border-2 border-dashed px-2.5 pt-2 pb-2 shadow-token ..." style={{ background, borderColor }}>
  count pill (roll.openIssues > 0), Handle target
  1. rating row (rated maps): "Worst inside: {RATING_LABELS[rating]}", or "Nothing to fix"
  2. name: <p data-field="name" title={step.name} class="mt-0.5 line-clamp-2 text-sm leading-tight font-semibold text-fg">
  3. headline: value `${roll.steps}` (font-mono text-base), caption `${roll.steps === 1 ? "step" : "steps"} · ${roll.handsOnHours ? `${formatHours(roll.handsOnHours)} work` : "no work entered"}`
  4. foot (same classes as 4.2): left "Group" | "Process" (handoffs) | "Child process" (today's words); right the Expand/Collapse toggle (groups only), today's button with `py-0 leading-4`
  Warning, Handle source
</div>
```

Data: `roll` from `rollUp` / child leaves, `data.rating` (worst inside), `worstRating` (drop the label string; use
`RATING_LABELS[data.rating]`), `roll.openIssues` (non-interactive `<span>` pill, `title="Confirmed issues on the steps
inside"`, same classes as 4.4 minus the button bits), all unchanged. The name is clamped to two lines here (and only here)
so a card never outgrows `GROUP_CARD` (124 px), which the company-map layout and nested open groups size from.

**Open group box**: unchanged (it is a frame, not a tile; out of scope).

### 4.7 States

| State | Trigger (existing data) | How it looks |
|---|---|---|
| Normal | | 4.2 |
| Hover | pointer over the node | `hover:shadow-md` only. No lift. Not in a screenshot (the suite parks the mouse). |
| Selected | `selected` (Editor, or a read-only map given `selection`) | today's `selectedRing` (`outline-2 outline-offset-2 outline-edit`) |
| Keyboard focus | `.react-flow__node:focus-visible` | today's 2 px `--fg` outline, offset 5 px; change its `border-radius` in `app/globals.css` to `calc(var(--radius) + 2px)` and make the terminal rule (today `9999px`) the same, since terminals are tiles now |
| Highlighted / dimmed | `data.lit` true / false | today's `litClass` (`!border-accent outline-2 outline-offset-1 outline-accent` / `opacity-40`); the `!` beats the inline rating `borderColor`. Solution mode's red tone (`[data-highlight-tone="issue"]` in `globals.css`) unchanged |
| Bottleneck | `data.bottleneck` | crit edge (inline), `ring-[1.5px] ring-crit`, Bottleneck flag. No border-width change, so the tile's size never changes when the bottleneck moves |
| Bottleneck, playing | `data.pulse` | today's `.bottleneck-pulse` span, `rounded-lg` instead of `rounded-token` |
| Confirmed issues | `StepIssueBadges` / `roll.openIssues` | "N issues" pill, 4.4 |
| Insights | | **never on a tile** (D24, D40: insights stay off the map until acknowledged). They show only as a highlight when hovered elsewhere |
| Utilisation | | **not on a tile** (default 13): it stays in the Utilisation tab and the People page |
| First run computing | `computing` (canvas) and `result === null` | `FirstRunStatus` chip (unchanged); staffed headlines `—` / "waiting" |
| No run at all | issue page, solution compare, processes preview, Editor before a run | staffed headlines `—` |
| Empty values | | work `—`; who fallback; headline per 4.3 |
| Archived process, history version, share, play | read-only canvas | identical to any read-only map: no special node styling (the page's banner says it) |
| Editing in place | `data.editing` | today's: `w-60 border-accent bg-panel`, no rating fill or edge, `NodeInlineEditor` replaces the content |
| Draft: new / changed / removed (ghost) | `changeClass`, `data.ghost` | today's `changeClass` (the `!` classes beat the inline edge colour); a ghost keeps today's minimal content (struck name + Restore) in a `rounded-lg border-[1.5px] bg-panel px-2.5 py-2` tile |
| Dark mode | tokens | no code (4.1) |

### 4.8 Accessibility

- **Label** (`stepLabel` in `process-canvas.tsx`, the node's `ariaLabel`): keep every part it has today (name, kind, who,
  work, wait, rework, rating, draft, conflict, assumption, warning), and add `"bottleneck"` after the rating when
  `data.bottleneck`, and `headline.phrase` after the wait when it is not null. Group `ariaLabel` (line ~1107): append
  `` `, worst inside: ${RATING_LABELS[rating]}` `` when rated and `` `, ${n} confirmed issue(s)` `` when `roll.openIssues > 0`.
  Colour is never the only cue: the rating is in words on the tile.
- **Contrast** (AA, 4.5:1 for text): names and values `--fg` on the soft tints and `--fg-2` captions on them are ≥ 5:1 in
  both themes by my arithmetic; the pills use `bg-destructive text-crit-fg` (≥ 5.2:1). Prove the pill pair and `--fg-2` on
  each `--rate-*-soft` in a unit test (section 7).
- **Focus ring**: unchanged behaviour, radius matched (4.7). The tile's own `outline` is used by selection and highlight,
  so focus stays on the React Flow wrapper as today.
- **Smallest text**: pills 10 px (as today), everything else ≥ 11 px.
- **Reduced motion**: `motion-reduce:transition-none`; the pulse already stops.

---

## 5. Constraints

### 5.1 Size, layout and routing

- **Width does not change: 192 px** (`w-48`) for step tiles and closed groups. Positions are stored per step (top-left), MCP
  lays steps out on 240 px columns, the company map on 192 + 96 px, and the demos on 230 px. B's 228 px would leave 2–12 px
  between columns and overlap edge labels. `test/map-browser.test.ts`'s hand CSS (`.w-48 { width: 12rem }`) keeps working.
- **Height grows.** Today a one-line step card measures about 76 px. A rated B tile with a one-line name measures about
  100 px (1.5 + 8 + 14 + 2 + 17.5 + 4 + 16 + 6 + 1 + 4 + 16 + 8 + 1.5), two-line names about 117 px; an unrated map (no
  rating row) about 85 / 102 px. Terminals go from about 34 px pills to about 46 px tiles (min 96, max 150 px wide). Closed
  groups stay ≤ 124 px (two-line clamp).
- **Update the constants to the measured sizes** in `lib/map/groups.ts`: `CARD_SIZE = { width: 192, height: 100 }`,
  `TERMINAL_SIZE = { width: 96, height: 46 }`, `GROUP_CARD` stays `{ width: 192, height: 124 }`. Measure in Storybook (dev
  tools on `Map/ProcessCanvas/ReadOnly`) and use the measured numbers if they differ by more than 2 px. Replace the literal
  `{ width: 192, height: 92 }` and `192` in `lib/overview/company-map.ts` (lines ~114 and ~160) with `CARD_SIZE` /
  `CARD_SIZE.width`. Leave `COMPANY_CARD` / `COMPANY_GAP` (`packages/db`), MCP placement and `addAt`'s 180×90 guess alone:
  they still clear the new sizes (rows 140 px apart, groups ≤ 124).
- **What follows the size by itself** (no change needed; the reviewer checks it still works): React Flow re-measures nodes
  (`onNodesChange` `dimensions`), `openGroupSize` and `laneLayout` use measured sizes, the first framing waits for every
  card to be measured (`allMeasured`), `fit` uses `getNodesBounds`, edges re-route from the handles (which sit at each tile's
  vertical middle, so edge ends move down by ~10 px), the playback layer reads `node.measured.height`.
- **Stored layouts are not moved.** No migration, no position rewrite. A pair of steps stacked less than ~105–120 px apart
  may now touch. The new e2e check (section 7) proves the demo maps don't overlap. If it finds an overlap on a demo page,
  move only that step's `y` in the fixture by the smallest amount that leaves 12 px (Northbeam:
  `packages/db/src/fixtures/northbeam.ts`; Larkspur: `packages/engine/src/fixtures/larkspur-data.ts`), run
  `pnpm --filter @transpera-flow/db gen:seed` and `gen:bootstrap`, run the engine golden tests to prove no number moved,
  and list each move in the PR. If a golden moves, revert the move and report the overlap in the PR instead; never bump
  `ENGINE_VERSION` for this. My arithmetic says Larkspur's "Social set-up & first calendar" (520, 180, two-line name) now
  reaches "Content plan & first articles" (520, 290); expect that one move.

### 5.2 Privacy (#30, D47)

Members and viewers never see pay or other people's names. Tiles keep using exactly the data they get now: people from
`namedForViewer(viewerOf(bundle), bundle.people)` inside `process-canvas.tsx` (the `person-privacy-source.test.ts` check
on that file must keep passing), roles, step rows, `result.steps[id]` and `result.bnStep`. **Never** read `result.roles`,
`result.people`, `result.resolvedPeople`, `result.stepFacts` (its `keyPerson.personName` is a real name) or any cost or
rate. No pay is drawn anywhere on a tile, before or after.

### 5.3 Share and play links

They render the frozen, redacted snapshot through the same components. Nothing new may be read there: no new prop at any
call site, no new loader, no change to `ShareSnapshot`, `src/lib/share/**`, `src/app/s/**` or `packages/db`. `avgWait` comes
from the same `result` object the shared page already simulates from the snapshot.

### 5.4 Phones under 640 px

Read-only already. The map never fits below 70%, so the smallest tile text (11 px) draws at about 7.7 px, as today's 11 px
rework line does. Keep the 400 px stories and the e2e phone crawl (`expectNoSidewaysScroll`, `expectNothingEscapes`,
`expectReadOnly`) green. Nothing on a tile is a control on a phone except the issue pill (it opens the Issues tab, read-only).

### 5.5 Performance

No extra renders per simulation tick. Playback moves tokens and badges from `requestAnimationFrame` without React
(`playback-layer.tsx`); keep it so. In node components: no `useStore`, `useReactFlow`, `useViewport` or zoom reads (that is
why the zoomed-out compact mode is out); no new context. New `StepNodeData` / `GroupNodeData` fields are primitives
(`avgWait: number | null`, `rated: boolean`), so `sameNode` still hands React Flow the same object for an unchanged step.
Compute `tileHeadline` inside the node component (cheap, pure) or in the `useMemo`; never create objects per render in
`data`. A lever change re-renders only tiles whose numbers changed, as today.

---

## 6. Files and functions

| File | Change |
|---|---|
| `apps/web/src/components/process-canvas.tsx` | `StepNodeData` (+`avgWait`, +`rated`), `GroupNodeData` (+`rated`; drop `worstRating` in favour of `RATING_LABELS[rating]`), `Badges` → `TopPills` + `FlagPills`, `StepNode`, `TerminalNode`, `GroupNode` (closed branch only), `Stripe` (delete), `stepLabel` (4.8), group `ariaLabel`, the `nodes` `useMemo` (fill the new fields; ghosts get `avgWait: null, rated: false`), `StepDetail` call (pass `reworkTo`). Keep the nodes in this file. |
| `apps/web/src/lib/map/tile.ts` (new) | `tileHeadline` (4.3), and `tileColours(rating: Rating \| null, bottleneck: boolean): { background: string; borderColor: string; dot: string; divider: string }` from `RATING_STYLE`, so the canvas and the export share one mapping. |
| `apps/web/src/lib/map/groups.ts` | `CARD_SIZE`, `TERMINAL_SIZE` (5.1). |
| `apps/web/src/lib/overview/company-map.ts` | literals → `CARD_SIZE` (5.1). |
| `apps/web/src/components/step-issue-badges.tsx` | pill classes and text (4.4); nothing else. |
| `apps/web/src/components/map/step-detail.tsx` | `StepDetail` gets `reworkTo: string \| null`; add a `Rework` row after `Wait` when `Number(step.rework_rate) > 0`: `` `${percent} back to ${reworkTo}` `` or `` `${percent}, redone at this step` `` (percent as `process-canvas.tsx`'s `percent`). |
| `apps/web/src/app/globals.css` | focus-ring radius (4.7). Nothing else. |
| `apps/web/src/lib/export/map-image.ts` | section 6.1. |
| `apps/web/stories/map/process-canvas.stories.tsx` | two new stories (section 7.3). |
| tests | section 7. |

### 6.1 Map image export (`lib/export/map-image.ts`)

Same tiles, as SVG, from the same inputs (no new input, no run: the export has none, so **no headline row**):

- `MapPalette` gains `destructive` and `critFg` (`TOKENS`: `--destructive`, `--crit-fg`; `LIGHT_PALETTE`: `#c93534`,
  `#ffffff`). This file is on the raw-colour allow-list.
- **Step card**: `rect rx=12`, fill `rate[r].soft` or `panel`, stroke `rate[r].stripe` or `line2`, `stroke-width=1.5`; no
  left stripe. When `input.rating` is given: a rating row (circle r=4 at `x+14, y+15`, text `x+23, y+19`, 10.5 px, 600,
  `fill=fg2`, `letter-spacing=0.6`, `RATING_LABELS[r].toUpperCase()` or `"NOTHING TO FIX"`), name lines from `y+37` (16 px
  apart, `wrapText(name, 20, 2)`); without ratings, names from `y+24` as today. Foot: a divider line at `y+h-25` from
  `x+10` to `x+w-10` (`stroke=line2`), who at `x+12, y+h-9` (11.5 px, `fg2`, `wrapText(who, 18, 1)`), and at
  `x+w-12, y+h-9` `text-anchor="end"` mono 11.5 px: `` `${formatHours(work)} work` `` for a step with a role or person,
  `` `${formatHours(wait)} wait` `` for one without, `—` when that value is 0.
- **Issue count**: a pill, not a circle: `rect` height 18, `rx=9`, width `16 + text.length * 6.4`, at
  `x+w-10-width, y-9`, fill `destructive`, stroke `panel` 2; text `` `${n > 99 ? "99+" : n} ${n === 1 ? "issue" : "issues"}` ``
  11 px bold `fill=critFg`.
- **Terminal**: `rect rx=12`, fill `panel2`, stroke `line2` 1.5; "START" / "END" at `y+16` (10.5 px, `fg2`), name at
  `y+32` (13 px, 600). Width `clamp(96, ceil(len * 7.5 + 24), 150)`; name wrapped to fit, at most 2 lines (height 46, or 62
  with two lines). Replace `pillWidth` / `terminalText` accordingly; `layout` uses the new size.
- **Closed group**: as the step card with `stroke-width=2 stroke-dasharray="6 4"`, rating row "WORST INSIDE: …" or
  "NOTHING TO FIX", name, and the foot text `N steps inside` (today's text, today's count).
- **Legend**: unchanged, except the "Confirmed issues" swatch fills `destructive`.
- Keep `data-step`, `data-rating`, `data-group`, `data-legend`, escaping and the footer sentence.

## Patterns to copy

- Rating colours by inline style from `RATING_STYLE`: today's `Stripe` and `StepDetail`'s rating swatch.
- Edge pills: today's `Badges` (`pointer-events-none absolute -top-2 …`, `pointer-events-auto` for the tooltip).
- Draft values: `Was`; inline editing: `NodeInlineEditor` and the `data-field` attributes (double-click a field to edit it).
- Text size and colour classes: today's node classes (`text-[11px]`, `text-fg-2`, `font-mono tabular-nums`).
- Pure helper plus unit test: `lib/map/rating.ts`, `lib/map/zoom.ts` with `test/map-v2.test.ts`.
- Story that waits for the map to settle: `HighlightMap` (`data-visual-pending` until the viewport is still 30 frames).
- SVG export tests: `test/export-map-image.test.ts`.

---

## 7. Tests

### 7.1 Unit (`pnpm test`)

- **New** `apps/web/test/map-tile.test.ts`: every row of the 4.3 table (`value`, `caption`, `phrase`), including a staffed
  step whose id is missing from the result (`—`), 0 hours, and formatting (`formatHours(25)` → "25 h"); `tileColours` for
  each rating, unrated, and bottleneck (border `var(--crit)`).
- **New** contrast test in the same file: read `src/styles/tokens.css`, take `--destructive`, `--crit-fg`, `--fg-2` and each
  `--rate-*-soft` from the `:root` block and from the `:root[data-theme="dark"]` block (falling back to `:root` for a token
  the dark block doesn't set, and resolving one level of `var(--x)`), convert `oklch(...)` with `oklchToHex`
  (`lib/branding/contrast.ts`) and assert `contrastRatio(destructive, critFg) >= 4.5` and
  `contrastRatio(fg2, rateSoft) >= 4.5` in both themes.
- `test/export-map-image.test.ts`: update for 6.1 (rating row text, "NOTHING TO FIX" only when `rating` is given, the
  "N issues" pill text, terminal "START"/"END", group dash, no left-stripe rect, still exactly one `data-rating` per rated
  card, escaping of a hostile name still holds).
- `test/raw-colours.test.ts`, `test/person-privacy-source.test.ts`, `test/stories-coverage.test.ts`: unchanged, must pass.

### 7.2 Browser harness

- `test/map-browser.test.ts` (map harness): all existing tests pass. The helper at ~line 469 reads a card's name as
  `e.innerText.split("\n")[0]`; change it to `e.querySelector("[data-field='name']")?.textContent`, so a rating row or pill
  text before the name can't break it. Add one test: a read-only Northbeam map with a run shows a headline on every staffed
  tile (`[data-tile='step']` contains "waiting · queue"), the bottleneck tile has the "Bottleneck" flag, and no tile's text
  contains "%" busy figures or a person's real name.
- `test/export-map-image-browser.test.ts`, `test/share-browser.test.ts` (no names, no pay, no edit controls in shared
  views), `test/play-browser.test.ts`, `test/overview-browser.test.ts`, `test/overview-page-browser.test.ts`: unchanged,
  must pass.
- **New** `apps/web/e2e/map-nodes.spec.ts` (runs in CI's `check` job after the build, real CSS): at 1280×800 and 400×900,
  for `/demo/p/c0000000-0000-4000-8000-000000000001`, `/demo/larkspur`, `/demo/overview`, `/demo/issues/1`: wait for
  `.react-flow__node`, then assert (a) no two node boxes intersect, ignoring open groups (`[data-group='open']`) and nodes
  inside them against their own group; (b) every `[data-tile='step']` is 192 ± 1 px wide at zoom 1 (divide by the
  viewport's scale from `.react-flow__viewport`'s transform); (c) every `[data-group='closed']` is ≤ 124 px tall at zoom 1.
  Reuse `open` and `watchErrors` from `e2e/checks.ts`.

### 7.3 Storybook stories

In `stories/map/process-canvas.stories.tsx`:

- **`NodeStates`** (`tags: ["visual-phone"]`): `northbeamRun()` with `demoBundle()`'s steps (Audit has a conflict and is
  the run's bottleneck; Kickoff has an assumption), `rating={ratingsByStep(bundle)}`, `selection={{ steps: [onboard], edges: [] }}`,
  `openIssues` for two steps, and `<StepIssueBadges badges={...} onOpen={() => {}} />` inside the same wrapper with fixed
  badges (Audit: 2, risk, two fixed titles; Kickoff: 1, bad). Ready (`data-visual-pending` removed) once the viewport has
  been still 30 frames **and** both `[data-issue-badge]` exist. Shows: every rating, unrated (pass a `rating` callback that
  returns null for one step), bottleneck, selected, issues, conflict, assumption, decision (no role), terminals.
- **`Draft`** (no phone tag): a read-only canvas with `diff={diffBundles(live, draft)}` (`lib/drafts/diff.ts`) where the
  draft renames one step, changes one step's work and wait hours, adds a step and removes one: New, Changed (`Was` values,
  the was-wait line), Removed ghost.
- Existing stories (ReadOnly, GroupsOpen, Highlight, CompanyMap, Editable, `Map/Placeholder/FirstRun`,
  `Shared/EmptyState/EmptyMap`) stay as they are; their pictures change.

Run locally before pushing: `pnpm --filter @transpera-flow/web build-storybook`, then `visual:update` and `visual` twice
(`docs/visual-regression.md`, "Local runs"), and look at the PNGs in `.local-screenshots/`.

### 7.4 Baselines and the `[visual-update]` flow

1. Push the code. CI's `visual` job fails on the changed and new stories (intended).
2. Push an empty commit whose subject contains `[visual-update]`; `visual-commit` commits "Update visual baselines".
3. `git pull --rebase`, then push any commit so `check` and `visual` run on the new head.

**Expected changes, and only these** (26 changed, 6 new):

- changed: `map-processcanvas--{read-only,groups-open,highlight,company-map}--{light,dark}.png` and the same with `--400`
  (16); `map-processcanvas--editable--{light,dark}.png` (2); `map-placeholder--first-run--{light,dark}{,--400}.png` (4);
  `shared-emptystate--empty-map--{light,dark}{,--400}.png` (4; the start and end tiles show behind the empty state. If they
  don't, these 4 stay unchanged, which is also fine).
- new: `map-processcanvas--node-states--{light,dark}{,--400}.png` (4), `map-processcanvas--draft--{light,dark}.png` (2).

**How the reviewer verifies only node visuals moved:**
`git diff --name-status origin/main...HEAD -- apps/web/visual/__screenshots__/` lists exactly the files above (M or A),
nothing else. In each changed PNG (GitHub's swipe or onion-skin view): the toolbar, legend, zoom controls, background and
page chrome are pixel-identical; the tiles changed; edges changed only where a tile's height moved its handle (the line
ends follow the tile's vertical middle; their style, arrowheads and labels are unchanged). Any other baseline changing is a
regression to fix, not to approve.

---

## 8. Done criteria

1. Every node kind on every screen in section 3 draws as section 4 says, in light and dark, at 1280 and 400 px.
2. Tiles show only the data in the 4.2 table; `git grep -n "result\.\(roles\|people\|resolvedPeople\|stepFacts\)" -- apps/web/src/components/process-canvas.tsx`
   finds nothing; no diff under `packages/db`, `packages/engine`, `packages/mcp`, `apps/web/src/lib/share`, `apps/web/src/app/s`
   (except fixture `y` moves allowed by 5.1, listed in the PR).
3. `CARD_SIZE` / `TERMINAL_SIZE` match the measured tiles (± 2 px); no hard-coded `192`/`92` left in
   `lib/overview/company-map.ts`.
4. The new e2e map check passes on all four demo pages at both widths; existing e2e suites pass.
5. `pnpm lint && pnpm typecheck && pnpm test` pass (database tests with Postgres; `format.test.ts`'s known container-only
   ICU failure excepted); the browser tests pass; CI `check` is green.
6. CI `visual` is green after `[visual-update]`, and the baseline diff is exactly 7.4's list.
7. The PR body lists the defaults below, any fixture moves, and the before/after of one tile; ends with the attribution
   lines; no model names in commits or the PR. It says "Part of #242" (not Closes; the orchestrator closes
   it after review).

## 9. Out of scope

Edges, edge labels and routing code; the canvas toolbar, zoom controls, legend, swimlanes and lane layer; the Editor's
inspector and palette; the step detail panel (except its one Rework row); the open group box; the playback layer and its
badges (they may cover the Bottleneck flag while playing; accepted); `MapSkeleton`; `BlockMap` thumbnails; the zoomed-out
compact ("heat map") mode below 60% zoom; role or person "% busy" on tiles; a decision's "% lost"; moving stored positions
or a "tidy layout" action; MCP placement; the PDF (removed, D22); options A and C. Raise any of these as a follow-up, don't
build them.

## 10. Defaults taken (Austin is away; each is the conservative choice)

1. **Width stays 192 px**, not the prototype's 228: stored positions, MCP's 240 px columns and the demos' 230 px columns
   would leave almost no gap between tiles.
2. **Name stays 14 px**, not 15.5 px, so names wrap where they do today. Step names are not clamped; group names clamp to two
   lines (company-map layout depends on ≤ 124 px).
3. **Conflict and Assumption sit on the bottom edge**, not inside the tile: no height cost, no collision with the issue
   count or the Bottleneck flag.
4. **The headline is the queue wait** (`avgWait`, with `avgQueue` in the caption) for staffed steps, and the planned wait
   for unstaffed ones. The prototype's hand-written headlines have no data behind them.
5. **Utilisation ("% busy") is not on tiles**: it is role data (`result.roles`), today's cards don't show it, and for a
   step pinned to a person it would be that person's utilisation, which members must not see.
6. **A decision's "% lost" is not shown** (`lostHere` exists, but it would be a new figure on the map).
7. **Unrated tiles say "Nothing to fix"** (the map legend's and the step detail's words for the same thing); a map without
   ratings (Editor, solution compare) has no rating row at all.
8. **Planned wait and rework leave staffed tiles**, as B intends; the screen-reader label keeps them, the step detail shows
   Wait already and gains a Rework row, the Editor's inspector has both, and a draft's changed wait still shows on the tile.
9. **The issue count stays a portal button** (`StepIssueBadges`), restyled, rather than moving into the node: no new
   prop or callback through the canvas, same click behaviour, same screens. The processes-list preview still has no
   per-step count.
10. **Pills use `--destructive`**, not `--crit`, for AA contrast; this also changes today's badge colour slightly.
11. **No hover lift, no "⧗" glyph** (handles would drift 1 px; the glyph isn't in Inter).
12. **Radius `rounded-lg` (12 px)**, the nearest token to the prototype's 14 px.
13. **No compact mode when zoomed out**: it needs every node to read the zoom, which re-renders all tiles on every zoom
    step (5.5). Fit never goes below 70%, so it would only show on a manual zoom-out.
14. **Terminals become small tiles** (min 96, max 150 px, "Start"/"End" label), keeping today's tone colours.
15. **The export draws B tiles without the headline**: the export has no run, and adding one would put new data in a file.
16. **No stored position changes**, except the smallest demo-fixture `y` moves the e2e overlap check forces.

## 11. Risks

- **Real maps may touch.** Tiles are ~25 px taller. A production map with steps stacked closer than ~105–120 px will have
  touching tiles until someone drags them. Production has one account (Austin's), so he will see it first; a "tidy layout"
  follow-up would fix it in general.
- **Baseline churn.** 26 baselines change, so a real regression could hide among them; the reviewer must check the list in
  7.4 file by file. `Shared/EmptyState/EmptyMap` once drew 1 px off in CI; if it flakes, re-run before approving.
- **Information on the tile goes down** (planned wait, rework). Austin chose B knowing its note ("the rest is in the
  step's detail"), but he may want rework back; it is a one-line change.
- **"Nothing to fix" on most tiles.** Ratings come only from confirmed issues, so on a fresh process nearly every tile is
  neutral and says "Nothing to fix". That is true (D24) but may read as an assessment; Austin may prefer no label.
- **The export's `LIGHT_PALETTE` rating colours are stale** (it has a yellow "Good"; the token is lime). The browser export
  reads live tokens, so only tests use it; left alone (out of scope), worth a follow-up.
- **The Bottleneck flag sits where playback's count badge goes** (top-left); while playing, the red badge covers the flag.
  Both say the same thing, so this is accepted.

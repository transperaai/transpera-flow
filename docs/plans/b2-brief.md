# B2 build brief: the People page (#31)

Scoped 6 Oct 2026 (overnight run) against `main` at 0152329, which has B1 2b (#205) merged, and the open B1 3/3 branch
(`claude/b1-3-agency-list`, PR #206, tip 0ced349), which doesn't touch the People page. Read
`docs/plans/builder-brief.md` first. This brief adds to it and wins where they differ. Build strictly from it. If
something here doesn't match the code, **ask; don't guess.** Austin is asleep, so every open question below has a
default, and you use the default.

## The short version

Most of the People page exists. A55 (#120) built the client health card, the benchmark card, the team card, the client
groups table and a "How busy" table. B1 2b (#205) made the table show a member only their own row. What's left:

1. **How busy, in full.** Add client work, sales work, overtime and leave columns to the existing table (it already shows
   the average and P90). Add the **horizon picker** (`?horizon=`, as on the Overview).
2. **If someone is away**: a new card with the absence test results (A42, rule 8). For each person tested, it shows the
   work lost, the weeks to catch up and the rating of "Only one person can do it". A member sees only their own result,
   and for a member only their own person is tested.
3. **Person detail**: an inline disclosure on each row. It shows roles, hours, start and end dates, skills (the steps
   they can do) and leave. Capacity factors are **never shown**: Austin parked them (C6, #198). A pure gate and a test
   prove they stay hidden.
4. **Client health against the benchmark**: already done. Keep it, and make it follow the horizon picker.

**No migration. No `ENGINE_VERSION` bump.** One small engine refactor: rule 8's rating is pulled out of `detectIssues`
into an exported `absenceRating` so the page and the Issues register rate absences the same way. No golden number
moves, and the golden tests must pass untouched.

One PR. Branch `claude/b2-people-page` already holds this brief: check it out, run `git merge origin/main`, and build
on it. Commit and push after each part: (1) engine `absenceRating`; (2) `lib/people.ts` and its tests; (3) the page;
(4) the browser test; (5) docs. The PR says `Closes #31`.

---

## Decisions (verbatim)

**#31, the ticket (Austin):**
> The capacity factor is off by default per workspace. When enabled, it is shown only once measured (at least 10
> completed items for that person-step) or explicitly entered, is visible to the person themselves, and is never
> ranked. There is no "vs role median" column (PRD §6.3.7, decision D20).

> - [ ] The People table shows how busy each person is with average and P90; there is no ranking or benchmark column for people
> - [ ] A member viewing People sees only their own record (relies on B1's RLS)

**#198 (C6), Austin's decision on 6 Oct:**
> Austin's decision on 6 Oct: per-person speed is **not wanted for now**. It's parked as **phase 2**, not to be built in
> Milestones B or C.
>
> - Everyone in a role keeps working at the role's speed.
> - C2 part 2 (#41) doesn't propose capacity factors.
> - Revisit only if a client's forecasts are clearly off because one person is much faster or slower than their role.

So nothing can be "measured or entered" today. No storage exists (`person_skills.efficiency` is unused, and a
`person_skills` row restricts which steps a person can do), no screen sets `capacity_factor_enabled`, and the engine
ignores it. **Don't build capacity factors.** Build only the gate (Part 2, `capacityFactorsShown`) and its test, so the
acceptance criterion "stays hidden unless the workspace setting is on, and on only when measured or entered (test)"
holds now and stays true when C6 is built.

**#30 (B1), Austin, 6 Oct (A', then "no pay data"):**
> - **Their numbers:** everything else matches what an editor sees. The screens show members only their own row.
> - **Names (Q2):** members see their own name, and "A team member" for anyone else, e.g. issue owners and solution
>   authors.

> Austin's decision on 6 Oct: **members and viewers get no pay data.** [...]
> - `team_capacity` returns no cost rate for members and viewers, and nothing derived from rates.
> - Figures that depend on individual pay show "—" for them, with a short (i): "Only owners and editors see costs that
>   depend on people's pay." That's overtime cost and the cost attached to detected issues.

> Known limit, accepted: a member using browser dev tools can still read anonymous hours and leave dates.

**Handover, the overnight run (Austin, 6 Oct):**
> | 1 | B2 People page (#31) | Unblocked once #30 closes. Check it against what B19 and B1 2b already built; the member view must stay own-row only |

**PRD D20:**
> Capacity, not performance: individual availability/skills/assignments; capacity factor off by default, shown only when
> measured, visible to the person, never ranked; no role-median benchmark.

**PRD D32:**
> The **absence test**: an extra run with the person away for two weeks, rated on work lost and weeks to catch up. It
> replaces flagging every one-person step.

**PRD §11, screen 13:**
> **People**: how full each person's week is, absence-test results, and client health against a benchmark. Person detail
> with skills and leave. Capacity, not performance: no rankings (D20).

**#107 (A42), rule 8's bands:**
> Great under 5% lost and back within 1 week; Bad 5–20% or 1–4 weeks; Operational risk over 20%, not back within 4
> weeks, or any client-facing deadline missed.

**B17 (D40), in `apps/web/src/lib/analysis/defaults.ts`:** every page rates with the documented defaults
(`ANALYSIS_DEFAULTS`); what a workspace stored in `analysis_rules` is kept but not read. The People page does the same.

---

## Audit: what exists vs what #31 needs

| #31 needs | Today (main 0152329) | Change |
|---|---|---|
| Route `/w/[slug]/people`, demo `/demo/people`, sidebar item | Done: `app/w/[slug]/people/page.tsx`, `app/demo/people/page.tsx`, `components/shell/app-sidebar.tsx` | None |
| Client health card: company score, healthy / watch / at risk split | Done: `ClientHealthCard` in `components/people-page.tsx`, from `clientHealthSummary` (engine) | Follows the horizon picker (no code change beyond the model) |
| Benchmark card | Done: `BenchmarkCard`, `benchmarkOf(settings)` from `lib/client-groups.ts` | None |
| Client groups table | Done: `ClientGroupsTable` | None |
| Team card | Done: `TeamCard`, `teamSummary` (whole team, computed before own-row filtering: B1 2b) | None |
| How busy: role, FTE, average and P90 | Done: `HowBusy`, `personRows` in `lib/people.ts` | Add client work, sales work, overtime, leave |
| How busy: client work / sales work / overtime / total | Not shown. The run has them: `result.kpi.people[id]` is `{ util, pipeline, ongoing, servicing, overtime }` (each a `Stat`, a share of the person's capacity; `util` is over capacity + overtime). `utilisation-bars.tsx` L22 defines client work as `ongoing + servicing` | New `PersonBusy` fields |
| Leave | Not shown. `result.resolvedPeople[id].leave` holds `[start, end)` simulation hours | New `leaveDays` |
| Horizon picker | Not on this page. `components/horizon-picker.tsx` (`HorizonPicker`), `lib/horizon.ts`; the Overview's `?horizon=` handling (`overview.tsx` L225–L242); `useEngineModel(bundle, weeks)` in `components/process-view.tsx` L62 | Add |
| Absence test results per person | Not on this page. Engine: `absenceTest`, `AbsenceFinding`, `ABSENCE_MAX_PEOPLE` (`packages/engine/src/absence.ts`). Browser: `useAbsenceTest` (`lib/sim/absence.ts`) and `workers/absence.worker.ts`. The rating is computed inline in `detectIssues` (`packages/engine/src/issues.ts` L587–L605), per step | Extract `absenceRating`; new card; `personIds` on the worker |
| Person detail with skills (and leave, PRD) | None | Inline disclosure |
| Capacity factor gated | Doesn't exist (C6 parked) | Pure gate + test; render nothing |
| Members see only their own record | B1 2b: `ownRowsOnly(viewer, rows, …)` on the How busy table; "Your sign-in isn't linked…" message; `people-browser.test.ts`; `person-privacy-source.test.ts` lists `components/people-page.tsx` | Apply to every new per-person block (absence, detail) |
| (i) on every setting, lever and rule | Cards have (i) through `Help`; `HorizonPicker` has its own | (i) on the new card and on each new column group |
| No ranking | Rows sort by first role in role order, then name | Keep. The absence card sorts the same way, **not** by work lost |

**What B19 built that touches people:** B19 (1/2) (#190) is clients and workspace settings. People are still edited in
Settings → People (`app/w/[slug]/settings/people-settings.tsx`, `SettingsSection id="people"`). The People page stays
read-only and links there for editors. B19 (2/2) (#194) is process admin and source uploads: nothing for this page.

**What B1 2b built that you must keep:**
- `apps/web/src/lib/viewer.ts`: `viewerOf`, `ownRowsOnly`, `canSeePerson`, `personName`, `namedForViewer`.
- A member's bundle (from `team_capacity` via `loadTeam`) has every person under a "Team member N" label (their own
  keeps their name), `cost_rate: null`, and `viewer: { seesEveryone: false, ownPersonId }`. The engine still simulates
  everyone, so team totals are right; **the screen must show only the viewer's own person**.
- `people-browser.test.ts` and `people-harness/entry.tsx` (the harness's `asMember`) are the pattern for the browser test.

**Data:** everything the page needs is already in the `ProcessBundle` that `loadLiveProcess(slug)` returns (`people`,
`personRoles`, `personSkills`, `personLeave`, `roles`, `workspace.settings`, `viewer`). **No loader changes, no new
reads, no migration.**

---

## Part 1: engine, `absenceRating` (no numbers move)

**File:** `packages/engine/src/issues.ts`. Export from `packages/engine/src/index.ts` next to the other `./issues`
exports.

```ts
/**
 * Rule 8's rating of one absence result (docs/analysis-rules.md, "Only one person can do it"): the worse of the work lost
 * (the rule's cut-offs for this subject) and the weeks to recover (`config.absence.recoveryCutoffs`); Operational risk
 * when the queues never got back to normal within the run, or a client deadline is missed. Null when the rule is
 * switched off for this subject. `detectIssues` raises nothing for a Great.
 */
export function absenceRating(config: RatingConfig, finding: AbsenceFinding, subject: RatingSubject): Rating | null;
```

The body is exactly the current inline logic (L597–L604): `resolveRule(config, "spof", subject)`; null if
`!resolved.enabled`; `rateRule(config, "spof", resolved, { average: finding.workLost })`; recovery via `rateValue(...)`
when `finding.recovered`, else `"risk"`; `worseRating`; `"risk"` when `finding.clientDeadlineMissed`.

In the rule-8 loop of `detectIssues`, replace those lines with a call to `absenceRating`. Keep the `resolved` that the
evidence text uses for `resolved.cutoffs` (call `resolveRule` once for it, as now). Behaviour is identical.

**Checks:** `pnpm --filter @transpera-flow/engine test` passes with **no** `golden:approve`, and `git diff
packages/engine/golden` is empty. **No `ENGINE_VERSION` change.** If any golden moves, stop and ask.

## Part 2: `apps/web/src/lib/people.ts` (pure)

Extend, don't rewrite. Keep `BUSY_LIMIT`, `teamSummary` and the existing sort.

```ts
export interface PersonBusy {
  id: string; name: string; role: string; fte: number | null;
  average: number; p90: number;              // as now (util mean, util p90)
  /** Shares of the person's capacity, averaged over the runs. */
  clientWork: number;                        // kpi.people[id].ongoing.mean + kpi.people[id].servicing.mean
  salesWork: number;                         // kpi.people[id].pipeline.mean
  overtime: number;                          // kpi.people[id].overtime.mean (0 with no overtime cap)
  /** Working days of leave inside the run's period. */
  leaveDays: number;
}
```

- `personRows(model, result, fteById)` keeps its signature, adds the four fields, and keeps the sort (first role in role
  order, then name). **No other sort order anywhere on the page** (D20: never ranked).
- `leaveDays(person: EnginePerson, horizonHours: number, hoursPerWeek: number): number`. It sums each `[a, b)` of
  `person.leave ?? []` clipped to `[0, horizonHours)`, then divides by `hoursPerWeek / 5`, the same working day
  `resolvePeopleRows` uses (`WORKING_DAYS_PER_WEEK = 5` in `packages/db/src/model.ts`, which isn't exported: use 5
  here with a comment pointing there). Round to 1 dp only at display. `horizonHours = model.horizonWeeks * model.hoursPerWeek`.
- The run's people are `result.resolvedPeople` (named, or made up from role head-counts). Use their `leave` and
  `skills` (they match the model the run was made from, at the picked horizon).

```ts
export interface AbsenceRow {
  id: string; name: string; role: string;
  /** Names of the steps only they can do, in model step order. */
  steps: string[];
  workLost: number;            // finding.workLost
  /** Weeks to catch up; when `recovered` is false, "more than" `weeksWatched`. */
  weeks: number; recovered: boolean; weeksWatched: number;   // weeksWatched = finding.recoveryWeeks - 1 when not recovered
  clientDeadlineMissed: boolean;
  rating: Rating | null;       // absenceRating(...); null only if the rule is off (never with ANALYSIS_DEFAULTS)
}

/** Rule 8's results, one row per person tested, in the same order as personRows. */
export function absenceRows(model: EngineModel, test: AbsenceTest, config: RatingConfig): AbsenceRow[];

/** People who are the only one for a step but weren't tested (over ABSENCE_MAX_PEOPLE, or the time budget ran out). */
export function untestedSoleHolders(model: EngineModel, test: AbsenceTest): string[]; // person ids
```

- `config = toRatingConfig(ANALYSIS_DEFAULTS, model.hoursPerWeek)`.
- The subject for `absenceRating` is `{ roleId: person.roles[0] ?? null, personId: id, stepId: finding.stepIds[0] ?? null }`.
  With `ANALYSIS_DEFAULTS` there are no overrides, so the subject changes nothing. Note this in a comment.
- Names and roles come from `resolvePeople(model)` (exported from `@transpera-flow/engine`), and step names from
  `model.steps`.
- `untestedSoleHolders`: `absenceCandidates(model)` minus `test.people`.

```ts
/**
 * Whether a person's capacity factors may be shown (PRD §6.3.7, D20; #31). Only when the workspace has switched them on
 * and the factor is measured (at least 10 completed items for that person-step) or entered. Per-person speed is parked
 * (C6, #198), so nothing stores a factor yet and the page always passes [].
 */
export const CAPACITY_FACTOR_MIN_ITEMS = 10;
export function capacityFactorsShown(
  settings: unknown,  // the workspace's settings jsonb; reads `capacity_factor_enabled === true` only
  factors: readonly { measuredItems: number; entered: boolean }[],
): typeof factors;    // the factors that may be shown; [] when switched off
```

```ts
export interface PersonDetail {
  roles: string[];                 // role names
  hoursPerWeek: number;            // EnginePerson.capacity
  fte: number | null;
  startDate: string | null; endDate: string | null;   // from the PersonRow (bundle.people), ISO
  /** Step names they can do; null means "every step of their roles" (no skill rows). */
  skills: string[] | null;
  /** Leave periods from bundle.personLeave, ISO start and end, oldest first; only those ending today or later. */
  leave: { start: string; end: string }[];
}
export function personDetail(model: EngineModel, result: SimulationResult, bundle: ProcessBundle, id: string, today: string): PersonDetail | null;
```

- `skills`: `result.resolvedPeople[id].skills` mapped to step names. `undefined` means null ("Every step of their
  roles"). An empty array means "None of the live process's steps".
- `leave`: rows of `bundle.personLeave` for `id` whose `end_date` is today or later (`toEngineModel` starts the run
  today: `options.startDate ?? new Date().toISOString().slice(0, 10)`, `packages/db/src/model.ts` L273). Take
  `today` as an argument so tests can pin it. Never read leave `notes` (`team_capacity` doesn't return them anyway).
- Return null for a person made up from a role's head-count (not in `bundle.people`).

## Part 3: the page, `apps/web/src/components/people-page.tsx`

Keep the existing structure and the B1 2b comments. Changes:

**1. Horizon picker.** Copy the Overview's pattern (`overview.tsx` L225–L242): `useSearchParams`, `usePathname`,
`useRouter`, `picked` state from `?horizon=` (`isHorizonMonths`), and `router.replace(..., { scroll: false })` on
change. `weeks = picked === null ? null : horizonWeeks(picked)`. Build the model with
`useEngineModel(bundle, weeks)` from `@/components/process-view`; it replaces the local `useMemo(toEngineModel)`. Render
`<HorizonPicker weeks={model?.horizonWeeks ?? bundle.workspace.settings.horizon_weeks} onChange={...} />`
right-aligned above the cards (prototype: "Projection" in the page head). The client health card, the client groups
table, the team card and How busy all follow it. If `next build` complains about `useSearchParams` without a Suspense
boundary, wrap `PeoplePage` in `<Suspense>` in both page files. Don't move the hook.

**2. How busy table** (`HowBusy`): the columns are Name · Role · FTE · Client work · Sales work · Overtime · How busy
(bar) · Average (with `P90 …` muted, as now) · Leave.
- Client work, sales work and overtime are `formatPercent`. Leave is `"—"` for 0, else `"N days"` (1 dp, no trailing
  `.0`).
- At narrow widths, client work, sales work, overtime and leave are `hidden md:table-cell` (the bar is already
  `hidden sm:table-cell`). The person detail repeats them, so phones still reach them.
- (i) on the table heading (keep it) and one more (i) beside "Client work" in the header covering the three shares:
  - description: "Client work is time on existing clients: their servicing tasks and ongoing account work. Sales work is
    time on the sales pipeline. Overtime is extra time beyond the person's week, up to the workspace's overtime cap. All
    three are shares of their normal week."
  - example: "Client work 55%, sales work 20%, overtime 4%: a full week with a little overtime."
- The overtime column is hours as a share. **Never show overtime cost here** (pay; Austin's 6 Oct decision).
- Members: `ownRowsOnly`, as now. Keep the `data-how-busy` and `data-no-own-row` hooks.
- A member whose person is linked but isn't in the run (inactive, or a start date after the period begins): show
  `data-not-in-run` with "You aren't in this simulation: your record is inactive or starts later. Owners and editors can
  change that in Settings → People."
  The test is `viewer.ownPersonId` is set, there's no own row, and `bundle.people` has that id. Otherwise keep the
  existing "isn't linked" text exactly (a source test pins it).

**3. Person detail.** The name cell becomes a `<button type="button" aria-expanded aria-controls>` that toggles a full-width
`<TableRow data-person-detail>` (one `colSpan` cell) under the row. One row is open at a time. It shows:
- Roles; hours a week (and FTE); "Started …" / "Leaves …" when set.
- **Can do:** step names, or "Every step of their roles", or "None of the live process's steps". (i):
  - description: "The steps this person is set up to do. With none listed, they can do every step of their roles."
  - example: "Freya does social setup and the social calendar, not the other social steps."
- Client work / sales work / overtime / leave days (for phones).
- **Leave:** each period as "19 Oct – 30 Oct 2026" (add a small `formatDateRange(start, end)` to `lib/format.ts`
  using `Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" })` on UTC dates, with a unit
  test), or "No leave booked".
- Capacity factors: `capacityFactorsShown(bundle.workspace.settings, [])`. Render a block only if it returns a
  non-empty list. It never does today, so **no capacity factor text, heading or (i) appears anywhere**.
- Editors only (`viewer.seesEveryone && settingsHref`): a link "Change in Settings" to `${settingsHref}#people-heading`.
  Members and viewers get no link.
- A row made up from a role's head-count (`personDetail` → null) has no button; its name is plain text.

**4. If someone is away (new card, below How busy, above the forecast panel).** It uses `data-absence`.
- Run `useAbsenceTest(baseModel, 1, resolveMoney(ANALYSIS_DEFAULTS).absenceWeeks, personIds)`.
  - `baseModel` is `useEngineModel(bundle, null).model`: the workspace's own length, **not** the picked horizon (Q2).
  - Gate it on the first baseline run being done, as the Issues page does: pass null until `sim.status === "done"` has
    happened once for the base model. Keep a `useState` flag; don't re-gate on every horizon change.
  - `personIds`: `undefined` for viewers who see everyone; `[viewer.ownPersonId]` for a member or viewer linked to a
    person; skip the test (pass null) for an unlinked member (Q3).
- **`lib/sim/absence.ts` and `workers/absence.worker.ts`:** add an optional `personIds?: readonly string[]` to
  `useAbsenceTest` and to `AbsenceRequest`. The worker passes it to `absenceTest(model, { seed, weeks, personIds })`.
  Include it in the hook's state key: compare by `personIds?.join(",")`, not by array identity. Existing callers pass
  nothing and are unchanged.
- Rows are `ownRowsOnly(viewer, absenceRows(baseModel, test, config), (r) => r.id)`, using the same sort as How busy.
- Columns: Name · Role · Only they can do · Work lost · Weeks to catch up · Rating.
  - Work lost: `formatPercent`.
  - Weeks to catch up: `"Under 1 week"` for 0, `"1 week"`, `"N weeks"`; when not recovered, `"Not within N weeks"`
    (`weeksWatched`).
  - Rating: the existing `RatingChip` (`RATING_LABELS`), Great included.
  - A missed client deadline adds a muted line under the rating: "A client deadline is missed."
  - "Only they can do" is hidden below `md`. Put the steps in the row's `title` instead.
- (i) on the heading ("If someone is away"):
  - description: "For each person who is the only one able to do a step, the simulation runs again with them away for 2
    weeks and compares. Work lost is the share of the work from then to the end of the period that doesn't get done.
    Weeks to catch up is how long their queues take to get back to normal once they're back. Great: under 5% lost and
    back within a week. Bad, not urgent: 5–20% lost, or 1–4 weeks. Operational risk: over 20% lost, not back within 4
    weeks, or a client deadline missed."
  - example: "Maya away for 2 weeks: 12% of work lost and 3 weeks to catch up, so Bad, not urgent."
- A muted line under the heading: "Tested over the workspace's own {N}-week run, with each person away for 2 weeks."
- States:
  - While the test runs: `role="status"` "Testing what happens when each person is away…".
  - Nobody to test (for someone who sees everyone): "Nobody is the only one who can do a step, so nobody is tested."
  - A linked member who isn't a sole holder: "You aren't the only one who can do any step, so you weren't tested."
  - An unlinked member: the How busy table's "isn't linked" message already covers it. The card shows only its heading
    and "Nothing to show for you here."
  - Untested sole holders (sees-everyone only, `untestedSoleHolders` non-empty): "Only the {ABSENCE_MAX_PEOPLE} people
    who are the only one for the most steps are tested; {n} more aren't." Never list who they are to a member.
- If the base model can't be simulated, the whole page already shows the "can't be simulated yet" card.

**5. Unchanged:** `ClientHealthCard`, `BenchmarkCard`, `TeamCard`, `ClientGroupsTable`, `ForecastPanel` and the two
page files' props (only add `<Suspense>` if the build needs it). The demo shows Northbeam with everything (no
`viewer`).

**Wording:** plain, as in the prototype. Use "How busy", "Client work", "Sales work", "Overtime", "Leave", "If someone
is away", "Work lost", "Weeks to catch up", "Can do". Never use "efficiency", "performance", "rank", "score" (for a
person), "vs role" or "median".

---

## Patterns to copy

- Horizon state and URL: `components/overview/overview.tsx` L225–L242. The model at a horizon: `useEngineModel` in
  `components/process-view.tsx` L62.
- Absence after the baseline: `components/issues-page.tsx` L323 (`useAbsenceTest(model && result && sim.status ===
  "done" ? model : null, …)`).
- Own row only: `ownRowsOnly(viewer, rows, (r) => r.id)` as in `people-page.tsx` today, and `viewerOf(bundle)`.
- (i): `Help` from `@/components/help`, with `label`, `description` and `example`.
- Rating chip: `RatingChip` already in `people-page.tsx`.
- Browser harness: `apps/web/test/people-harness/entry.tsx` and `people-browser.test.ts`.

## Edge cases

- **Member linked to a person:** How busy has one row, If someone is away has at most one, the detail is only theirs, and
  no "Team member N" or "A team member" text appears anywhere on the page. Team card counts stay whole-team (accepted in
  B1 2b).
- **Member not linked:** no rows, the existing message, no absence test run.
- **Viewer** (read-only role) linked or not: same as a member (B1 Q3).
- **Linked, but not in the run** (inactive, or a later start date): the `data-not-in-run` message. The absence test with
  `personIds: [own]` finds no candidate and returns empty: show "You aren't the only one who can do any step…".
- **Workspace with no named people** (role head-counts): rows are "Strategist 1" and so on, made up by the engine. For
  editors nothing changes. For members, `ownRowsOnly` hides them all and the "isn't linked" message shows. Keep that
  (Q5): don't special-case.
- **Over 8 sole holders:** only the first 8 by steps held are tested (`ABSENCE_MAX_PEOPLE`). The note says how many
  aren't. A member is always tested themselves (`personIds`).
- **A sole holder whose steps get no work in the run:** the Issues register skips such steps. The People page still
  shows the person's result; work lost is near 0, so it reads Great. Accepted.
- **Short horizon picked** (1 month): the absence test isn't affected (workspace length). How busy and client health are
  over 4 weeks.
- **A person with leave partly inside the period:** only the days inside count (clip). Leave before the start date
  doesn't count.
- **`capacity_factor_enabled: true` in settings** (it can be set through an approved suggestion): still nothing shown,
  because there are no factors.
- **Overtime cap 0:** the overtime column reads 0%. That's fine and true.
- **Demo:** no viewer, so everything is shown. The horizon picker works in the tab.
- **Pay:** nothing new depends on pay. Don't add any cost column.

## Tests

1. **Engine** `packages/engine/test/absence-rating.test.ts` (new):
   - For `larkspurModel()` and `northbeamWithServicing()`: run `simulate`, run `absenceTest`, then `detectIssues` with
     `absence`. Every `spof` detection's rating equals `absenceRating(config, finding, subject)` for its person and step.
   - Band boundaries: workLost 0.0499 / 0.05 / 0.2 / 0.2001; recoveryWeeks 1 / 1.5 / 4 / 4.5; `recovered: false` →
     risk; `clientDeadlineMissed` → risk.
   - The rule switched off for a subject → null.
   - Golden suite green, untouched.
2. **Web unit** `apps/web/test/people.test.ts` (new):
   - `personRows`: client work = ongoing + servicing means; sales = pipeline; overtime; average and P90 unchanged
     (check against `result.kpi.people`); the order is unchanged.
   - `leaveDays`: none, fully inside, straddling the start, straddling the end, after the period; and a part-time person
     (days use the workspace day, not their hours).
   - `absenceRows`: same order as `personRows`; step names; not-recovered → `weeksWatched`; rating matches Part 1.
   - `untestedSoleHolders` with `maxPeople` forced low (build an `AbsenceTest` with fewer people than candidates).
   - `capacityFactorsShown`: off + anything → []; on + 9 measured → []; on + 10 measured → shown; on + entered → shown;
     `"true"` (a string) → [] (only `=== true`).
   - `personDetail`: no skill rows → null skills; skills → names; leave filtered and sorted; a made-up person → null.
3. **Absence worker:** in `people.test.ts` or a small new test, call `absenceTest(model, { personIds: [id] })` for a
   Larkspur sole holder. Its finding equals that person's finding from the full run (common random numbers). This
   proves a member's own result matches an editor's.
4. **Browser** `apps/web/test/people-browser.test.ts` (extend). The harness bundles `absence.worker.ts` too.
   `mountPeople` gains `horizon?: never` (not needed) and `capacityFactorEnabled?: boolean`, which sets
   `bundle.workspace.settings.capacity_factor_enabled`. Check which Larkspur people are sole holders with
   `absenceCandidates(toEngineModel(larkspurBundle()))` and pick from them; the brief expects Imogen (the only
   copywriter) to be one and Jess not to be. Cases, at 1440 and 400 px, with no console errors:
   - Editor (`everyone`): `[data-absence] tbody tr` count equals the number of candidates (at most 8), with rating
     chips. How busy shows the new columns at 1440.
   - Member `own: "imogen"`: one How busy row, one absence row (Imogen Reyes), no "Team member" or "A team member"
     anywhere in `[data-how-busy]`, `[data-absence]` or `[data-person-detail]`.
   - Member `own: "jess"`: no absence rows, and the "weren't tested" text.
   - Unlinked: the existing case, plus no absence rows.
   - The detail: click a name button, and `[data-person-detail]` shows "Can do" and a "Leave" line. Freya's detail
     lists her two skill steps. Ruby's leave (19–30 Oct 2026 in the Larkspur data) is filtered by today's date, so
     don't assert its dates in the browser. The unit tests cover leave with `today` pinned.
   - `capacityFactorEnabled: true`: the page text contains no "capacity factor" (case-insensitive).
   - The horizon picker: click "12 months", and that button gets `aria-pressed="true"` and How busy re-renders.
5. **Source tests:** keep `person-privacy-source.test.ts` green. Add an assertion that `people-page.tsx` calls
   `ownRowsOnly(` at least twice (the table and the absence rows).
6. **Run** everything per the builder brief: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter
   @transpera-flow/web build`. Take screenshots of `/demo/people` (light and dark, 1440 and 400 px) and describe them
   in the PR.

## Out of scope

- Capacity factors themselves: the switch, storage, engine, calibration (C6, #198, parked).
- Editing people on this page (Settings → People does it). Members editing their own record.
- Client assignments in the person detail (Q6).
- Ranking, sorting by how busy, "vs role" or median columns, any benchmark for people.
- Any cost or pay figure on this page.
- Changing absence settings (weeks away, absences a year): the rules editor was removed in B17 and defaults apply.
- Running the absence test at the picked horizon.
- MCP tools for the People page; share links (B3) and what they redact.
- Any migration, any `save_fields` change, any `ENGINE_VERSION` bump.

## Done

- [ ] `absenceRating` exported and used by `detectIssues`. Goldens untouched, no version bump.
- [ ] How busy shows client work, sales work, overtime, average with P90, and leave, under the horizon picker. No
      ranking.
- [ ] If someone is away: work lost, weeks to catch up and the rating per tested person. Members see and test only
      their own person.
- [ ] Client health and benchmark cards follow the horizon.
- [ ] Person detail with roles, hours, skills and leave. No capacity factor anywhere, with a test that it stays hidden
      with the setting on.
- [ ] Every new heading or column group has an (i) with a description and an example.
- [ ] Unit, engine and browser tests above. Full suite and build green. Screenshots described in the PR.
- [ ] PR (draft) `Closes #31`. The body lists "no migration, no engine version change" and the defaults taken below,
      so the orchestrator can record them on #31 and in the handover's "Design calls Claude made".

## Open questions (each with the default the builder uses)

- **Q1. Capacity factors.** The ticket wants them shown when enabled and measured or entered. Austin parked per-person
  speed (C6, #198), so nothing measures or stores them. *Default: don't build them. Add only the pure gate
  `capacityFactorsShown` and its test. The page passes `[]`, so nothing is ever shown.*
- **Q2. Which run the absence test uses.** *Default: the workspace's own length, like the Issues register and the
  Overview's facts, so ratings match across pages and a 24-month pick doesn't run (people + 1) × 10 two-year runs. The
  card says which length it used.* Alternative: follow the picker.
- **Q3. A member's absence test.** *Default: test only their own person (`personIds`). It's faster, gives the same
  numbers (common random numbers) and computes nothing about colleagues in their browser. An unlinked member runs no
  test.*
- **Q4. Person detail: an inline disclosure or its own page.** *Default: inline. No new route and no new server read.*
- **Q5. Workspaces with no named people** (made-up "Strategist 1" rows). *Default: members see none of them and get the
  "isn't linked" message, as since B1 2b. Showing made-up rows would be harmless but would change 2b's tested
  behaviour.*
- **Q6. Clients each person looks after in the detail.** *Default: not shown. The ticket doesn't ask for it; it's in
  Settings → Clients.*
- **Q7. What "leave" means in the table.** *Default: working days of leave inside the picked period. The detail lists
  every current and future leave period by date.*
- **Q8. Narrow screens.** *Default: client work, sales work, overtime and leave hide below `md`. The detail repeats them.*

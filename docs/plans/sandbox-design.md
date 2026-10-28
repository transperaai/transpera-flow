# Forecast sandbox: design draft

Draft for Austin to review, 27 Oct 2026. It builds on the cut list (`docs/plans/cut-list.md`, item 4) and on an inventory of
the engine's inputs (engine `EngineModel`, `packages/engine/src/model.ts`; patches in `packages/engine/src/scenario.ts`;
forecast plans in `apps/web/src/lib/forecast/*`). Nothing here is built yet. It comes after the cutover.

## What it is

The Forecast page becomes the **Sandbox**: a simulator over the coming months (1–24) that starts from the live company
model and lets you change anything the engine models. Nothing you do there changes live data.

- **A scenario** is a named, saved set of **changes**. A change is one lever with a value. It applies either to the
  **whole run** ("what if we always had 2 more designers") or **from a month on the timeline** ("hire a designer in March",
  "raise prices 8% from July"). The same lever can be used both ways.
- **Run** a saved scenario at any time. It always runs against today's live model, so a scenario saved in March still
  answers "what if" correctly in May.
- **Compare** up to three scenarios side by side, plus "No changes" (the baseline), with every figure as an average and
  a 10–90% range.
- **Build on a scenario:** a scenario can start from another one ("Plan B = Plan A + a price rise"). It keeps a link to
  its parent, so changing A changes B. Scenarios already have a parent link today.

This replaces today's forecast **plans** (hire, leave and solution markers) and the process-page **scenarios** (whole-run
levers) with one thing. Existing plans and scenarios are migrated into it.

## How changes reach the engine

There are four mechanisms. Each lever below names the one it uses.

1. **Patch:** changes the model before the run, for the whole run. This is today's `applyPatches` (set, multiply or
   add), extended with new patch fields where a lever needs one.
2. **Monthly channel:** a per-month multiplier the engine reads while it runs. The engine already has one, the market
   factors: 24 months × `leads, conv, cycle, price, churn`, each 0–5. The sandbox extends that table with new channels
   for step work time, step wait time, rework, role cost and hours available, and lets a scenario write its own values
   month by month. Timed changes to anything with a channel then cost nothing extra: one run, exact from the month.
3. **People over time:** a person row with a start and an end date (`from`/`until`, already in the engine for planned
   hires). A hire, a departure or an FTE change from a month becomes person rows with dates. That is one run, and
   exact.
4. **Splice (fallback):** for a structural change from a month (a solution going live, a routing change, a step moving to
   another role), run once per change month and join the monthly results at the month. This is what D46 does for
   solutions today. It is capped at 6 distinct change months per scenario to keep runs fast.

Engine work needed: the new monthly channels, wiring the market's `hire` and `pay` factors (held in the data but ignored
today), and new monthly outputs (below). Every engine change bumps ENGINE and refreshes the golden files
(`docs/engine-versioning.md`).

## The levers

Units and ranges are what the engine and database accept today unless marked **new**. "Timed" means it can be set from a
month.

### A. Market: opportunities and sales (Austin, 28 Oct)

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| A1 | **Opportunities coming in** | How many opportunities arrive a month, in total or per lead source. You set the number directly. | 0 – 50,000 a month | Yes | Patch **new** `lead_sources.<id>.volume_week` (entered a month, stored a week); timed through the `leads` channel |
| A2 | Lead quality, per source | Share of opportunities that are real (qualified) | 0–100% | Yes | Patch **new** `lead_sources.<id>.conversion`; timed through the `leads` channel |
| A3 | **Conversion rate** | Share of qualified opportunities won. It is **shown** as measured from the run (opportunities in, won, lost, rate) **and** can be changed. | ×0–5 of today's | Yes | `conv` channel (exists); **new** monthly outputs won, lost and arrivals |
| A4 | Sales cycle | How long a sale takes (external waiting before the decision) | ×0–5 | Yes | `cycle` channel (exists) |
| A5 | **Client value range, per type** **new** | The fee a new client of each service type pays, as a range (low – likely – high) instead of one number, so revenue shows the spread | ≥ 0 | Yes | **New** engine field `services.<id>.priceRange {low, mode, high}`: each won client's fee is drawn from a triangular distribution. A plain fee is the same with low = likely = high. |
| A6 | **Traffic by type, as %** | How opportunities split across service types, shown and set as percentages that add up to 100% | 0–100% each | Yes | Patch `services.<id>.mix_share` (exists), normalised to %; timed by splice |
| A7 | Seasonality | 12 monthly multipliers on opportunities | 0–500% each | Built in | Patch **new** `demand.seasonality.<month>` |
| A8 | Growth | Compound monthly growth in opportunities | −99% to +1000% a month | Yes | Patch **new** `demand.growth_monthly`; from a month through the `leads` channel |
| A9 | Market condition (shortcut) | A preset (Stable, Boom, Downturn, your own) that moves opportunities, conversion, sales cycle, price and churn together for a range of months | Up to 24 months | Yes | The scenario's own copy of the market schedule (exists) |

### B. Clients (Austin, 28 Oct)

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| B1 | **Clients on the book**, per type | Number of clients at the start | 0–2,000 a type | No (it's the start) | Patch **new** `client_groups.<service>.count` |
| B2 | **Fees**, per type | Monthly fee of existing clients | ≥ 0 | Yes | Patch `services.<id>.price` (exists) / **new** `client_groups.<id>.fee`; timed through the `price` channel |
| B3 | **Base churn**, per type | Monthly chance a client leaves for no particular reason | 0–100% | Yes | Patch **new** `services.<id>.churn_monthly`; timed through the `churn` channel |
| B4 | **Churn drivers, as chances** **new** | For each driver (late delivery, slow response, slow onboarding, rework, overload, hand-offs, poor results, tenure, price rise, market, your own): **the chance it happens** to a client in a month (%), and **how much it raises that client's chance of leaving** when it does (%) | 0–100% and 0–500% | Yes | **Engine change.** Today a driver is a weight times a pressure that every client feels equally. It becomes an event: each month each client has the driver's chance of being hit, and a hit raises that client's churn by the driver's effect for the following months. Drivers the engine measures (late delivery, response, rework, overload) keep using the measured chance by default, which you can override. |
| B5 | **Price rise** | Raise (or cut) the fee of existing and new clients by a %, from a month, per type | −100% to +400% | Yes | `price` channel, plus the price-rise churn driver (B4), so the rise carries its churn risk |

**Price rise, what it shows.** Next to a price rise the sandbox shows the trade-off: revenue gained from clients who stay,
revenue lost from the extra clients who leave, and the **net change in revenue**, month by month and over the run, with the
10–90% range. It also shows the break-even churn: how many extra leavers the rise can absorb before it loses money.

**Not in the sandbox (Austin, 28 Oct):** client health, winning or losing a named client from a month, and delivery hours
and service levels. They stay as they are in the live model but are not levers.

### C. Money

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| C1 | Role cost (pay) | Cost per hour by role | ≥ 0 or ×0–5 | Yes | Patch `roles.<id>.cost_rate` (exists); timed through the role cost channel |
| C2 | Overheads **new** | Fixed costs a month (rent, tools) | ≥ 0 | Yes | New model field `overheadMonthly` and a channel. It's held in settings today but unused. |
| C3 | Hourly billing **new** | Hourly services earn revenue for the hours worked | — | — | Engine fix: hourly pricing earns nothing today |

### D. People

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| D1 | Hire | A new person in a role, at an FTE, from a month, with an optional ramp-up (slower for the first N months) | FTE 0.1–1.5; ramp 0–6 months | Yes | People over time (exists); ramp through the person's capacity factor |
| D2 | Someone leaves | A person stops from a month | — | Yes | People over time: `until` (**new** as a lever) |
| D3 | Leave | A person away for some weeks | 1–52 weeks | Yes | Leave rows (exists) |
| D4 | FTE change | A person's FTE from a month | 0.1–1.5 | Yes | Two person rows split at the month |
| D5 | Headcount by role (quick) | Set the number in a role | 0 – count + 20 | Yes | Patch `roles.<id>.headcount` (exists); timed through hires and leavers |
| D6 | Working week | Hours a week, overtime allowed, time kept free for pipeline work | 1–168 h; 0–100%; 0–99% | Yes | Patch **new** `settings.{hours_per_week, overtime_cap, availability_floor}`; timed through the hours channel |
| D7 | Speed, per person | Capacity factor: how fast this person works, overall or on a step | 0.5–2 | Yes | Patch **new** `people.<id>.capacity_factor[.<step>]`; timed by splice |
| D8 | Skills | Who can do which steps | Add or remove | Yes | Patch **new** `people.<id>.skills`; timed by splice |
| D9 | Hiring delay (later) | How long a hire takes to start | 0–6 months | Yes | Wire the market's ignored `hire` factor |
| D10 | Pay inflation (later) | Role cost rises over time | ×0–5 | Yes | Wire the market's ignored `pay` factor: role cost channel |

### E. Process

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| E1 | Step time | Hands-on hours, per step or by role | ×0.1–2 or set | Yes | Patch `steps.<id>.work_hours` (exists); timed through the step-work channel |
| E2 | Waiting time | External wait, per step | ×0.1–2 or set | Yes | Patch `steps.<id>.wait_hours` (exists); step-wait channel |
| E3 | Rework | Chance a step is done again | 0–95% | Yes | Patch `steps.<id>.rework_rate` (exists); rework channel |
| E4 | Routing | Split of work between paths after a step | 0–100% per path | Yes | Patch **new** `edges.<id>.p`; timed by splice |
| E5 | Who does a step | Move a step to another role or person | — | Yes | Patch **new** `steps.<id>.{role, person}`; timed by splice |
| E6 | Solutions go live | A designed process change goes live from a month | Up to 4 a scenario | Yes | Splice (exists, D46/D48) |
| E7 | Work in progress at the start | Queue at each step on day one | ≥ 0 | No | Patch **new** `steps.<id>.current_wip` |
| E8 | Variability | How unpredictable step times are (spread) | Low, normal, high | No | Patch **new** on the work and wait distributions |

### F. The run itself

| # | Setting | Range | How |
|---|---|---|---|
| F1 | Horizon | 12 months by default; 3, 6 or 24 months; or **custom**, any number of months from 1 to 24 | `horizonWeeks` (exists) |
| F2 | Start month | This month, or a custom future month | `toEngineModel` start date (exists) |
| F3 | Precision | Quick (30 runs) or precise (200 runs, slower) | Replications (fixed at 30 today) |

The lever list in Settings → Levers keeps its role: it chooses which levers this workspace shows. That keeps the sandbox
simple for a client who only needs a few.

### G. Time and what it achieves (Austin, 28 Oct)

Austin wants to see where working time goes and what each piece of work achieves, as percentages, in the spirit of the
first principles.

- **Purpose categories.** Each step gets one category saying what it achieves. A workspace has its own list, in
  Settings → Processes. The default list is:
  - **Moves the client's job forward:** the work the client pays for.
  - **Required:** compliance and admin that must be done.
  - **Winning work:** sales and onboarding.
  - **Coordination:** hand-offs, meetings and chasing.
  - **Fixing:** rework and corrections.
  - **Could be removed:** steps the first principles mark to delete.

  A step marked "delete" in its process's first principles defaults to "Could be removed". The category is set in the
  editor, and it is the same for every run.
- **What it shows:**
  - Hours of hands-on work, and the % of all working time, per category.
  - Per month, per role and per person.
  - Rework time counted under "Fixing" whatever the step's own category.
  - Idle and uncovered time next to it, so 100% is the whole capacity.
  - In compare, how each scenario shifts the split: removing a "Could be removed" step, cutting rework, or adding a
    hire.
- **Levers:** no new lever. Every process lever (E1–E8) and people lever moves these numbers.
- **How it's built:** a **new** monthly engine output, hands-on hours per step (and per rework), summed by category in
  the app. Plus a **new** column `steps.purpose` and a workspace list of categories, with a migration that fills in the
  defaults.

## What it shows

Every figure appears per month and over the whole run, as an average and a 10–90% range:

- **Revenue:** recurring revenue (exists). **New:** billed revenue, revenue from new clients, revenue lost to churn.
- **Clients:** active clients per type (exists). **New:** clients won and lost per month, and why they left (base churn or which driver).
- **Sales:** **new** opportunities arriving, won, lost, **conversion rate**, time to win.
- **Price rise:** revenue gained, revenue lost to extra churn, net change, break-even churn (B5).
- **Time and purpose:** hours and % of working time per purpose category (G).
- **Capacity:** how busy each role and person is, uncovered hours, waits, late tasks (all exist). **New:** overtime
  hours.
- **Money:** **new** labour cost, overtime cost, overheads, and **profit**, once C2 and C3 are in.
- **Alerts:** months too busy, uncovered work, clients at risk, with each alert linking to the lever that would help.
  The alerts use the workspace's own thresholds, not the defaults (a gap today).

Compare view: the scenarios as columns, the difference from "No changes" highlighted, and one chart per measure with
each scenario's band.

## Saving and data

- A new table, `sandbox_scenarios (id, workspace_id, name, description, parent_id, changes jsonb, horizon_months,
  start_date?, created_by, updated_at)`. A change is `{lever, target, op: set|multiply|add, value, from?: 'YYYY-MM',
  until?: 'YYYY-MM'}`. It is checked in SQL, as scenario patches are today. Limits: 200 changes, 6 distinct change months
  for spliced levers, 4 solutions.
- Results are never stored. They are re-run from today's live model, as forecast plans are today, so a scenario can't
  go stale. A scenario that refers to something that no longer exists (a person who left, a deleted step) shows that
  change as broken and skips it, with a note (as `resolveScenario` does today).
- **Who uses it (Austin, 28 Oct):** Austin and the client's founder and head of CS. In each deployment, the sandbox is
  open to **Admins and Editors** of "Who can sign in", so the founder and the head of CS need the Editor role at least.
  Viewers can open and run saved scenarios but can't save. Levers and figures that show one person's pay follow the
  existing pay privacy (B1).
- **MCP (read-only, decision 1b):** `list_scenarios` and `run_scenario` let Claude or ChatGPT run a saved scenario and
  report on it. Running is a read; nothing is saved.

## Other suggestions

1. **Goal seek:** "How many designers do I need to stay under 85% busy all year?" or "What price keeps churn under 3%?"
   You pick a target and one lever, and the sandbox searches the lever's range (bisection, about 6–8 runs).
2. **What matters most (tornado chart):** move each lever by ±10% and rank them by how much they change profit or
   clients at risk. This shows where to focus.
3. **Break-even and timing:** the month a hire pays for itself; the month capacity runs out at the current growth.
4. **Assumptions log:** each scenario gets a short note per change ("assumes the Q3 campaign doubles leads"), shown in
   compare and in exports.
5. **Export:** a scenario or a comparison as CSV and as a one-page PDF summary for a client.
6. **Read-only share link to a scenario,** using the share-link machinery (people and pay hidden as today), so a client
   can see the plan without signing in.
7. **Make the finance real first:** wire margin, overheads and hourly billing (C2, C3), so profit means something.
   Otherwise the money levers move revenue but no costs.
8. **Fix the silent levers:** today the "active clients" and "monthly churn" sliders do nothing in a workspace with
   client groups or a named roster. The sandbox should only offer a lever that will move the result for this workspace,
   and say why when one doesn't apply.

## Suggested build order (each phase is shippable)

1. **One scenario model.** The new table, migrating plans and scenarios; the sandbox page with saving, running and
   comparing; every lever that exists today as a patch or marker, whole-run or timed. Mechanisms: patches, people
   over time, splice.
2. **Engine changes for Austin's levers:** churn drivers as chances (B4), client value ranges (A5), and the price-rise
   trade-off (B5). Then monthly channels for step work, step wait, rework, role cost and hours, and every remaining timed
   lever from A–E. ENGINE minor bump; goldens refreshed.
3. **Finance and new outputs:** overheads, hourly billing, labour and overtime cost, profit, plus the new monthly
   series (opportunities, won, lost, conversion, billed revenue, overtime), and time by purpose (G).
4. **Extras:** goal seek, tornado chart, exports, the read-only share link, MCP `list_scenarios`/`run_scenario`.

## Decided (Austin, 28 Oct)

- Market: set opportunities directly, see the conversion rate, a value range for clients, traffic by type in %.
- Clients: clients on the book, fees, base churn, churn drivers as chances, and price-rise simulation with its churn and
  revenue effect. Client health, named clients joining or leaving, and delivery hours and service levels are not levers.
- Users: Austin plus the client's founder and head of CS.
- Horizon: 12 months by default, with a custom option.
- Time spent working and the purpose of each task, as percentages (G).
- Compare three scenarios side by side.
- Changes can be whole-run or timed; scenarios are saved, run and compared.

## Questions for Austin

1. **Profit:** do you want profit early (overheads, staff cost and hourly billing, phase 3), before the timed levers of
   phase 2?
2. **Purpose categories (G):** is the default list right, or do you have your own categories?
3. **Head of CS:** should they be able to save scenarios (Editor), or only run the ones you save (Viewer)?

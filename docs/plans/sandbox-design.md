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

### A. Leads and sales

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| A1 | Lead volume, per lead source | Enquiries a week from that source | 0 – 10,000 /wk; or ×0–5 | Yes | Patch **new** `lead_sources.<id>.volume_week`; timed through the `leads` channel |
| A2 | Lead quality, per source | Share of enquiries that become qualified leads | 0–100% | Yes | Patch **new** `lead_sources.<id>.conversion`; timed through the `leads` channel |
| A3 | Win rate | How often a qualified lead is won (scales the win/lose split) | ×0–5 | Yes | `conv` channel (exists) |
| A4 | Sales cycle | External waiting before the sale | ×0–5 | Yes | `cycle` channel (exists) |
| A5 | Seasonality | 12 monthly demand multipliers | 0–5 each | Built in | Patch **new** `demand.seasonality.<month>` |
| A6 | Growth | Compound monthly growth in leads | −99% to +1000% a month | Yes | Patch **new** `demand.growth_monthly`; from a month through the `leads` channel |
| A7 | Service mix | Share of new clients choosing each service | ≥ 0 relative | Yes | Patch `services.<id>.mix_share` (exists); timed by splice |

### B. Market

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| B1 | Market condition, per month | Pick a preset (Stable, Boom, Downturn, your own) for a range of months | 24 months | Yes | The scenario's own copy of the market schedule |
| B2 | Market factors by hand | Per month: leads, win rate, sales cycle, price, churn | 0–500% each | Yes | Writes the channels directly |
| B3 | Hiring market **new** | How long a hire takes to start and ramp up | 0–6 months delay | Yes | Wire the ignored `hire` factor: it delays hire markers |
| B4 | Pay market **new** | Pay inflation applied to role cost | ×0–5 | Yes | Wire the ignored `pay` factor: role cost channel |

### C. Clients and retention

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| C1 | Clients on the book, per group or service | Starting number of clients | 0–2,000 a group | No (it's the start) | Patch **new** `client_groups.<service>.count` |
| C2 | Fee, per group or service | Monthly fee | ≥ 0 | Yes | Patch `services.<id>.price` (exists) / **new** `client_groups.<id>.fee`; timed through the `price` channel |
| C3 | Base churn, per service | Monthly chance a client leaves | 0–100% | Yes | Patch **new** `services.<id>.churn_monthly`; timed through the `churn` channel |
| C4 | Churn drivers | Weight 0–3 and value of each driver: late delivery, response time, onboarding target, rework, workload, hand-offs, results score, tenure, price rise, market, your own | Per driver | Yes (price rise has a month) | Patch **new** `churn_drivers.<id>.{weight,value,month,enabled}` |
| C5 | How health reacts | Starting health, recovery, penalty per late or missed task | As today | No | Patch `health.*` (exists) |
| C6 | Win or lose a named client **new** | A client joins or leaves from a month | — | Yes | Client row with dates (like people over time) |
| C7 | Service delivery load, per service | Hours per client a month by role; servicing frequency and SLA | ≥ 0; SLA 1–10,000 h | Yes | Patch **new** `services.<id>.{ongoing.<role>, servicing.<n>.{times, sla_hours}}`; timed by splice |

### D. Pricing and money

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| D1 | Price change, per service | Raise or cut prices for new and existing clients | −100% to +400% | Yes | `price` channel. It also feeds the "price rise" churn driver automatically, so a rise has its churn cost. |
| D2 | Role cost (pay) | Cost per hour by role | ≥ 0 or ×0–5 | Yes | Patch `roles.<id>.cost_rate` (exists); timed through the role cost channel |
| D3 | Overheads **new** | Fixed costs a month (rent, tools) | ≥ 0 | Yes | New model field `overheadMonthly` and a channel. It's held in settings today but unused. |
| D4 | Hourly billing **new** | Hourly services earn revenue for the hours worked | — | — | Engine fix: hourly pricing earns nothing today |

### E. People

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| E1 | Hire | A new person in a role, at an FTE, from a month, with an optional ramp-up (slower for the first N months) | FTE 0.1–1.5; ramp 0–6 months | Yes | People over time (exists); ramp through the person's capacity factor |
| E2 | Someone leaves | A person stops from a month | — | Yes | People over time: `until` (**new** as a lever) |
| E3 | Leave | A person away for some weeks | 1–52 weeks | Yes | Leave rows (exists) |
| E4 | FTE change | A person's FTE from a month | 0.1–1.5 | Yes | Two person rows split at the month |
| E5 | Headcount by role (quick) | Set the number in a role | 0 – count + 20 | Yes | Patch `roles.<id>.headcount` (exists); timed through hires and leavers |
| E6 | Working week | Hours a week, overtime allowed, time kept free for pipeline work | 1–168 h; 0–100%; 0–99% | Yes | Patch **new** `settings.{hours_per_week, overtime_cap, availability_floor}`; timed through the hours channel |
| E7 | Speed, per person | Capacity factor: how fast this person works, overall or on a step | 0.5–2 | Yes | Patch **new** `people.<id>.capacity_factor[.<step>]`; timed by splice |
| E8 | Skills | Who can do which steps | Add or remove | Yes | Patch **new** `people.<id>.skills`; timed by splice |
| E9 | Client assignments | Who looks after which client | — | No | Patch **new**; later |

### F. Process

| # | Lever | What it changes | Range | Timed | How |
|---|---|---|---|---|---|
| F1 | Step time | Hands-on hours, per step or by role | ×0.1–2 or set | Yes | Patch `steps.<id>.work_hours` (exists); timed through the step-work channel |
| F2 | Waiting time | External wait, per step | ×0.1–2 or set | Yes | Patch `steps.<id>.wait_hours` (exists); step-wait channel |
| F3 | Rework | Chance a step is done again | 0–95% | Yes | Patch `steps.<id>.rework_rate` (exists); rework channel |
| F4 | Routing | Split of work between paths after a step | 0–100% per path | Yes | Patch **new** `edges.<id>.p`; timed by splice |
| F5 | Who does a step | Move a step to another role or person | — | Yes | Patch **new** `steps.<id>.{role, person}`; timed by splice |
| F6 | Solutions go live | A designed process change goes live from a month | Up to 4 a scenario | Yes | Splice (exists, D46/D48) |
| F7 | Work in progress at the start | Queue at each step on day one | ≥ 0 | No | Patch **new** `steps.<id>.current_wip` |
| F8 | Variability | How unpredictable step times are (spread) | Low, normal, high | No | Patch **new** on the work and wait distributions |

### G. The run itself

| # | Setting | Range | How |
|---|---|---|---|
| G1 | Horizon | 1–24 months | `horizonWeeks` (exists) |
| G2 | Start date | Today or the 1st of a coming month | `toEngineModel` start date (exists) |
| G3 | Precision | Quick (30 runs) or precise (200 runs, slower) | Replications (fixed at 30 today) |

The lever list in Settings → Levers keeps its role: it chooses which levers this workspace shows. That keeps the sandbox
simple for a client who only needs a few.

## What it shows

Every figure appears per month and over the whole run, as an average and a 10–90% range:

- **Revenue:** recurring revenue (exists). **New:** billed revenue, revenue from new clients, revenue lost to churn.
- **Clients:** active clients per service, at-risk clients (both exist). **New:** won, lost, average health.
- **Sales:** **new** leads arriving, won, lost, time to win.
- **Capacity:** how busy each role and person is, uncovered hours, waits, late tasks (all exist). **New:** overtime
  hours.
- **Money:** **new** labour cost, overtime cost, overheads, and **profit**, once D3 and D4 are in.
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
- Who sees it: owners, editors and agency admins, as for plans today, because leave and pay name people. Viewers see
  shared scenarios with pay hidden (`payHidden`).
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
7. **Make the finance real first:** wire margin, overheads and hourly billing (D3, D4), so profit means something.
   Otherwise the money levers move revenue but no costs.
8. **Fix the silent levers:** today the "active clients" and "monthly churn" sliders do nothing in a workspace with
   client groups or a named roster. The sandbox should only offer a lever that will move the result for this workspace,
   and say why when one doesn't apply.

## Suggested build order (each phase is shippable)

1. **One scenario model.** The new table, migrating plans and scenarios; the sandbox page with saving, running and
   comparing; every lever that exists today as a patch or marker, whole-run or timed. Mechanisms: patches, people
   over time, splice.
2. **Monthly channels in the engine:** step work, step wait, rework, role cost and hours; the `hire` and `pay`
   factors; then every remaining timed lever from A–F. ENGINE minor bump; goldens refreshed.
3. **Finance and new outputs:** overheads, hourly billing, labour and overtime cost, profit, plus the new monthly
   series (won, lost, billed revenue, health, overtime).
4. **Extras:** goal seek, tornado chart, exports, the read-only share link, MCP `list_scenarios`/`run_scenario`.

## Questions for Austin

1. **Who uses the sandbox:** only your team (owners, editors, agency admins), or should clients' viewers also play with
   it?
2. **Default horizon:** 12 months, or longer?
3. **Which levers matter most to you:** this sets the order inside phase 1.
4. **Comparison:** are three scenarios side by side enough?
5. **Profit:** do you want profit (phase 3) early, even before the timed levers of phase 2?

# Client requirements: capacity and clients per employee

Written 31 Oct 2026 from the client's nine discovery sessions. Follows `docs/plans/client-refocus-handover.md`.
**Austin decides scope: mark this up before anything is built.**

This is the product spec for the refocused app:
- what it answers;
- what it shows;
- what people key in or toggle;
- how a step captures current and future state.

Values come from the transcripts and become the defaults. Each lever has a status against the engine and app today:

- **Have:** works today; it just needs data entered.
- **Small:** a small change to the engine, database or a page.
- **New:** new to build.

The transcripts and per-transcript extracts are not in the repo. People are named by role.

**Sources**

| Key | Session | Date | Client speaker(s) |
|---|---|---|---|
| SC | Scoping session (leadership) | 22 Oct | Founder & Principal Consultant; Head of Client Services |
| PD | Discovery interview | 28 Oct | Performance Marketing Director |
| SD | Discovery interview | 28 Oct | SEO Director |
| LB | Workflow interview | 29 Oct | Senior SEO Manager & Linkbuilding Lead |
| SP1 | Workflow interview | 29 Oct | Senior Performance Marketing Manager (5 months in) |
| CM | Workflow interview | 29 Oct | Content Manager |
| SP2 | Workflow interview | 30 Oct | Senior Performance Marketing Manager (14 clients) |
| PM | Workflow interview | 30 Oct | Performance Marketing Manager |
| MC | Mid-point check-in | 30 Oct | Founder |

## Decisions recorded

| # | Decision | Date |
|---|---|---|
| D1 | The Founder's goal is **DLER from 3:1 to 4.5:1** (said as "3:1 to 4:5"). DLER = money under management ÷ salaries, per department. | 31 Oct, Austin |
| D2 | There are no more transcripts. Missing values are keyed in later by the Founder (D3–D5), or asked of the client (section 9). | 31 Oct, Austin |
| D3 | **Client count per tier** is entered later by the Founder. The app must have a place for it. | 31 Oct, Austin |
| D4 | **Each employee's portfolio ("patch")** is entered later. The app must have a place for it. | 31 Oct, Austin |
| D5 | **Tier 1 clients are named one by one**, each with its own values: hand-holding hours, ad-hoc requests, meeting cadence, assigned people. The Founder keys them in. Tier 2 and 3 can stay as counts. | 31 Oct, Austin |
| D6 | Step work split has **three parts**: automatable / augmentable / manual. | 31 Oct, Austin |
| D7 | Tier multipliers live **on each step**. | 31 Oct, Austin |
| D8 | Adoption is set **per change**. | 31 Oct, Austin |
| D9 | DLER's "money under management" is **retainer revenue only** (no ad spend). | 31 Oct, Austin |
| D10 | DLER's salary base **includes directors' and managers' salaries** (Austin's view; confirm with the client). | 31 Oct, Austin |
| D11 | **First version answers A1–A9.** A10 (earnings per hour by tier) and A11 (retention under load) come later. | 31 Oct, Austin |
| D12 | **Cut:** scenario share links and first principles. **Kept** (not cut): solutions (for routing changes), price rises and value ranges, the block library. | 31 Oct, Austin |
| D13 | **Channels per client are modelled in the first version** (per tier, overridable per named client), and channels per person are shown. | 31 Oct, Austin |
| D14 | **Later:** work priority by tier, and recurrence pinned to week of month. | 31 Oct, Austin |
| D15 | **Out of scope:** live client health / red-flag dashboards (ops tooling, not simulation). | 31 Oct, Austin |
| D16 | **Clients per employee counts client-facing people only.** Shared teams (content, links, tech, implementers) are shown as their own capacity. | 31 Oct, Austin |
| D17 | **The overload threshold is set per role** (default 85%). | 31 Oct, Austin |
| D18 | **The Owner and Agency admins** key in and edit clients, tier counts, portfolios and baselines. Viewers view. | 31 Oct, Austin |
| D19 | **No data request to the client.** Joe keys in his own data once he has the app, so the build provides the fields and screens (section 4), with sensible defaults from section 3–6 until he does. | 31 Oct, Austin |
| D20 | **Clickable HTML prototypes** of the new screens before the build briefs: Capacity page, "Add N clients", client entry, step baselines and changes. | 31 Oct, Austin |
| D21 | **Cut all share links** and the older process-level lever system; **keep Issues** (solutions and changes anchor to them); **hide Sources**; **remove `/demo`**. See `docs/plans/keep-cut-build.md`. | 31 Oct, Austin |
| D22 | **Overview is per department** (Organic and Performance in separate widgets), plus a whole-business row. Shows clients, **clients per employee = department clients ÷ everyone in the department** (not only client-facing), **revenue per employee** (retainers ÷ everyone in the department; contractors and leadership left out), DLER, people over their line, room for more. | 31 Oct, Austin |
| D23 | **Capacity has no total ÷ headcount averages.** Each person's own client count and their **max at the line**; the headline shows **clients with Organic services, with Performance services, and taking both**. New data point: which clients take both (a box on named clients; a count per tier for counted clients). | 31 Oct, Austin |
| D24 | **DLER** is shown per department and for the whole business (**all retainers ÷ all salaries**), without ":1". | 31 Oct, Austin |
| D25 | **The company map keeps all its current controls** (play, speed, scrubber, horizon, click through). | 31 Oct, Austin |
| D26 | **Tiers can be added and removed.** Ad-hoc requests per tier (overridable per named client) are **chance a client asks in a month × requests when they ask × size of each**. | 31 Oct, Austin |
| D27 | **Shared teams work in their own unit and rate**: content in words (writing and editing words an hour), link outreach in links, tech in ticket hours, Performance specialists in tasks (campaign builds, creative sets, PPC hygiene), tracking in set-ups and incidents. Full role list to confirm. | 31 Oct, Austin |
| D28 | **Every baseline in Set up (lead flow, market, churn and the rest) is also a Sandbox lever.** The Sandbox design is to be agreed in a dedicated session. | 31 Oct, Austin |

## What the transcripts tell us, in five lines

1. **There are no timesheets, and leadership won't add them** ("Big Brother. Not much gain.", Founder, SC). The client
   measures capacity with DLER (3:1 minimum; recent readings 2.75 and 3.2), with "share of a person's portfolio MRR =
   share of their time" (SC), and with channels per person in Performance ("My max would be like 10 channels", PD). The
   app should speak these units next to hours.
2. **Retainers buy deliverables.** A pricing calculator turns the fee into words, links, tech hours and manager hours.
   For example, a 6K client gets 5 links, 3,000 words, about 5 tech hours and about 5 SEO-manager hours (LB). The
   calculator defines per-tier workload.
3. **Organic and Performance load differently.**
   - **Organic:** client managers hold 9–19 clients (rule of thumb about 10). They feed shared teams: content (about
     100k words a month), links (about 300 a month) and technical.
   - **Performance:** load grows with channels too. Managers hold 12–20 clients, and all say they are at or near full.
4. **Steps split into gather / judge / check.** Staff want the gathering automated and the judgement kept. The base
   values on each step should capture that split (section 7).
5. **The top automations:**
   - **Performance:** pacing and alerts (raised in 5 of 9 sessions).
   - **Organic:** onboarding, content briefs and handoff, and link vetting and monitoring.
   - **Writing, strategy, relationships and QA stay human.**

---

## 1. Questions the app will answer

Written as the Founder will ask them. Each one is one screen or one result in the app. Priority is our
recommendation (Must / Should / Later); Austin decides.

| # | The Founder asks | The answer looks like | Inputs | Status | Priority |
|---|---|---|---|---|---|
| A1 | **"If I add 5 new clients, what will that do?"** Joe chooses the number, the tier of each, the department (Organic, Performance or both) and timing (all at once or spread) | Month by month: busy share per person through **onboarding**, then **month-to-month servicing**; who takes each client; who goes over 85% and when it settles; the **time needed to serve them** (hours a month by tier, task and role); DLER before and after | tier counts (D3), portfolios (D4), step baselines | Have (a run with more clients). New: pick-and-add form, assignment to the least-busy person, per-person timeline on the Capacity page | Must |
| A2 | **"Are we at capacity, or can we still fit new clients? How many?"** (the reverse of A1) | Busy share per person, role and department, with anyone over 85% flagged; "about N more Tier 2 (or M Tier 1) before anyone passes 85%", and who breaks first | as A1 | Have (busy share). New: goal seek over the client count, Capacity page | Must |
| A3 | **"Where are the bottlenecks in my business?"** | The person or role that fills first, and the work waiting on them. Likely candidates: content editors, link vetting (one person), directors' team time | as A1 | Have (busy share, waits, queues). Small: a named "bottleneck" readout | Must |
| A4 | **"What takes the most time in managing clients?"** | Hours per client a month by task, tier and role, plus each named Tier 1 client, shown with ranges and where each number came from (no timesheets) | step baselines | Have (time by purpose). Small: by tier and per client | Must |
| A5 | **"With automation X or augmentation Y, how many more clients can each person take?"** | Clients per employee now against with the change; hours freed per person a month; side by side for up to 3 changes | A1 + changes (section 7) | New | Must |
| A6 | **"What does that do to DLER? Can we get from 3:1 to 4.5:1?"** | DLER per department (retainer ÷ salaries) now, at max clients, and with each change; clients needed to reach 4.5:1 | salaries, fees, portfolios | New | Must |
| A7 | **"Which change frees the most time?"** | Changes ranked by hours freed, or by extra clients per employee | changes | Have ("what matters most"), once changes exist | Must (D11) |
| A8 | **"When do I need to hire, and whom?"** | The month each role passes 85%, given expected wins, market and hiring delay | lead flow, market | Have. Small: hiring-trigger readout | Must (D11) |
| A9 | **"What if someone leaves?"** (suggested: a 19-client manager just resigned; key relationships sit with two directors) | Whose clients go where; who goes over; how long until a hire ramps up (90 days) | portfolios, end dates | Have (end dates). Small: reassignment readout | Must (D11) |
| A10 | **"Which tier earns the most per hour of effort?"** (suggested) | Retainer ÷ hours to serve, per tier and per named Tier 1 client: DLER per client | fees, step baselines | Small | Later (D11) |
| A11 | "What happens to retention if we push clients per person up?" | Clients at risk and churn as load rises | churn drivers | Have | Later |

**Definition of "clients per employee"** (needs Austin's sign-off):

| Measure | Formula |
|---|---|
| Per person | clients in their portfolio |
| Per role | clients in the role's portfolios ÷ people in the role |
| Per department | the department's clients ÷ its client-facing head count. Shared-team people (content, links, tech) are shown separately as capacity, not counted as "clients per employee" |

**How new clients are placed** (A1, A2): each one goes to the least-busy person in the role who can serve that tier,
unless the Founder picks the person. For A2, clients are added until the first person or role passes 85%, spread by
the current tier mix or held to one tier.

## 2. Stats to show

| Stat | Why / who asked | Value today | Status | Priority |
|---|---|---|---|---|
| **Busy share** per person, role and department (with a 10–90% range) | A1, A2; Founder brief | unknown (no timesheets) | Have | Must |
| **Clients per employee** (person, role, department), with tier mix | A2; Founder brief | 4–20 per person (section 3) | New | Must |
| **Channels per employee** (Performance) | PD: cap of 10 | Director 18; SP2 24 for 14 clients | New | Must |
| **Headroom**: extra clients per tier before the threshold | A2 | — | New | Must |
| **With-change comparison**: clients per employee, hours freed, busy share, side by side | A5 | — | New (scenario compare exists: Have) | Must |
| **DLER** per department (retainer ÷ salaries, D9), and **revenue per employee** | A6; Founder | min 3:1; 2.75 and 3.2; goal 4.5:1 | New | Must |
| **Hours per client per month** by tier and per named Tier 1 client, split by task and role | A1, A4; LB wants allocation against actual | calculator example only | Small | Must |
| **Where the time goes** by purpose (client service, onboarding, management, admin, sales support) | A4; SD 60/40, PD 50/50 | — | Have | Must |
| **Retainer per hour of effort** by tier and per named Tier 1 client | A10 | — | Small | Should |
| **MRR per person against target** (the "share of MRR = share of time" rule) | Head of Client Services (SC) | $11k ≈ 30–33% of one manager's book | Small | Should |
| **Bottleneck** (busiest person or role and the work waiting on them) | A3 | — | Have. Small: readout | Must |
| **Onboardings in flight** and their hours | A1; SC: "the most common cause of stretch" | 0–3 at once | Small | Must |
| **Late work and SLA misses** (24h email, turnaround) | SP1 | — | Have | Should |
| **Clients at risk and churn** | A11 | rate unknown | Have | Later |
| Live client health and red flags (rankings, CPL, pacing) | asked most by staff (SD, SP2, PM, MC) | — | Out of scope (D15) | — |

## 3. Employee levers and values

**Per person** (keyed in on the People page)

| Lever | Unit | Value from transcripts | Status |
|---|---|---|---|
| Role(s) | — | org chart | Have |
| Hours a week (or FTE) | h/week | unknown, ask (8-hour days mentioned, MC) | Have |
| Leave | days/year | unknown, ask | Have |
| Start / end date | date | one SEO manager has resigned; Head of Performance vacant | Have |
| Cost | $/h or salary | cost about $80/h; billing $120–150/h (SC) | Have (cost per hour). Small: salary input for DLER |
| Speed factor (overall or per step) | × (0.5–2) | seniors faster (inferred); no numbers | Have |
| Skills (which steps) | — | e.g. link vetting is the Senior SEO Manager only | Have |
| **Tiers they can serve** | Tier 1/2/3 | Tier 1 contractually needs senior people (SC) | New (could be done with skills per tier process) |
| **Portfolio (patch)**: their clients, by name (Tier 1) or count per tier (Tier 2/3) | clients | D4: keyed in later | Small for named (assignments exist). New for counts per person |
| **Reserved management share** (team leading, mentoring, reviews) | % of hours | SEO Director 40% (SD); Performance Director 50% (PD); directors carry about 55% of a manager's MRR (SC) | Small (today the availability floor is workspace-wide) |
| **Max-clients rule of thumb** (shown as a line, not enforced) | clients | about 10 for SEO client managers (SD); none stated elsewhere | Small |
| **Channel cap** | channels | 10 (PD) | New |
| **Ramp for new starters** | days to % | 90 days to about 80% (SC) | Small |
| Offshore / contractor flag | — | 4 offshore (SC); link team of 2 (LB) | Small (label only) |

**Freelancers** (content)

| Lever | Value | Status |
|---|---|---|
| Number of freelancers | 4; 2 on contract with fixed monthly words (CM) | Have (as people) |
| Words a month each | unknown, ask | Small (capacity in words, not hours) |
| Turnaround | at most 2 weeks (CM) | Have (wait) |
| Cost per word | unknown, ask | Small |

**Workspace**

| Lever | Value | Status |
|---|---|---|
| Overload threshold, **per role** (D17) | 85% default | Small |
| Overtime cap | some overtime in heavy onboarding months (LB) | Have |
| Hiring delay | "Takes time to hire" (SC); unknown, ask | Have |

**Portfolios today** (defaults until the Founder keys in the real ones, D4)

| Role | Clients | Time on own clients | Load | Source |
|---|---|---|---|---|
| SEO Director | 12 | 60% (first said 70%) | nearing capacity | SD |
| SEO client managers | 9–19 each | — | at capacity; rule about 10 | SD |
| Senior SEO Manager & Linkbuilding Lead | 12–13 (bigger retainers) | — | "close to" cap | LB |
| Performance Marketing Director | 4 clients / about 18 channels, mostly Tier 1 | 50% | stretched (cap 10 channels) | PD |
| Senior PMM (SP1) | about 12 (1 Tier 1, 1 near-Tier 1, rest Tier 2/3) | — | +7–10 "would be a lot" | SP1 |
| Senior PMM (SP2) | 14 clients / 24 channels | 60–70% on the tools | "working at full capacity" | SP2 |
| PMM | about 20, mostly Tier 2/3 | — | overwhelmed "sometimes" | PM |
| Content Manager | 1–2 Tier 1 directly; edits all freelance work | — | OK | CM |

**Shared teams** (capacity, not clients)

| Team | Make-up | Throughput | Source |
|---|---|---|---|
| Content | 2 copywriters + content specialist + Content Manager + 4 freelancers; 2 editors | 100k words a month; KPI 20k words per writer a month | CM |
| Links | 2 offshore; link vetting by the Senior SEO Manager | about 300 links a month | LB |
| Technical | about 3 (2 new) | — | SD |
| Performance implementers | 2–3 specialists / coordinator | 1–2 days per implementation task | SP2, PM |

## 4. Client levers: what the Founder keys in (D3–D5)

Three places to enter clients. All three must work together in one workspace.

| Entry | Fields | Where | Status |
|---|---|---|---|
| **Tier counts** (D3), for Tier 2 and 3, and Tier 1 if not named yet | per tier: client count, fee per client a month (or range), churn a month, typical stay, starting health | Settings → client groups | **Have** |
| **Named Tier 1 clients** (D5) | name; tier; fee a month; start date; health; assigned person per role. **Plus per-client overrides:** extra hand-holding hours a month (per role); ad-hoc request rate a month and size; meeting cadence and length; channels; deliverables (words, links, tech hours); bespoke recurring tasks (e.g. weekly localisation work) | People → clients (roster) | Partly Have (name, fee, health, start, assignments). **New:** per-client overrides |
| **Portfolios** (D4) | per person: named clients (from the roster), and counts per tier for counted clients | People page | Small for named; **New** for counts per person |

**Two changes make this work:**
1. **Named and counted clients in the same run.** Today a workspace uses one or the other: once any tier has a count,
   the named roster is ignored (`clientGroups` in `packages/db/src/model.ts`). Needed: named clients run alongside the
   counts, and a tier's count means "unnamed clients in addition to the named ones". This is the main structural
   change, size **Small–New**.
2. **Per-client overrides on top of the tier's defaults.** A named client inherits everything from its tier, and any
   field the Founder fills replaces it. **New.**

Every keyed-in value records who entered it and whether it is a real figure or an estimate (provenance exists: Have).

## 5. Lead flow and market levers

| Lever | Unit | Value from transcripts | Status |
|---|---|---|---|
| Lead sources and volume | leads/month per source | sources: partner referrals, Meta ads, inbound; outbound weak since 2024 (SC). Volume unknown, ask | Have |
| Win rate | % | about 1 in 10 now (was 1 in 3); stage unclear (SC) | Have |
| Sales cycle | weeks | 6–8 (SC) | Have |
| New-client fee | $/month | average about $4.9k–5k, up to $6k (SC) | Have (fee range per tier) |
| Tier mix of new wins | % per tier | unknown, ask | Have (traffic share) |
| New clients a month | clients/month | unknown, ask. Lumpy: 0–3 onboardings at once (SP2); "a bit quiet" (SD) | Have (from leads × win rate) |
| Seasonality | 12 multipliers | November busy (SC); otherwise "I can't say like a pattern" (PM) | Have |
| Growth | %/month | unknown, ask | Have |
| Market swings | 24-month schedule on leads, win rate, cycle, price, churn, hiring delay | macro and cash-flow churn (SD, SP1); economy "really bad right now" (PM); AI eroding core services (SC) | Have |
| Project work share | % revenue | under 10% (SC) | Have (one-off pricing) |
| Sales support from delivery | decks/month | 1–2 prospect decks a month (LB) | Have |

## 6. Client behaviour levers and values

**Tier 1 is the best client and the most effort, then Tier 2, then Tier 3.** Tier values are the defaults; a named
Tier 1 client can override any of them (section 4).

**Price and deliverables (per client a month)**

| Lever | Tier 1 | Tier 2 | Tier 3 | Source | Status |
|---|---|---|---|---|---|
| Fee | unknown, ask (one $11k client seen) | unknown, ask | unknown, ask | SC | Have |
| Fee range seen across tiers | $3k–6k in one book; new clients average about $5k | | | LB, SC | Have |
| Content words | unknown, ask (3,000 in the 6K example) | | | LB | Small: words to tasks |
| Links | unknown, ask (5 in the 6K example) | | | LB, SD | Have (recurrence) |
| Tech hours | unknown, ask (about 5–8) | | | LB, SD | Have |
| SEO-manager hours | unknown, ask (about 5) | | | LB | Have |
| Performance channels | unknown, ask (SP2 averages about 1.7) | | | SP2 | New |
| Creative production | agency makes assets for higher tiers | client supplies | client supplies | SP1 | Have (routing by service) |

**Time to serve (recurring)**

| Task | Tier 1 | Tier 2 | Tier 3 | Source | Status |
|---|---|---|---|---|---|
| Client meeting (WIP) | weekly (fortnightly for some) | monthly ("every so often", PD) | monthly | PD, SP1, SP2 | Have |
| Meeting length | 30–45 min | 30–45 min | 30–45 min | SP1, SP2 | Have |
| Meeting prep + notes | up to 1h15 a call | 30–40 min | 30 min | SP2, PM | Have |
| Monthly report commentary | about 30 min+ | about 30 min | quicker | PM | Have |
| Pacing (Performance) | about 50–60 min a client a month (inferred from SP2's day-1 2h + 30 min/day + 15–20 min per flagged account, across 14 clients) | same | same | SP2 | Have |
| Monthly deliverables (tech, content, links, report tickets) | from the calculator | | | SC, LB | Have. **New**: pinned to week of month (briefs at month end, reports in week 1, meetings in the first 2 weeks) |
| Strategy review | quarterly | 6-monthly (SEO); quarterly (Performance) | 6-monthly | SD, PD | Have |
| Hand-holding (unplanned contact, reassurance) | per named client (D5) | — | — | Austin | New (per-client override) |

**Ad-hoc requests**

| Lever | Value | Source | Status |
|---|---|---|---|
| Rate per tier | unknown, ask. Tier 1 has "most ad hoc requests" (SP2) | SP2 | Have (Poisson a month) |
| Rate and size per named Tier 1 client | keyed in (D5) | — | New |
| Request types and size | new campaign: strategy 1–2 days + build 1–2 days, about 1 week brief to launch (SP2); Meta build 45–60 min, 10–15 min if simple (SP1); quick ask or budget change about 20 seconds (SP1); one-off migrations (LB) | | Have (one ad-hoc process per type) |
| Response expectation | 24h email, all tiers (SP1); same-day for the biggest client, next week for small ones (LB) | | Have (SLA) |

**Onboarding (per new client)**

| Department | Duration and content | Source | Status |
|---|---|---|---|
| Organic | 3 weeks of work, presented in week 4. Audit, keyword mapping, content and link plans, roadmap and deck. Hours unknown, ask | SD, LB | Have |
| Performance | access (instant to weeks); audit + strategy at least 1 week; tracking 3–4 days; build 3–5 days; fortnightly check-ins in month one | SP2, SP1 | Have |

**Waiting on clients and third parties**

| Wait | Value | Source | Status |
|---|---|---|---|
| Content approval | unknown, ask; "follow up a few times" | LB | Have (external wait) |
| Meta preview approval | unknown, ask | PM | Have |
| Creatives from the client | about 2 days | SP2 | Have |
| Link from publisher | 1–2 months end to end | LB, SD | Have |

**Churn and moves**

| Lever | Value | Source | Status |
|---|---|---|---|
| Churn rate per tier | unknown, ask (tracked monthly by the client) | SC | Have |
| Warnings | about 5 a week | SC | Have (clients at risk) |
| Reasons → churn drivers | macro / cash flow → market; performance → results; comms and "going through the motions" → slow responses / late work; new client-side contact → your own; resellers taking work in-house → your own | SD, SP1, SC, MC | Have |
| Moves between tiers, upsells | rare upsells; tier moves not discussed: ask | SD, SC | unknown whether wanted |

## 7. Current and future state: base values on each step

**The problem.** Today a future state is a copy of the map with new numbers typed in. It is only as good as the
guess, and it doesn't move when the baseline is corrected. We need **base values on each step that capture what a
change acts on**, so the future state is derived, never typed.

**What the transcripts show.** Steps split into gather / judge / check, and staff want the gathering automated and the
judgement kept:

| Step | Automatable part | Augmentable part | Stays manual | Source |
|---|---|---|---|---|
| Pacing | pull spend and budgets; flag under- and overspend | work out the new budget | the budget decision | PD, SP1, SP2, PM |
| Monthly report | data pull; "work completed / planned" page | commentary draft | the narrative | SD, PM |
| Meeting prep | collate data across platforms | talking points | the "so what" | SP1, SP2, PM |
| Content brief | split the plan into briefs; intake; freelancer handoff | research bank | — | SD, CM |
| Content writing | — | research only | all writing | SD, CM, LB |
| Link domain vetting | metrics pull + AI spam pre-screen | — | final look | LB |
| Link health | weekly dead-link scan; publisher notices | — | — | LB, SC, MC |
| SEO onboarding | prefilled keyword research, metadata, deck draft | strategy with AI | judgement; client call | LB |
| Forecasting | — | **done already: hours to about 15 min** | review inputs | PD |
| Meta ad QA | format and spelling checks | — | — | PM |
| QA of delegated work | — | — | all of it | SP1, SP2 |

**Proposed design** (Option A from the handover: split a step's time into parts, held as shares of one distribution)

**1. Base values on each step.** Keyed in once and corrected over time.

| Field | Meaning | Example (pacing, per client a month) |
|---|---|---|
| Time | low / likely / high hands-on time (as today) | 30 / 55 / 90 min |
| **Work split** | automatable % / augmentable % / manual %, summing to 100, each with a one-line description of what that part is | 70% "pull spend and budgets, spot under-pacing" / 20% "work out new budgets" / 10% "decide and change" |
| **Tier multiplier** | × on time for Tier 1 / 2 / 3 (default 1) | 1.3 / 1 / 0.8 |
| Per-client override | × or extra time for a named Tier 1 client (section 4) | e.g. 1.5 for a demanding client |
| Waiting, rework, routing | as today | — |
| **Source and confidence** per value | interview / calculator / measured / estimate | interview (SP2), medium |

**2. A change is a separate object that points at parts of steps.** It is never a new time.

| Field | Meaning | Example: "Unified pacing tool" |
|---|---|---|
| Kind | automation or augmentation | automation |
| Acts on | step(s) and part | Pacing: automatable part |
| Effect, automation | removes X% of that part and leaves a residual check time | removes 90%; residual 3 min |
| Effect, augmentation | speeds that part by a factor | (e.g. budget calculation ×1.5) |
| Also changes (optional) | rework chance, waiting time, or adds or removes a step | fewer overspend reworks |
| Adoption | share of people or time actually using it | 80% |
| Start and ramp | month it starts; months to full effect | month 2; 1 month |
| Cost (optional) | $ a month, so savings can be weighed | unknown |

**3. The future time is worked out, never typed.** Worked example, using illustrative shares:
- Pacing at 55 min = 38.5 automatable + 11 augmentable + 5.5 manual.
- With the change, the automatable part becomes 38.5 × 10% plus a 3-min residual, about 7 min. With 80% adoption the
  step is about 23 min.
- That saves about 32 min a client a month, about **7.5 h a month for a 14-client manager**.
- **If the baseline is later corrected to 70 min, the saving moves with it.**

**4. Display.** On the map, each step shows a stacked bar (automatable / augmentable / manual) with now against
future. A scenario lists its changes, not edited steps.

**5. How it fits what exists.**
- **Solutions** (copied maps) stay for changes in routing, such as removed or added steps.
- **Changes** handle time.
- **Process levers** (step time ×) and **speed factors** stay as blunt tools.
- **Calibration** compares the baselines with measured times if the client ever exports Monday.com ticket times. That
  is the only measured source they have.

**Settled** (D6–D8): three parts; tier multipliers on each step; adoption per change.

## 8. Changes the client wants to test

These are the starting scenario library. Each becomes a change (section 7) or a people/mix lever.

**Automation and augmentation: Performance**

| Change | Wanted by | Acts on |
|---|---|---|
| Unified pacing with per-campaign budgets and auto-tasks | PD, SP1, SP2, PM, Founder | pacing |
| Anomaly and threshold alerts (frequency over 3, CPL over 2×, conversion drops) | PD, SP2, PM, MC | performance review; fewer late fixes |
| Auto-generated implementation briefs | SP1 | briefing |
| Pre-call data collation and talking points | SP1, SP2 | meeting prep |
| Report commentary drafts | PM, SP1 | monthly report |
| Quarterly review deck generation | PD | quarterly deck |
| Meta ad QA checker | PM | ad QA |
| Website / tracking-change monitor | SP1 | tracking incidents |

**Automation and augmentation: Organic**

| Change | Wanted by | Acts on |
|---|---|---|
| Onboarding cut to about 1/3 of today's effort | LB (#1) | SEO onboarding |
| Content brief automation, central intake, freelancer handoff | SD, CM | briefs and allocation |
| AI link-domain pre-vetting | LB (started) | vetting: about 60 domains in 1–2h, about 2 days lag |
| Link health monitor + publisher CRM + invoice chasing | SC, LB, MC | link admin; dead links |
| Report "work completed / planned" page | SD | monthly report |
| Review slides for small clients | Founder keen; SD reluctant | 6-month review |
| Prospect deck automation | LB | 1–2 decks a month |
| Page-build QA (mobile and desktop) | LB | page-build rework |

**People and mix**

| Change | Source |
|---|---|
| Replace the resigned SEO manager | SD |
| 1–2 hires so the SEO Director keeps only 3 enterprise clients | SD |
| A senior Performance lead | SC, PD |
| Junior writer (SD) **vs** more freelancers (CM) | SD, CM |
| Second business developer later | SC |
| Fewer, higher-quality links per client | SD |
| Tier mix or price changes (none raised; available) | — |

**Constraints from the interviews**
- No timesheets.
- No automatic budget changes (PD).
- Writing, strategy, relationships and QA stay human.
- Change fatigue: 3 tools rolled out in 50 days drew "too many changes" (SC).

## 9. Gaps: questions for the client

**Keyed in later by the Founder** (D3–D5; the app needs the entry points in section 4)
1. Client count per tier, and fee per tier.
2. Each employee's portfolio.
3. Named Tier 1 clients with their hand-holding hours, ad-hoc requests, cadence and assigned people.

**Still to ask**

4. **DLER:** retainer only (D9); directors and managers count (D10, confirm). Which department is at 2.75 and which
   at 3.2?
5. Hours a week per person; leave; salaries or bands. Is head count 22 or 24, and are the 4 offshore included? Which
   org-chart boxes are contractors or open roles?
6. The **pricing calculator** (fee → words, links, tech hours, manager hours), and the SEO Director's capacity model.
7. Channels per Performance client.
8. Baseline times (low / likely / high):
   - onboarding hours (Organic, Performance);
   - minutes per report, meeting prep, pacing check, content brief, 1,000 words written and edited;
   - minutes per link step;
   - client email and ad-hoc requests per week per tier.
9. Waits and rework: client approval times and rounds; page-build errors; link replacements; overspend incidents.
10. New clients a month over the last 12 months, by tier; lead volume; which stage "1 in 10" is measured at.
11. Churn rate per tier and by reason; how many of the about 5 weekly warnings become churn; tier moves and upsells.
12. Can Monday.com ticket open/close times be exported? That is the only measured time source.

**Conflicts to resolve**

13. Link volume: 200 (SC), 250 in January to 312 now (SD), 300–350 (LB). Default about 310, range 250–350.
14. Gross margin about 30% against $80/h cost and $120–150/h billing, which implies more.
15. Tier 2 meeting cadence: monthly (SP1, SP2) or "every so often" (PD).
16. Writers: hire a junior (SD) or add freelancers (CM)?
17. Does "enterprise" mean Tier 1? Is the about 6K retainer Tier 1 and the about 3K one Tier 3?

## What to build (first draft of the keep / cut / build list)

**Build**

| Item | Size | Serves |
|---|---|---|
| Capacity page: busy share, clients and channels per employee, headroom, bottleneck, MRR against target, DLER, with-change comparison | New | A1–A6 |
| "Add N clients" form (tier, department, timing) and goal seek over the client count, with least-busy assignment | New | A1, A2, A5 |
| Named Tier 1 clients alongside tier counts in one run | Small–New | D3, D5 |
| Per-client overrides for named clients (hand-holding, ad-hoc, cadence, deliverables) | New | D5 |
| Portfolio counts per person for counted clients | New | D4, A2 |
| Step base values: work split, tier multiplier, source and confidence | New | section 7 |
| Changes (automation / augmentation) as objects acting on step parts, with adoption and ramp | New | A5, A7 |
| Channels as a load driver (Performance) | New | A2 |
| Reserved management share per person; ramp for new starters; salary input | Small | A2, A6, A9 |
| Words → content tasks; freelancer capacity in words | Small | A3 |
| Work priority by tier; recurrence pinned to week of month | New | Later (D14) |

**Keep:** the map editor, the engine and animation, people, roles, servicing, lead flow, market, churn drivers,
Sandbox scenarios and compare, and "what matters most".

**Cut** (D12): scenario share links and first principles. **Kept:** solutions (routing changes), price rises and
value ranges, the block library. The full feature-by-feature list is in `docs/plans/keep-cut-build.md`.

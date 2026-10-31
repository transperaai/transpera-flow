# Client requirements: capacity and clients per employee

Written 31 Oct 2026 from nine discovery sessions with the client (a digital marketing agency with an Organic/SEO team
and a Performance marketing team). Follows `docs/plans/client-refocus-handover.md`. **Austin decides scope: mark this up
before anything is built.**

The transcripts and the per-transcript extracts are not in the repo. People are named by role. Quotes are short and
from the transcripts; a few from source SP2 were paraphrased by the reader, so check before quoting to the client.

## How to read this

Every item has a **value** (or "unknown, ask") and an **engine** verdict against "What the engine already models" in
the handover:

- **Have:** the engine models it today; it just needs data entered.
- **Small:** a small change to the engine, the database or a page.
- **New:** new to build.

**Sources**

| Key | Session | Date | Client speaker(s) |
|---|---|---|---|
| SC | Scoping session (leadership) | 22 Oct | Founder & Principal Consultant; Head of Client Services |
| PD | Discovery interview | 28 Oct | Performance Marketing Director |
| SD | Discovery interview | 28 Oct | SEO Director |
| LB | Workflow interview | 29 Oct | Senior SEO Manager & Linkbuilding Lead |
| SP1 | Workflow interview | 29 Oct | Senior Performance Marketing Manager (the newer one, 5 months in) |
| CM | Workflow interview | 29 Oct | Content Manager |
| SP2 | Workflow interview | 30 Oct | Senior Performance Marketing Manager (14 clients) |
| PM | Workflow interview | 30 Oct | Performance Marketing Manager |
| MC | Mid-point check-in | 30 Oct | Founder (Austin presenting early findings) |

## The short version

1. **Nobody tracks time, and leadership doesn't want timesheets** ("Big Brother. Not much gain.", Founder, SC). So
   there are no measured hours to calibrate against. The client measures capacity with proxies:
   - **DLER** (money under management ÷ salaries per department): 3:1 minimum, recent readings 2.75 and 3.2 (SC).
   - **"Share of portfolio MRR = share of time":** an $11k retainer that is about a third of a manager's book should
     take about a third of their time (Head of Client Services, SC).
   - **Directors carry about 55% of a standard manager's MRR,** because about half their time goes on running the team
     (SC).
   - **The SEO Director's capacity model** uses monthly retainer, clients per person, and whether a client is part of
     a group (SD).
   - **Channels per person in Performance:** "My max would be like 10 channels" (PD).

   **Implication:** the Capacity page should speak these units (MRR per person, DLER, channels) next to hours, and
   the hours baseline must come from deliverables and interview ranges, not timesheets.
2. **Retainers buy deliverables, not hours.** A pricing calculator turns the retainer into words, links, technical
   hours and manager hours. Example: a 6K client gets 5 links, 3,000 words, about 5 tech hours and about 5 SEO-manager
   hours (LB). Another example: 2,000 words, 5 links, 8 tech hours (SD). **The calculator is the single most useful
   artefact to get:** it defines the per-tier workload directly.
3. **The two departments need different load models.**
   - **Organic:** client managers hold 9–19 clients, with a rule of thumb of about 10. They feed shared pools: content
     (about 100,000 words a month), links (about 300 a month) and technical.
   - **Performance:** load scales with channels as much as clients. Managers hold 12–20 clients (14 clients = 24
     channels for SP2), and every manager interviewed says they are at or near full.
4. **Everyone's #1 automation is the same per department.**
   - **Performance:** pacing (budget against spend across all channels) plus alerts. It came up in 5 of 9 sessions.
   - **Organic:** onboarding (LB), content briefs and handoff (SD, CM), and link vetting and monitoring (LB, SC).
   - **Writing, strategy, client relationships and QA stay human** (all speakers).
5. **What is still missing to answer the client's two questions:**
   - total client count by tier;
   - the retainer range per tier;
   - each person's portfolio (clients, tier, channels);
   - hours per week.

   See Gaps.

---

## 1. Questions the client wants answered

**As asked**

| # | Question | Who | Engine |
|---|---|---|---|
| Q1 | Based on workflows and client numbers, are we at capacity? Which people and roles are? | Founder (handover brief); SEO Director: "we're getting to capacity with the current client-facing managers" | Small: busy share per person and role exists. A single "at capacity" view (the Capacity page) is New |
| Q2 | With automation or augmentation, how many more clients can each employee manage? | Founder (brief); Austin frames it as "another 15" per consultant (MC) | New: needs an automation/augmentation model (section 6) and goal seek over the client count (known gap) |
| Q3 | Raise DLER: "My goal is to try to push it from 3:1 to 4:5" (garbled; probably 3:1 to 4.5:1) | Founder (MC) | New: DLER per department (revenue under management ÷ salaries) |
| Q4 | How do we stop pacing errors and overspend? (A $10K overspend came from a stale budget in the pacing sheet) | Founder (MC) | Out of scope for the simulator; it's an ops tool. Relevant as a rework/error rate |
| Q5 | Can Performance cope with channel growth without more people? (Director's channels went from about 10 to 18 since July) | Performance Director (PD) | New: channels as a load driver |
| Q6 | Will content hold as volume grows? It went from 40k to 100k words a month: "it's not going to be sustainable anymore" | Content Manager (CM) | Have: content pool utilisation, once words are mapped to tasks |
| Q7 | Can we take on more clients without hurting retention or NPS? Retention is "the metric" | Founder, Head of Client Services, PD | Have: client health and churn drivers (overload, late work, slow responses) |

**What we think they should be asking**

| # | Question | Why | Engine |
|---|---|---|---|
| R1 | At what clients-per-person, by tier mix, does quality or retention break? | The rule of thumb (about 10 clients) is "depends on the mix"; managers range from 9 to 20 | Have: overload and late-work churn drivers. Small: sweep the client count |
| R2 | Is the constraint the client-facing managers, or the shared pools (content editors, link vetting, tech)? | The content editors are a 2-person gate on 100k words; link vetting runs through one senior person | Have: busy share per role/person shows the bottleneck |
| R3 | How much capacity does onboarding eat, and how many can run at once? | "Onboarding too many clients at once is the most common cause of stretch" (SC); 0–3 at once (SP2); 5 site onboardings in one month forced overtime (LB) | Have: onboarding process plus lead flow. Small: show onboarding hours as a purpose |
| R4 | What does management and mentoring load cost, and does it scale with juniors hired? | Directors spend 40–50% on the team; the ramp is 90 days | Small: reserved non-client share per person (see section 3) |
| R5 | Which single automation frees the most hours per client per month? | Needed to rank the change list | Have: "what matters most" (tornado), once the levers exist |
| R6 | What is the cost of Tier 1 priority on Tier 2/3 service? | "tier 1 is non-negotiable" (SP2); Tier 2/3 "take a hit" first | New: the engine has no work priority by tier |

## 2. Stats to show

| Stat | Asked by | Value today | Engine |
|---|---|---|---|
| **Clients per employee** (per person, role, department) | Founder brief | 4–20 per person (section 3) | New (known gap) |
| **Channels per employee** (Performance) | PD ("My max would be like 10 channels") | Director 18 (cap 10); SP2 24 for 14 clients | New |
| **Busy share per person and role** | Founder brief | unknown, ask (no timesheets) | Have |
| **Headroom before overload** ("about 3 more Tier 2 clients before anyone goes over 85%") | Founder brief | — | New: goal seek over the client count |
| **DLER per department** | Founder (SC, MC) | min 3:1; readings 2.75 and 3.2 (which department is which: ask) | New. Needs clients assigned to people and salaries; revenue and labour exist |
| **MRR per person against a target** ("MRR is a loose indicator of the kind of capacity they should be at") | Head of Client Services (SC) | example: $11k ≈ 30–33% of one manager's book, so a book of about $33–37k | Small: the roster has assignments and fees |
| **Hours per client per month by tier**, split by task and role | recommended; LB wants the calculator allocation compared with actuals | calculator example only | Have: time by purpose. Small: by tier |
| **Where the time goes** (client work, onboarding, management, admin, sales support) | recommended; SD, PD give time splits | SD 60/40, PD 50/50, Head of Client Services about 70/30 | Have: time by purpose |
| **Retention and churn by portfolio, department and agency** | Founder (SC, already automated monthly) | rate unknown, ask | Have: clients and clients at risk per service. Small: per person |
| **Client health / red flags roll-up** ("which clients have seen a drop this month") | SD, SP2, PM, PD, MC | — | Partly Have (health from late work). Performance-based health (rankings, CPL) is out of the simulator: ops tooling |
| **Content words per month against capacity** (KPI 20,000 words per writer per month) | CM | 100k/month total | Small: words to tasks |
| **Link pipeline** (ordered, vetted, live, late) and link volume per month | LB, SC | about 300/month | Have: WIP and waits per step |
| **Onboardings in flight** and their hours | LB, SP2 | 0–3 at once | Small |

**Recommendation.** A Capacity page with three blocks:
1. **Today:** clients and channels per person, busy share, MRR per person against target, DLER per department.
2. **Headroom:** extra Tier 1/2/3 clients before anyone passes 85%.
3. **With change X:** the same figures side by side.

Health and red-flag dashboards are what the staff asked for most, but they are live ops tools, not simulator outputs.
**Austin to decide whether they're in scope.**

## 3. Employee levers and values

**Agency-wide**

| Lever | Value | Source | Engine |
|---|---|---|---|
| Head count | about 22 + 4 offshore, or 24 in total (conflict) | Founder, Austin (SC) | Have |
| Hours per week | unknown, ask (8-hour days mentioned) | MC | Have |
| Billing rate / cost | bill $120–150/h by seniority; cost $80/h | Founder (SC) | Have (cost per hour). Price is per retainer, not hourly |
| Gross margin | about 30% ("roughly") | Founder (SC) | Have (profit) |
| New-starter ramp | 90 days to about 80% of expected capacity | Founder (SC) | Small: a speed factor that rises over the first 90 days. Today speed is fixed per person; timed Sandbox changes could approximate it |
| Hiring lag | "Takes time to hire"; winning faster than hiring causes stretch | Founder (SC) | Have (market hiring-delay factor) |
| Leave | unknown, ask | — | Have |
| Overtime | happens in heavy onboarding months | LB | Have (overtime cap) |
| Management and mentoring share | Directors 40–50% on team work | SC, PD, SD | Small: a reserved non-client share per person. Today the availability floor is workspace-wide |

**Per role.** Clients are per person; "Tier" is the client's tier.

| Role | Clients | Time split | Tier mix / notes | Self-assessed load | Source |
|---|---|---|---|---|---|
| Founder | some legacy Tier 1s; joins Tier 1 WIPs | mostly sales, finance and firefighting | Tier 1 relationships rely on him | stretched | SC, MC |
| Head of Client Services | — | about 70% operations, 30–40% client work | escalations; covering the vacant Head of Performance role | stretched | SC |
| SEO Director | **12** | **60% own clients / 40% team** (first said 70/30) | wants just 3 enterprise clients, smaller ones handed over ("a couple of hires away") | "nearing capacity" | SD |
| SEO client managers | **9–19** each | — | rule of thumb **about 10**, "depends on the mix"; one with 19 (many small clients) has resigned | at capacity | SD |
| Senior SEO Manager & Linkbuilding Lead | **12–13**, bigger retainers | clients, deliverables, team (1 SEO specialist + link team) | also does link vetting and pays link invoices | "close to" cap | LB |
| SEO Specialist (junior) | 1+ (new client 2 months ago) | — | onboarding is "pretty demoralizing" for juniors | stretched | LB |
| Technical SEO team | about 3 people (2 new) | audits + monthly tech tickets | "Tech just got two new people, so we're covered there" | OK | SD, LB |
| Content Manager | 1–2 Tier 1 clients directly | allocation, editing, writing | edits all freelancer work with 1 other editor | OK, not overwhelmed | CM |
| Writers | in-house 2 copywriters + content specialist (org chart) + **4 freelancers** (2 on contract, fixed monthly words) | — | KPI **20,000 words per person per month**; freelancer turnaround at most 2 weeks; hiring a junior writer to cut freelancer spend (SD) | — | CM, SD |
| Link team (offshore) | 2 people | outreach, domain sourcing, publisher negotiation | — | — | LB |
| Performance Marketing Director | **4 clients / about 18 channels** (about 10 in July) | **50 / 50** | mostly Tier 1; ideal cap **10 channels** | stretched | PD |
| Senior PMM (SP1) | **about 12** | strategy, client comms, briefing, copy review dominate | 1 Tier 1, 1 near-Tier 1, about 10 Tier 2/3; +7–10 clients "would be a lot" | busy | SP1 |
| Senior PMM (SP2) | **14 clients / 24 channels** | 60–70% "on the tools" | Tier 1 "non-negotiable"; Tier 2/3 take the hit | "working at full capacity" | SP2 |
| PMM | **about 20**, mostly Tier 2/3 | data analysis is the biggest sink | does small changes herself because "briefing requires another time" | overwhelmed "sometimes" | PM |
| Performance Specialists / Coordinator (implementers) | one has her own clients, one doesn't | builds, creative and landing-page briefs | 1–2 days turnaround per implementation task | unknown, ask | SP1, SP2, PM |
| Pacing helper (role unclear) | — | pacing checks Mon/Wed/Fri, mid-month check | — | — | SP2, PM |
| Conversion Tracking Specialist | — | tracking troubleshooting on request | — | — | SP1 |
| Head of Performance | **vacant** (Oct 2026) | — | a senior Performance hire is wanted | — | SC, PD |
| Business Development | 1 (started 1 Oct) + Founder; Head of Client Services closes some | — | — | — | SC |

**Engine.** Roles, people, capacity, skills, leave, start and end dates, speed factor, and per-person assignment via
the named roster are all **Have**. Channels per person are **New**. The client's own max-clients rule (about 10, or a
channel cap of 10) is **Small**: a per-role limit, shown on the Capacity page.

## 4. Lead flow and market levers

| Lever | Value | Source | Engine |
|---|---|---|---|
| New clients a month | unknown, ask. Signals: "a bit quiet" lately (SD); onboardings come lumpy, 0–3 at once (SP2); one strategist took 2 new clients (5 sites) in one month (LB) | SD, SP2, LB | Have (lead sources × conversion) |
| Lead sources | partner referrals, Meta ads, inbound; outbound "used to work really well" in 2024, now noise | Founder (SC) | Have |
| Lead response | call within 5 minutes (auto-assigned in HubSpot) | Founder (SC) | Have (as a sales step) |
| Win rate | **about 1 in 10** now (was 1 in 3); exact stage unclear | Founder (SC): "now... it might be one in ten" | Have |
| Sales cycle | **6–8 weeks** | Founder (SC) | Have |
| New-client value | **about $4.9k–5k MRR** on average (range up to $6k) | Founder (SC) | Have (fee range per tier) |
| Project work | under 10% of revenue | Founder (SC) | Have (one-off pricing) |
| Seasonality | November busy; otherwise "I can't say like a pattern" (PM) | SC, PM | Have (12 monthly multipliers) |
| Growth / market | "cash flow and the state of the world" driving churn (SD); economy "really bad right now" (PM); AI eroding "bread-and-butter offerings" (SC) | SD, PM, SC | Have (24-month market schedule) |
| Sales support from delivery | 1–2 prospect decks a month (LB) | LB | Have (a sales step on a delivery role) |
| Sales over-promising | scoping that "doesn't add up" and may be unprofitable (MC) | MC | Out of scope |

## 5. Client behaviour levers, per tier

**Tiers:** Tier 1 is the best client and needs the most effort, then Tier 2, then Tier 3 (Austin). "Enterprise" (SD)
probably means Tier 1. **Confirm.**

**Price and deliverables**

| Lever | Tier 1 | Tier 2 | Tier 3 | Source | Engine |
|---|---|---|---|---|---|
| Retainer a month | unknown, ask. Example: an $11k client (tier not stated) | unknown, ask | unknown, ask | SC | Have (fee range per service) |
| Retainer range seen | about **$3k–6k** across one strategist's book; new clients average about $5k | | | LB, SC | Have |
| Content words a month | unknown, ask by tier. Examples: 3,000 (6K client), 2,000 | | | LB, SD | Small: words to tasks (e.g. 1 task per article) |
| Links a month | unknown, ask by tier. Examples: 5 (6K client), 5 | | | LB, SD | Have (recurrence: month × 5) |
| Tech hours a month | about 5 (6K client); 8 (example) | | | LB, SD | Have (ongoing hours per role, or a tech task) |
| SEO-manager hours a month | about 5 (6K client) | | | LB | Have |
| Clients in groups / multi-site | some clients are "part of groups"; one client had 4 websites | | | SD, LB | Small: a multiplier on onboarding and servicing |
| Performance channels per client | unknown, ask (SP2 averages 24 ÷ 14 ≈ 1.7) | | | SP2 | New |
| Creative production | agency produces assets for higher tiers, otherwise the client supplies | | | SP1 | Have (routing by service) |

**Recurring work**

| Task | Tier 1 | Tier 2 | Tier 3 | Source | Engine |
|---|---|---|---|---|---|
| Client meeting (WIP) | **weekly** (PD, SP2); fortnightly, some weekly (SP1); Founder joins some | monthly (SP1, SP2); "every so often" (PD) | monthly | PD, SP1, SP2, MC | Have (recurrence) |
| Meeting length | 30–45 min | 30–45 min | 30–45 min | SP1, SP2 | Have |
| Meeting prep | about 1h15 prep + notes around a 30-min call (SP2) | 30 min (PM); 30–40 min for a 5-channel client (SP2) | 30 min | SP2, PM | Have |
| Monthly report + commentary | due in the first 2 weeks; commentary **about 30 min a client** | same | quicker for small clients | PM, SP2, LB | Have |
| Performance pacing | day 1: about **2h across all accounts**; then about **30 min a day**; **15–20 min per underspending account** (SP2). Fortnightly, or weekly for new clients (PM) | | | SP2, PM | Have (recurrence; per-account time) |
| Monthly deliverable tickets (tech, content, links, report) | raised on the 1st, closed by month end | | | SC, LB | Have. **New** if they must be pinned to week of month (briefs at month end, reports in week 1, meetings in the first 2 weeks) |
| Strategy review | quarterly (enterprise, 3–4 months) | 6-monthly (SEO); quarterly decks (Performance) | 6-monthly | SD, PD | Have (month × 1/3 or 1/6) |
| Weekly ecommerce reporting (one client: 4 sheets every Monday before 11am) | client-specific | | | SP1 | Have |
| Bespoke Tier 1 extras (one client: 5–10 localisations a week at 15–20 min each; half-day monthly deck; trend checks every 2–3 days) | client-specific | | | LB | Have (named-roster client with its own process) |
| Email response expectation | **24 h**, all tiers | 24 h | 24 h | SP1 | Have (SLA) |
| Turnaround on asks | same day for the biggest client: "I'll drop everything" | | next week for a small client, agreed with them | LB | Have (SLA per service) |

**Ad-hoc requests**

| Lever | Value | Source | Engine |
|---|---|---|---|
| Rate | unknown, ask. Tier 1 has "most ad hoc requests" (SP2); "keep having a lot" | SP2 | Have (Poisson per month) |
| New campaign (Performance) | strategy **1–2 days**; client creatives about **2 days** wait; build **1–2 days**; Meta build **45–60 min** (10–15 min if simple); **brief to launch about 1 week** | SP2, SP1 | Have |
| Budget change | about 20 seconds: "don't model budget edits as a big time sink" | SP1, PD | Have |
| Migrations (SEO) | one-off spikes outside the retainer | LB | Have (one-off) |

**Onboarding (per new client)**

| Department | Duration and content | Source | Engine |
|---|---|---|---|
| Organic | strategy month: 3 weeks of work, presented in week 4 (SD). Covers the technical audit, keyword mapping ("very time-consuming"), content and link plans, roadmap and deck; large sites are split over months. Hands-on hours unknown, ask | SD, LB, SC | Have (onboarding process) |
| Performance | access (instant to "a lot of following up"); audit + strategy at least **1 week**; conversion tracking **3–4 days**; build **3–5 days**; first month has fortnightly check-ins | SP2, SP1 | Have |
| Handover from sales | about 15-min internal meeting; often a pre-call brief only about 10 min before the client call; repeated questions | SC, PD, SP1 | Have (as a step); quality is out of scope |

**Approvals and waiting on the client**
- Content needs client approval every time: "sometimes... you need to follow up a few times" (LB). Links run "in the
  background".
- Meta ads need a separate preview approval (PM). Some clients want approval even of small optimisations.
- Some clients stall on internal approvals; one has paused content (SD).
- No durations given: **unknown, ask**. **Engine:** Have (external waiting time).

**Links (the longest wait)**
- One link takes **1–2 months** end to end, mostly waiting on publishers: "at least a month, sometimes like over a
  month" (LB, SD).
- Volume conflicts: about 200 a month (SC), 250 in January to 312 now (SD), 300–350 (LB). Probably growth over the
  year. **Use about 310, range 250–350.**
- Links should stay live 12 months; about 100 dead links in 10 months (LB, MC).
- **Engine:** Have (wait distribution; rework for replacements).

**Churn**

| Lever | Value | Source | Engine |
|---|---|---|---|
| Churn rate | unknown, ask (retention is tracked automatically each month) | SC | Have (base churn per service) |
| Warnings | **about 5 a week**, graded by severity | Head of Client Services (SC) | Have (clients at risk) |
| Reasons | cash flow / macro (SD, SP1); white-label reseller agencies taking work in-house (2–3 resellers) (SD); performance (SD, MC); a new marketing manager at the client (SC, MC); feeling we're "going through the motions" (SD) | | Have: market, results, your own, slow responses, late work |
| Leading signs | rankings trending down (SD); conversions dropping; contract requests; "haven't seen you in a while" (SC) | | Have (health). Rankings are out of scope |
| Upsells | rare; commission exists; retention is the priority | SD, SC | Unknown whether the engine has a tier-move lever. **Ask whether it's in scope** |
| Moves between tiers | not discussed: unknown, ask | — | — |

## 6. Current state vs future state: how the nodes capture the change

**What the transcripts say about the shape of a step.** Almost every step described splits the same way: gather
data, apply judgement, then check. Speakers want the gathering automated and the judgement kept.

| Step | Automatable part | Augmentable part | Stays manual | Source |
|---|---|---|---|---|
| Pacing | pull spend and budgets into one place; flag under- and overspend | compute the new budget | the budget change decision: "I need to be on top of what is happening" | PD, SP1, SP2, PM |
| Monthly report | data pull, the "work completed / planned" page | commentary draft | narrative, so you "know what you're talking about" in front of the client | SD, PM, SP1 |
| Pre-call prep | collate data across platforms | summary and talking points | the "so what" | SP2, SP1, PM |
| Content brief | split the plan into briefs, intake, handoff to freelancers | research bank (stats, compliance) | — | SD, CM |
| Content writing | — | research only | **all writing**: "Content writing stays human" | SD, CM, LB |
| Link domain vetting | Ahrefs pull + AI spam pre-screen | — | final human look | LB |
| Link health | weekly scan for dropped links, notices to publishers | — | — | LB, SC, MC |
| SEO onboarding | prefilled keyword research and metadata, first-draft deck | strategy with Claude | strategy judgement, the client call. **Target: about 1/3 of today's effort** | LB |
| Forecasting | — | **already done**: hours to about 15 minutes with Gemini | review of inputs | PD |
| Quarterly / 6-month review deck | draft | — | review; the SEO Director wants it manual except for small clients | PD, SD |
| Meta ad QA (20–30 ads a launch) | format and spelling checks | — | — | PM |
| Strategy (both departments) | — | keyword review with guardrails | "the strategic thinking... is important for the team to do" | SD, SP2 |
| QA of delegated work | — | — | all of it: money is at risk | SP1, SP2 |

**Recommendation: Option A (split each step's time into parts), held as shares of one time distribution.**
- Each step keeps **one time distribution**, as today (a triangular low/likely/high from interviews).
- Each step gets three **shares**: automatable %, augmentable %, manual %, summing to 100%.
- A change is written against the parts, not as a new time:
  - "automate 80% of pacing's automatable part" or "augment the augmentable part ×1.5";
  - automation also gets a **residual** (review time left after automating), so automation never drops a step to
    zero by accident.
- **When the baseline is corrected, every future state moves with it.**
- This is Option C generalised to three parts. It fits what the interviews describe (gather / judge / check) without
  modelling tasks inside steps (Option B), which the interviews can't populate.

**Does step time vary by tier?** Yes, for some steps. Evidence:
- Tier 1 meetings and prep are longer.
- Tier 1 strategy is "a lot comes from this strategy thinking".
- Reporting and commentary are "quicker for small clients".

**Recommendation:** a **per-tier multiplier on the step's time** (default 1) rather than a distribution per tier.
Frequency per tier is already handled by servicing recurrence.

**How confident are the baselines?** No timesheets, so every baseline is an interview range. **Recommendation:**
- record a **source and confidence per value** (interview / calculator / measured);
- show the ranges in results;
- use Calibration if the client ever exports Monday.com ticket times. Monday.com is now the ticketing hub, so ticket
  open-to-close times are the best measured source available.
- A useful real before/after already exists: forecasting dropped from hours to 15 min with Gemini (PD).

**Engine:** New. This is the node design the handover flags.

## 7. Changes the client wants to test

**Automation and augmentation, Performance**

| Change | Who wants it | Acts on | Engine |
|---|---|---|---|
| Unified pacing across all channels, with per-campaign budgets and alerts that create tasks | PD, SP1, SP2 ("Pacing?" "100%"), PM, Founder | pacing step: day-1 2h, 30 min a day, 15–20 min per flagged account | New (share model) |
| Anomaly and threshold alerts (frequency over 3, CPL over 2× last month, conversion drops) | PD, SP2, PM, MC | performance review steps; fewer late fixes | New |
| Auto-generated implementation briefs | SP1 | briefing step | New |
| Pre-call data collation and talking points | SP1, SP2 | prep: 30 min to 1h15 a call | New |
| Report commentary drafts | PM, SP1 | about 30 min a client a month | New |
| Quarterly review deck generation | PD | quarterly deck | New |
| Meta ad QA checker | PM | QA of 20–30 ads a launch | New |
| Better forecasting tool | PD | already at about 15 min | New |
| Website / tracking-change monitor | SP1 (Austin's idea) | tracking incidents | New |

**Automation and augmentation, Organic**

| Change | Who wants it | Acts on | Engine |
|---|---|---|---|
| Onboarding to about 1/3 of today's effort | LB (#1 wish) | SEO onboarding month | New |
| Content brief automation, central intake, freelancer handoff | SD, CM | briefs and allocation | New |
| Link domain pre-vetting (AI) | LB, already started | vetting: about 60 domains in 1–2h, about 2 days lag | New |
| Link health monitor + publisher CRM + invoice chasing | SC, LB, MC | link admin, dead links | New |
| Report "work completed / planned" page | SD | monthly report | New |
| 6-month review slides for small clients | Founder keen; SD reluctant | review deck | New |
| Prospect deck automation | LB | 1–2 a month | New |
| Page-build QA (mobile and desktop) | LB | rework on page builds | New (reduced rework chance: Have) |

**People and mix**

| Change | Source | Engine |
|---|---|---|
| Replace the resigned SEO manager (19 clients) | SD | Have |
| 1–2 hires so the SEO Director hands over small clients and keeps 3 enterprise ones | SD | Have |
| Senior Performance lead (vacant Head of Performance) | SC, PD | Have |
| Junior writer to cut freelancer spend (SD) **vs** more freelancers rather than hires (CM) | SD, CM | Have |
| Second business developer later | SC | Have |
| Fewer, higher-quality links per client | SD | Have (recurrence) |
| Tier-mix or pricing changes | none raised | Have (fee range, traffic share) |

**Attitudes that constrain the model**
- No timesheets.
- Writing, strategy, client relationships and QA stay human: "You can't automate a relationship, nor should you"
  (SP1).
- No automatic budget changes (PD).
- Change fatigue: three tools rolled out in 50 days, and "too many changes" (SC).
- Austin: "if it's not autonomous things, I don't think it's going to get used" (MC). So weight **automation**
  (no adoption needed) above **augmentation** (needs adoption) in the model, perhaps with an adoption-rate lever.

## 8. Gaps: questions for the client

**Needed to answer Q1 and Q2 at all**
1. How many active clients are there in total, and how many in Tier 1, 2 and 3? What is the total MRR?
2. What is each tier's retainer range? Can we have **the pricing calculator** (retainer to words, links, tech hours,
   manager hours)?
3. Each person's portfolio: clients, tier of each and channels per client (Performance). Can we have **the SEO
   Director's capacity model**?
4. Contracted hours per week per person, and leave. Which org-chart roles are offshore, contractors or open (the grey
   boxes)? Is head count 22 or 24, and are the 4 offshore inside it?
5. Salaries by role or band, for DLER and cost. (Billing is $120–150/h, cost $80/h.)

**Baseline times** (ranges are fine: low / likely / high)

6. Hands-on hours to onboard one client, Organic and Performance.
7. Minutes per: monthly report and commentary; WIP prep; pacing check per account per channel; content brief; 1,000
   words written; 1,000 words edited; link (brief, outreach, vetting, invoice); tech hour delivered against a ticket.
8. How many client emails and ad-hoc requests a week per tier?
9. How long do client approvals take (content, ad copy, Meta previews)? How many rounds?
10. Rework rates: content edits from client feedback, page-build errors, link replacements, overspend incidents.
11. Can we export Monday.com ticket open/close times? That is the only measured time source.

**Lead flow and churn**

12. New clients a month over the last 12 months, by tier. Lead volume and the funnel stage the "1 in 10" refers to.
13. Logo and MRR churn rate per quarter, by tier and reason. How many of the about 5 weekly warnings become churn?
14. Do clients move between tiers? How often are upsells won?

**Conflicts to resolve**

15. **"3:1 to 4:5":** is the goal DLER from 3:1 to 4.5:1? What is the baseline per department (2.75 and 3.2: which is
    which)?
16. **Link volume:** 200 (SC), 250 in January to 312 now (SD), 300–350 (LB). What is the current monthly figure, and
    links per client per tier? (5 links for a 6K client doesn't obviously add up to 300+ without more clients or tiers.)
17. **Gross margin about 30%** against a cost of $80/h and billing of $120–150/h, which implies more. What is in the
    30%?
18. **Tier 2 meeting cadence:** monthly (SP1, SP2) or "every so often" (PD)?
19. **SEO Director split:** 70/30 or 60/40? And the Senior SEO Manager says he is "close to" cap yet "not really"
    overstretched: what is the true ceiling?
20. **Writers:** hire a junior (SD) or add freelancers (CM)? How much of the 100k words is freelance, and what are the
    2 contracted freelancers' monthly words?
21. Does "enterprise" mean Tier 1? Is the about 6K retainer Tier 1 and the about 3K one Tier 3?

**People still to interview** (named by interviewees)

- Technical SEO Specialist / Technical SEO Director: audits and tech-ticket times.
- Link team lead: outreach time per link.
- The Performance implementers and the pacing helper: their capacity and roles.
- Conversion Tracking Specialist: incident frequency.
- Business development: funnel numbers.

## Next step

Once Austin has marked this up, map each item to keep / cut / build. The engine verdicts above are the first draft
of that list. The builds they imply:

| Build | Size |
|---|---|
| Capacity page (clients and channels per person, busy share, MRR against target, DLER, headroom) | New |
| Goal seek over the client count per tier | Small/New |
| Step time shares (automatable / augmentable / manual) with changes written against them | New |
| Per-tier time multiplier on steps | Small |
| Channels as a load driver | New |
| Reserved management share per person | Small |
| Ramp-up of new starters | Small |
| Work priority by tier | New |
| Recurrence pinned to week of month | New |

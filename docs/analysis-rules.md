# Analysis rules

Agreed with Austin, 1 Oct 2026, in the analysis rules session. This replaces the detector thresholds in
`packages/engine/src/issues.ts` (`DEFAULT_ISSUE_THRESHOLDS`) and the four engine severities. It is the spec for the tickets that follow.

**Since B17 (issue #175, decision D40):** the rules give **facts**, not findings. Each page shows what they find under "Facts
from the run", as evidence; AI reads those facts and proposes findings, and people add their own. The rules editor below
is gone: every workspace is rated with the **documented defaults on this page** (the cut-offs in the table, both
escalators on, a lost client or deal worth at most 12 months of fees, a two-week absence twice a year, and the normal waits
of 1 working day for sales steps and 2 for client work). What a workspace saved in `analysis_rules` is kept, unread; a
later ticket can bring a setting back if Austin wants one.

**Editing (A44, issue #109; removed in B17):** Settings → Analysis rules (`/w/<slug>/settings/rules`, `/demo/settings/rules`) edits all 15 rules, the escalators and the money settings, stored per workspace in `analysis_rules.settings` (sparse jsonb; `packages/engine/src/analysis-settings.ts`). Only the rules on the rating model below take effect in the engine yet; the others are saved and apply when their detectors land. The absence test's length and frequency are read by the engine (A42); the 12-month cap is read once the cost ticket (A43) lands.

**Built so far (A41, issue #106):** the rating model and rules 1, 3, 4, 5, 6 and 7 are in
`packages/engine/src/ratings.ts` and the detectors (`issues.ts`, `overtime-issues.ts`). The rules not listed there still
run their old logic, mapped onto ratings until their tickets land. Choices the spec left open:

- Overrides: the most specific match wins (person, step, role, service, process); a field it leaves unset falls through.
  A servicing step belongs to its servicing process and to the services that run it.
- Expected wait for rule 5, most specific first: a person or step override, the step's own setting, a role, service or
  process override, then the default of 1 working day (pipeline) or 2 (servicing), in the model's working day
  (`hoursPerWeek / 5`).
- A band a rule doesn't have (overtime's Good, rule 4's Good and Bad) is skipped when an escalator raises a rating.
- Stored issues keep the database's four `severity` values, which stand for the ratings one to one (critical = Operational
  risk, serious = Bad, warning = Good, info = Great).

**Also built (A42, issue #107):** rules 2, 8, 11, 12 and 13 (`spare`, `spof`, `success`, `dropoff`, `cycle` in
`ratings.ts`, the ids A44 stores; `absence.ts`, `success.ts`, `issues.ts`). Rules 9, 10, 14 and 15 still run their old logic.

- **Spare time (2)** is rated on utilisation, lower is worse: under 40% is Good, 40% and over is Great, and the rule has
  no Bad or Operational risk band (its cut-offs are `0.4 / 0 / 0`). It never escalates (a bad month or the bottleneck
  doesn't apply to spare time). One opportunity per named person (per role when the model has no named people), with
  "about N h a week free" (capacity minus the hours worked).
- **Absence test (8)** is its own pass (`absenceTest`), not part of the baseline run. It tests only people who are the
  sole holder of a step (at most 8, those holding most steps first) with 10 replications at the baseline's seed, the
  person away for 2 weeks (`absence.weeks`) from week 2 (earlier on a short run). Both sides use the same random
  streams, so the difference is the absence. *Work lost* is the share of the work completed (won and done items,
  servicing tasks on time or late) from the start of the absence to the end of the run that the absence cost; items only
  delayed and finished by the end don't count. *Weeks to recover* is the first week after they return when the queues
  at their steps are within 1 item or 25% of the baseline's in the same week and stay so a week later; when never, the
  weeks observed plus one. A queue that never recovers is Operational risk whatever the run's length. A *client deadline missed* is at least one more servicing task
  a replication that isn't finished within twice its SLA. Work lost is rated by the rule's cut-offs (`5 / 5 / 20%`, no
  Good band) and weeks to recover by `absence.recoveryCutoffs` (the last two inputs of the stored rule, `1 / 1 / 4`; rule-wide: a per-person or per-step override changes the work-lost cut-offs only; a value on a cut-off falls in the better band), the
  worse of the two wins, and a missed client deadline is Operational risk. No escalators. One finding per step only that
  person can do, keyed `spof:step:<step id>` as before, all rated from the same absence run. Without an absence result
  (`DetectOptions.absence`), the rule raises nothing: the app runs it in a worker after the baseline.
- **Work lost at a step (12)** counts the visits a step sends straight to a lost end (`StepResult.lostHere`, a win that
  is lost further on isn't counted) ÷ the visits that left it, against the step's benchmark (a step with none isn't
  rated). A bad month raises it, like the other rules.
- **Too slow overall (13)** rates the mean cycle time of completed items against the process's target (set on the
  pipeline's start step; none, not rated). A bad month is the 90th percentile of the replications' mean cycle time.
- **Goals met (11)** reads success measures through `SuccessMeasureSource`. A54 (issue #119) implements it over the process's first principles
  (`successMeasureSource` in `packages/engine/src/first-principles.ts`), and the process page passes it to the detectors, so goals-met findings appear in its insights;
  a process with no first principles still rates nothing (`NO_SUCCESS_MEASURES`). The Issues register and the Overview don't pass it yet. Measures map to a `SuccessKpi` (wins, wins a week, win rate, new MRR, billed,
  cycle time, labour cost, WIP at the end); one that doesn't is returned by `checkSuccessMeasures` as "Not checked by
  simulation" and not rated. Rated on the share of replications that meet the target: 80%+ Great, 50–80% Good, 20–50%
  Bad, under 20% Operational risk (lower is worse, a value on a cut-off in the better band).
- **Step fields:** *expected wait* (rule 5) and *lost per day of waiting* (the wait insight carries
  `lost_per_day_waiting` and `lost_to_waiting_share`, linear in the days waited and capped at 1, for A43's cost),
  *work lost benchmark* (rule 12) and the start step's *time target* (rule 13). None changes the simulation.
- The new findings reuse the stored issue types: spare time is `capacity`, absence `spof`, work lost and goals
  `failure`, too slow `delay`. No migration to the `issues.type` check.

### Confirmed by Austin (1 Oct)

Choices made while building A41 and A42 that the spec didn't settle, all confirmed:

- (a) A value exactly on a cut-off goes to the higher band, so exactly 70% busy is Good and exactly 95%, 20% or 25% is
  Operational risk. Rule 5 is the exception ("within 1x", "up to 1.5x"): a value on a cut-off stays in the lower band.
- (b) Overtime is rated on the share of the overtime cap used: "regular" overtime is over 1% of the cap, "used up" is 95%
  of it.
- (c) Rule 4 (work piling up) is rated on the average only; a bad month isn't read from queue growth, which is noisy per run.
- (d) The bottleneck bump only raises findings already worse than Great, so a Great that is merely on the bottleneck stays
  Great.
- (e) Stored `info` issues now read as "Great", and the log-an-issue form offers Great for an open issue.
- (f) The absence test measures work lost from the start of the absence to the end of the run, not over the whole run
  or only the weeks away, and uses 10 replications and at most 8 people to stay in the performance targets (see
  `docs/engine-versioning.md`). The "client deadline missed" test is one more missed servicing task a replication.
- (g) A step's lost-per-day-of-waiting is linear (5% a day for 3 days is 15%), not compounding.

## The rating scale

Every rule turns a number from the simulation into one rating:

| Rating | Meaning |
|---|---|
| **Great** | Working well. Protect it. |
| **Good, could improve** | Fine today, with something to gain. |
| **Bad, not urgent** | Costing time or money. Plan a fix. |
| **Operational risk** | Could break delivery or lose clients. Fix now. |

Each rule has three cut-offs that split its number into these four bands. A step, role or process is **Great** when
every rule that applies to it rates it Great.

### Escalators

The band is set by the **average** across the 30 runs. Two things can raise it:

1. **Bad month.** If the 90th percentile (P90) crosses the next cut-off, the rating goes up one level.
2. **On the bottleneck.** If the finding is on the current bottleneck (step, role or person), it goes up one level.

The two can stack. A rating can't go higher than Operational risk.

Example: Northbeam's strategist averages 82% busy, so Good, could improve. A bad month hits 97%, which crosses 85%, so
the rating rises to Bad. She is also the bottleneck, so it rises again to Operational risk. Today's engine doesn't flag
her at all, because 82% is under its single 85% threshold.

### Cost per month

Every insight shows an estimated cost per month in the workspace currency. The default currency for new workspaces is
**AUD**. Within a rating, insights are sorted by this cost, highest first. The cost is always labelled as an estimate.

**What a loss is worth** (decided 1 Oct): the revenue still to come at the moment it's lost, capped at **12 months**.

- **Before signing**, a lost lead or deal is worth the deal value × the chance it would still have signed from that
  step. With Northbeam's routing, a lead lost at Check fit is worth about 12% of a deal, and one lost at Client decision
  about 32%.
- **After signing**, a churned client is worth its monthly fee × the tenure it had left, from the month it churns.
  Losing a client in month 2 of a typical 22-month tenure counts 12 months (the cap); losing one in month 20 counts 2.
- **Deal value** is the service's monthly fee × typical tenure (one-off price for one-off services), capped at 12
  months.

**Methods per rule** (decided 1 Oct where marked):

- **Busy role or person** (decided): work lost. The engine's shadow price gives the extra wins one more person would
  bring; cost = those wins × deal value. Overtime has its own insight (rule 3), so it is added here only when no
  overtime insight exists for the same person or role; otherwise it would be counted twice.
- **Long wait** (decided): through drop-off. Each pipeline step gets an optional **lost per day of waiting** (e.g. 5%
  of leads go cold per day). Cost = items lost to waiting × what a loss is worth at that step. With none set, the
  insight shows time, not money.
- **Single point of failure**: the damage of one absence (from the absence test) × absences a year (default 2) ÷ 12.
  The damage counts the wins lost in the absence window at deal value. Missed servicing tasks are not priced as deals;
  they are flagged separately (a missed client deadline makes the insight Operational risk). When no wins are lost,
  only client tasks, the cost shows n/a rather than a zero.
- **Client health, churn driver, SLA missed**: clients lost × what a loss is worth after signing. Only churn above a
  client's (or group's) base rate counts, because that is what late and missed work adds; a client that churns at its
  usual rate isn't a cost of the insight.
- **Drop-off**: items lost above the benchmark × what a loss is worth at that step.
- The rest are listed in the table below.
- **Overlaps**: costs are estimates per insight and are not added up. A step's waiting cost and its drop-off cost can
  overlap (items that go cold while waiting are also items lost at the step), and so can an SLA cost and a churn-risk
  cost (both count the churn that late work causes).

### Editing the rules

Everything in this document is a workspace default, editable in **Settings → Analysis rules**:

- Each rule can be switched **on or off**.
- Each rule's **cut-offs** can be changed. The screen shows the default next to each number and previews the four
  bands as you type.
- A rule can be **overridden** for one role, person, step, service or process (e.g. a lower busy limit for a person
  nobody can cover, or a shorter expected wait for replying to leads). Overrides are listed on the rule.
- The two **escalators** (bad month, bottleneck) can each be switched off.
- The money settings and defaults below are editable: the 12-month cap, the absence-test length and how often it
  happens, and the default expected waits.
- **Reset to default** works per rule, and for all rules at once.

Changing a rule re-rates the latest run straight away; it doesn't need a new simulation.

## The rules

| # | Rule | Number it rates | Great | Good, could improve | Bad, not urgent | Operational risk | Cost per month (estimate) |
|---|---|---|---|---|---|---|---|
| 1 | **Busy role or person** | Simulated utilisation | under 70% | 70–85% | 85–95% | over 95% | Extra wins one more person would bring × deal value, plus overtime |
| 2 | **Spare capacity** | Simulated utilisation | n/a | under 40%, shown as an opportunity ("about N h a week free") | n/a | n/a | Cost of the idle hours at cost rates |
| 3 | **Overtime** | Overtime hours | none | n/a | any regular overtime | overtime cap used up | Overtime hours × cost rate |
| 4 | **Queue keeps growing** | Queue growth per week | n/a | n/a | n/a | 0.5 or more items a week (always) | Value of work stuck in the queue |
| 5 | **Long wait** | Average wait for a person ÷ the step's expected wait | within 1× | up to 1.5× | up to 3× | over 3× | Items lost through the step's "lost per day of waiting" × value |
| 6 | **Rework** | Simulated share of work done twice | under 5% | 5–10% | 10–20% | over 20% | Repeated hours × cost rate |
| 7 | **SLA missed** | Share of visits over the step's SLA | under 5% | 5–10% | 10–25% | over 25% | Through the churn drivers when the step is client work |
| 8 | **Single point of failure** | Absence test: work lost and weeks to recover | under 5% lost, back within 1 week | n/a | 5–20% lost or 1–4 weeks | over 20%, over 4 weeks, or a client SLA missed | Damage of one absence × absences a year ÷ 12 |
| 9 | **Client health** | Simulated health of each client group (per service) | 75+ | 65–75 | 50–65 | under 50 | Churned MRR × expected tenure |
| 10 | **Churn driver** | A driver's share of simulated churn | n/a | n/a | 30% or more | 30% or more and the client group is under 50 | That driver's share of churned MRR |
| 11 | **Success measure** (first principles) | Share of runs that meet the measure's target | 80%+ | 50–80% | 20–50% | under 20% | Depends on the measure |
| 12 | **Drop-off between steps** | Share of work lost at a step, against a benchmark set per step | at or better | up to 1.25× the benchmark | up to 1.5× | over 1.5× | Lost items × expected value |
| 13 | **Cycle time vs target** | End-to-end time for a process, against its target | within target | up to 1.25× | up to 1.5× | over 1.5× | Revenue delayed |
| 14 | **Sources disagree** | Ratio between two sources' numbers for one parameter | n/a | n/a | 2× or more | n/a | n/a (a data-quality finding) |
| 15 | **Broken solution** | A saved solution points at something that no longer exists | n/a | n/a | always | n/a | n/a |

Notes:

- **Rule 1 and 2:** under 70% is Great for workload. Under 40% also raises a separate "spare capacity" opportunity.
  Sales at 12% would be Great on rule 1 and show a Good, could improve opportunity on rule 2.
- **Rule 5:** wait means time queued for a person, not built-in delays like "the client decides" (as today). A step's
  expected wait is set on the step. With none set, it defaults to 1 working day for pipeline steps and 2 for servicing
  steps.
- **Rule 6:** rated from what the simulation shows, not from the rework rate typed into the model (today's behaviour).
- **Rule 8** (decided 1 Oct): the engine runs an extra simulation with the person away for 2 weeks and compares it
  with the baseline, on two numbers: work lost (throughput) and weeks until their queues are back to normal after they
  return.
  - **Great:** under 5% lost and back to normal within 1 week.
  - **Bad, not urgent:** 5–20% lost, or 1–4 weeks to recover.
  - **Operational risk:** over 20% lost, not recovered within 4 weeks, or any client-facing SLA missed.
- **Rules 9 and 10:** replace today's per-client rule. They use client groups per service and the churn drivers in
  Settings.
  - **Rule 10** (built, A56): each client's chance of leaving is its service's normal churn × (1 + the weighted pressure
    of every switched-on driver) × the market. The engine measures late work, slow replies, slow onboarding, rework and
    team overload, and takes the weights and numbers you enter for the rest (results, early tenure, price changes,
    account manager changes and your own drivers). A driver's share of a group's churn is its part of that product
    across the clients who leave; what no driver explains is normal churn. A driver at **30% or more** of a group's
    churn is Bad, not urgent; it is Operational risk when that group's health is also **under 50**. Both numbers are
    editable in Settings → Analysis rules. The rule is rated per client group and driver, so one finding reads "Late
    or missed servicing work causes 53% of PPC clients leaving". The cost per month is the clients that driver
    loses in a month × what a loss is worth after signing. See `docs/engine-versioning.md` ("Churn drivers").
- **Rule 11:** reads the success measures from the process's first principles (`docs/research/first-principles.md`).
  A measure the simulation can't compute is not rated.

## What AI does

AI analysis runs when someone presses **Analyse** on a process page, or on the Overview for the whole company (B17). It reads:

- the facts (what the rules find, each with an id it cites);
- each process's first principles;
- the linked sources, if the workspace allows it.

It writes **findings**, each citing the facts (and quotes) it rests on. They arrive *proposed*: a person accepts them (after
editing, if they like) or dismisses them, and only accepted findings show on the pages. A finding that cites no fact, or
any number the run doesn't have, is dropped. People can add findings by hand too. AI also runs the first-principles checks
(see the research note), such as automation proposed for a step that is still a delete candidate.

How it is built, what it is given and how every number it writes is checked against the run: [ADR 0013](adr/0013-ai-analysis.md);
how findings, the cache and the review work: [ADR 0015](adr/0015-analysis-findings.md).

## Acknowledge and dismiss

An insight is what a run found. It becomes an **issue** only when someone acknowledges it (the Acknowledge dialog:
title, how bad it is, what it touches, owners, target, sources). Until then it is not on the map and not in the issues
register.

**Dismissing** an insight says "this isn't a problem". It lasts **until the process's next published version**, not
forever:

- The dismissal is stored with the process's live version at the time (`issues.dismissed_revision_id`).
- While the process is still on that version, the insight stays hidden, run after run.
- When a newer version of the process is published and the analysis still finds the insight, it is listed again, as an
  insight, and can be acknowledged or dismissed again. A new dismissal moves the stored version on.
- If the analysis no longer finds it, nothing is listed.
- A dismissed insight is never an issue: it is not in the issues register, not on the map, not in the counts, and it
  has no issue number. It gets a number only if someone acknowledges it later.
- The version is the live version of the insight's own process (the process its step belongs to), not of the page it was dismissed from.
- A dismissal made before the process had ever been published has no version on record: it holds until the first publish, then ends like any other. Dismissals recorded before this rule take their process's live version at the time of the migration where that can be worked out, and otherwise end on the next publish.

## Changes from today

- One rating scale instead of critical / serious / warning / info.
- Average plus P90 instead of average only; bottleneck escalation.
- Per-step expected waits instead of one 16 h threshold.
- Rework from simulated results, not inputs.
- Absence test instead of flagging every one-person step.
- Client groups and churn drivers instead of named-client health.
- New rules: spare capacity, success measures, drop-off, cycle time vs target.
- A cost per month on every insight, in the workspace currency (default AUD).

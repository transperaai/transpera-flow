# QA round 2: what changed, to check

Austin's QA notes of 8 Nov, and what was built for each. Tick each line on the preview
(`transpera-flow-git-claude-gallant-davinci-zamh91-transpera-ai.vercel.app`, a laptop or tablet: the Editor is not
shown on phones). The decisions behind them are in `editor-brainstorm.md`, round 2.

## Request 1: the editor's step panel (PR #308)

Open any process → ✎ Edit → click a Step.

- [ ] 1.1 No "Automation and augmentation" section: no Automate… / Augment… buttons, no "Make a solution to try an automation".
- [ ] 1.2 No "Promised time".
- [ ] 1.3 No "Work already in progress".
- [ ] 1.4 No "Analysis rules" (Expected wait, Lost per day of waiting, Work lost benchmark).
- [ ] 1.5 Still there: Name, Type, Who does it, Pinned person, Hands-on time, Wait, Work split, Done again, Tool, What it
      achieves, Notes.
- [ ] 1.6 Issues that relied on the hidden fields still show on the Issues page (nothing stored was removed).

## Request 2: the Solution page and the Issue page (PR #308)

Solutions → open one.

- [ ] 2.1 No "What it changes" list. In its place, one card "Notes and sources": your notes (say what the solution
      changes), then its Sources.
- [ ] 2.2 The two maps are stacked: "Live" on top, "With this solution" below.
- [ ] 2.3 The header says "Edited on <date>", not "Built by …".
- [ ] 2.4 No "Try it in the Sandbox" button. "Open in editor" is still there.

Issues → open one.

- [ ] 2.5 The header has the process pill only, no step pill.
- [ ] 2.6 No "History" card.
- [ ] 2.7 "What's wrong and sources": the issue's sources sit under What's wrong, with + Link. No separate Sources or
      "Linked to" card on the right.

## Request 3: issues belong to a process; the target is part of What's wrong; no automatic pass/fail (PR #308)

- [ ] 3.1 No red issue badges on any map: a process page, the Overview's company map, the Processes list's map preview,
      and an issue's own "Where this issue sits".
- [ ] 3.2 "+ New issue" and Edit on an issue: no "What does it touch?" / steps choice, and no Target measure / Value now /
      Goal fields. Only the process (when there is more than one), title, rating, owners and sources.
- [ ] 3.3 Acknowledging a finding from the run (Facts) makes an issue of the process, not of the step.
- [ ] 3.4 The Issue page is one column: no Target card.
- [ ] 3.5 Click an empty "What's wrong": it starts with four questions to answer (what goes wrong, how often, what it
      costs, what good would look like).
- [ ] 3.6 An older issue that had a target shows it as a last line of What's wrong ("What good looks like: …"). Save
      What's wrong once and the line stays only if you keep it.
- [ ] 3.7 The Issues list no longer shows "Target: …" or step names on an issue's line.
- [ ] 3.8 "Solutions tried" on an issue shows "Your call: Pass/Fail" or "No verdict yet", never "Against today" or "holds
      in x% of runs". The process page's issue track shows no "holds in x% of runs" either.
- [ ] 3.9 Save a solution from the editor for an issue, and link one to an issue: both work, and no automatic verdict
      appears anywhere.

## Request 4: the Sandbox (PR #308; design options still being picked)

The words, app-wide:

- [ ] 4.1 "The line" is called the **utilisation threshold** everywhere: Set up → People & roles ("Utilisation threshold %"),
      the Overview's "Over their utilisation threshold", Team load, Capacity, the Sandbox heatmap and its "Worst month" line,
      the Forecast legend, and the Sandbox verdict sentences. Lines on charts and maps are still called lines.
- [ ] 4.2 The Sandbox chart "Retainers a month" is now **MRR** (title, header "£X MRR", help), and DLER's help says "MRR
      divided by salaries". The Overview's revenue per employee says "MRR ÷ N people". "Retainer" as a kind of client or
      service is unchanged.

The design, as picked on the options page (A1, B1, C1; no new widgets yet). Sandbox, on a laptop:

- [ ] 4.3 Who's overloaded: no small bar chart under the heatmap. Above it, a red box: "Worst month: <month> · N people over
      their utilisation threshold", with the teams over and counts underneath. That month's column is outlined on the heatmap.
- [ ] 4.4 Move a lever: the box adds "· today's path: N in <month>" for comparison; flip the This scene / Today switch and
      the box and outline follow the run shown.
- [ ] 4.5 Above the charts: "Show the next 12 · 18 · 24 · 36 · 48 · 60 months". Pick 36: the charts and their headers run to
      the 36th month ("… by Oct 2029"), and it takes a little longer to work out. The heatmap stays on the next 12 months.
- [ ] 4.6 Clients, MRR and DLER each have a row of their own, with readable axes: every month labelled up to 12, then about a
      dozen labels.
- [ ] 4.7 After moving a lever, a line under each chart says how far ahead the scene is at the horizon: clients ahead, MRR
      ahead a month and added over the months, departments at the 4.5 DLER goal.
- [ ] 4.8 Where the time goes: two stacked bars (Today, This scene) in the same order and colours, the legend, the total
      hours a month, and what moved most. Hover a segment for its hours. No pies.

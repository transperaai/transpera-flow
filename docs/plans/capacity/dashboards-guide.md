# Transpera Flow: what each page tells you

What each page shows and what you can do on it, read from the code on branch `claude/gallant-davinci-zamh91` (8 Nov 2026). Where this guide says "typed in Set up", it means the Settings pages: Settings, Tiers & clients, and People & roles. Numbers from a simulation are worked out in your browser each time the page opens. Nothing on the read-only pages is stored.

The sidebar has three groups. The first holds **Overview** and **Processes**. **Improve** holds **Issues**, **Solutions** and **Block library**. **Company** holds **Capacity**, **Sandbox** and **Settings**. Sources and History are real pages but not in the sidebar.

When nothing is published yet, Overview, Capacity, Sandbox, Issues and Solutions each show a "nothing published yet" card instead of their figures. Editors get a link to start or open a draft.

---

## Overview

**Answers:** Where does the whole company stand on money, people and processes right now?

At the top: the workspace name, "Last updated" (when you opened the page) and the number of processes. Under that are jump links to **Money · People · Processes**. Each section is headed by its question.

**What you see:**

*Money: "Are we making enough from our people?"*
- **Three hero numbers.** **Clients**: unique clients, shown as each department's count minus those taking both. **MRR ÷ N people**: MRR per person a month, with total MRR underneath. **DLER**: MRR ÷ salaries, shown on a bar with a tick at the 4.5 goal. DLER is the only one coloured: green at or above the goal, amber below. All three are typed in Set up. If salaries are missing it says "Salaries not entered. Enter them →". If your role can't see pay it says "Hidden".
- **Departments.** One block of tiles per department. The first line answers the question in words, for example "Organic is below the 4.5 DLER goal. 2 people are over their utilisation threshold." The tiles are Clients ("N also take the other department"), MRR ÷ N people, DLER, **Over their utilisation threshold** ("2 of 5") and **Room for more clients** (a status, plus which team fills first). Clients, MRR and DLER are typed in Set up. The over-threshold and room tiles come from 10 simulated runs of today's clients, the same run the Capacity page uses. There is a "Capacity →" link.
- If no tiers and services are set up yet, a **start checklist** takes the place of both: Add roles, Add people, Add tiers and services, Enter how many clients are in each tier. Each item is ticked when done and links to its Settings page.

*People: "Is anyone stretched, and when do we hire?"*
- **Busiest people.** Everyone over their utilisation threshold or within 10 points of it, each with a busy bar and a tick at their threshold. Everyone else is folded under "N others…". Comes from the same 10 runs of today's clients. There is a "Capacity →" link.
- **Team load by role.** A red call to action comes first, such as "Start hiring now:" or "Hire by Mar:", with the reason ("SEO managers go over their utilisation threshold from May"). If no role goes over, a green line says so. Below that, one row per role with a cell per month showing the % busy. Cells are green when under the role's utilisation threshold, amber within 10 points, red at or over. Comes from 30 simulated runs over the horizon picked on the company map (1, 3 or 6 months), including planned hires, leavers and leave.
- **Where the time goes.** One stacked bar per department showing its people's hours a month, with a **By process / By purpose** switch. The top line names what each department spends most on. Comes from the 10 runs of today's clients.
- **What the time achieves.** One big %: the share of the team's hours that goes on client work (the two client purposes), with a small monthly trend line. Below it, one bar showing all the hours by purpose. Comes from the same 30 runs over the horizon.

*Processes: "How does work move, and where does it get stuck?"*
- **Company map.** Every process as a card, in department lanes, with handoff lines between them. Each card has a pill for its type. Steps are coloured by their worst confirmed open issue. Press play to watch work move. A horizon picker above the map (1, 3 or 6 months) controls the map and the people charts. Comes from the 30 runs over the horizon.
- **Open issues.** How many issues are open, how many are operational risks, a bar split by rating, and "Most in:" naming the three processes with the most open issues (each a link). Comes from stored issues (open or testing).
- **Time split by process.** For each process: hands-on time, time waiting for one of our people, and time waiting on the client or others. Slowest first, with "Slowest: X, worked on N% of the time". Comes from the 30 runs over the horizon.

Every widget has a folded "How this works" with a plain explanation.

**What you can do:**
- Jump to a section with the links at the top.
- Change the horizon (1, 3, 6 months), press play on the map, open a process card in place, or click a step to open that process's page at that step.
- Use **Simulate further in the Sandbox** above the map, or **Open the Sandbox** under the charts.
- In the header: **✎ Edit company map** (editors), **Export** (map image as PNG or SVG; the JSON backup of the whole workspace), **History** (earlier company map versions), and **All processes**.
- If you are looking at an earlier company map version, use **Back to live**.

---

## Capacity

**Answers:** Are we at capacity, who has room, and how many more clients fit? "Today" means the current book of clients, with nobody arriving or leaving.

**What you see:**
- **"Some figures below are not worked out yet"** (only when something is missing). Lists what's missing or wrong, such as a salary not entered or a tier with no hours planned, each with **Enter it → / Check it → / Fix it →**. A softer "Notes on the client counts" box covers count mismatches. Comes from what's typed in Set up and checks on the published processes.
- **Clients and DLER.** Clients with each department's services, and clients taking both (plus the total). Then DLER for each department and the whole business, each green or amber against the 4.5 goal, described as the average of N people's DLER. Typed in Set up. No simulation.
- **[Department]: room for more clients** (one card per department). Big "N clients today", then "Room for N more", "Full" or "Over by N". A bar shows clients against the most that fit, with the sentence "Up to N before [team] reach their utilisation threshold." Then **Next client goes to:** the up to three people with the most room. Comes from 10 simulated runs of a year with today's clients (no new leads, no churn). It is a rough guide, not a promise. "How this works" lists each team's ceiling.
- **[Department]: client-facing people.** One row per person: a busy bar with a black tick at their own utilisation threshold, their % busy, and "+N" (more clients they can take) or "full". Hover a row for their tiers, hours needed against hours available, rule of thumb, and channels (Performance only). Comes from the same 10 runs.
- **Bottleneck: who is at risk.** "N over and N within 10 points of their utilisation threshold", then a bar per person showing what fills their month, by purpose. Shared teams are included. "How this works" names the heaviest steps for each person, each linked to its place on the process map. Comes from the same 10 runs.
- **What if someone leaves?** Pick one or more people. It opens on whoever has the most clients. The answer is a sentence: who their clients go to, whether a shared team absorbs the work, who goes over their utilisation threshold, and any clients nobody can serve. Each colleague gets a before/after dot pair against their threshold. Starts from the 10 runs, then hands clients to the least busy colleague who serves that tier, using planned hours. No new simulation.
- **Avg time to serve one client, by tier, per month.** One card per tier in each department: average fee a month, hours a month, "Earns X per hour of work", and a bar by purpose. Then a **Named clients** table: who looks after each client, their hours a month, and what they earn per hour. This is planned time added up from the servicing processes and the tier settings in Set up, not a simulation, so it ignores waiting and rework.

**What you can do:**
- **Try changes in the Sandbox** (top right).
- Pick who leaves in "What if someone leaves?".
- Follow the fix links to Tiers & clients or People & roles, and the step links to process maps.
- With no tiers set up, use **Set up tiers and clients in Settings →**.
- The page changes nothing itself.

---

## Sandbox

**Answers:** If the market, clients, prices or the team change, or a process changes, who gets too busy and when, and what happens to clients, MRR and DLER?

Nothing here is saved, and nothing touches live data. The levers reset when you leave. Every change re-runs straight away (in the background) and the charts follow. Each path is 20 simulated runs, month by month.

**What you see:**
- **Company map** (top). The same map as the Overview, playing the run on screen. If there is more than one company map version, a **Company map** select lets you run the draft or an earlier version against today. A line says which processes are "on new versions" (each a removable chip), with **Reset to today**.
- **Levers** (left):
  - **Market**: conditions (As today, or a preset) from a month, plus Leads ±% and Win rate ±%.
  - **Win new clients**: extra clients a month per department, starting month, for how many months, and tier ("Usual mix" or one tier). Shown on top of what lead flow already brings.
  - **Lose clients**: Churn ±%, and **+ A named client leaves** (pick the client and the month).
  - **Prices**: price change %, which tiers, from when, and **Clients react** (how much churn the rise causes, using each tier's setting in Set up).
  - **People**: **+ Someone leaves** (person and month) and **+ Hire** (role and month). New hires ramp up over the months set in People & roles.
  - **Reset levers**.
- **Who's overloaded, and when.** A heatmap of each team by month for the first 12 months. Cells are green when under the utilisation threshold, amber within 10 points, red at or over. Above it, **Worst month: May 2027 · 4 people over their utilisation threshold**, with the teams. Once you've changed something, a **This scene / Today** switch flips the heatmap, and the line also gives the other path's worst month.
- **Horizon filter, "Show the next 12 / 18 / 24 / 36 / 48 / 60 months".** Covers the three charts and "Where the time goes". The heatmap stays at 12 months.
- **Clients by department.** A line per department, with "N clients by [month]". Hover a month for clients won and lost. If prices rose, it shows clients lost to the price rise.
- **MRR.** "$X MRR" at the end of the horizon, plus how much MRR the change adds over the whole period.
- **DLER by department.** A line per department against the 4.5 goal line, with how many departments reach the goal at the end. If your role can't see salaries, this chart is hidden.
- In all three charts the **solid line is this scene and the dashed line is today's path**. After a change, each chart's header shows the difference, such as "Ahead of today's path by 6 clients at 24 months".
- **Where the time goes.** A **Today** bar and, after a change, a **This scene** bar, both showing working hours a month by purpose. Under them: total hours ("1,840 → 1,720 working hours a month") and the purposes that moved most.

**What you can do:**
- Move any lever.
- Click a process on the map to load another version of it, meaning one of its solutions, with its status, from a chosen month. You can also open the page already set to a solution.
- Pick a company map version.
- Change the horizon, and flip the heatmap between This scene and Today.
- **Export**: Numbers (CSV), changes, or a printed summary (save as PDF). Costs can be left out.
- Follow the link at the foot to Settings, where every baseline is set.

---

## Processes

**Answers:** What processes does this workspace have, and what state is each one in?

**What you see:**
- **The company map's own row**, pinned at the top. Shows its version and date, a "Draft open" pill when someone is editing it, and History, Edit and Open.
- **A table of every process**, with sub-processes indented under their parent. Columns: **Process** (plus a "not published" pill), **Type** (Sales, Onboarding, Routine client work, Ad hoc, Internal), **Steps** (working steps, including sub-processes), **Open issues** (confirmed and still open), and **Live version** ("v4 · 29 Sep", or "Draft only"). Comes from stored processes and issues. No simulation.
- Filters: **In use / Archived**, and **Type**.

**What you can do:**
- Open a row in place to see its map, read-only. **Open →** goes to the process page.
- **Company map** (goes to the Overview), **✎ Edit company map**, and **History**.
- Editors: **Upload process** (from a file), **New process**, and a row menu with **Rename…**, **Change type…** (also shows what changes in the simulation) and **Archive…**. Archived processes can be **Restore**d.

---

## A process page

**Answers:** What does this one process look like, how much time does it take and from whom, and what's wrong with it?

**What you see:**
- **Header.** The process name with pills for its type and department, plus "4 steps · 2 roles · Version 3" (or "Draft, not published yet"). An "Inside:" row lists the sub-processes, each a link. On an earlier version, it says "Viewing version N · read only" with a **Back to live** button.
- **Process map.** Read-only. Steps are coloured by the worst rating among their confirmed open issues. Click a step to see its details and base values. If the process can't simulate yet, a **Missing for simulation (N)** list appears; each item jumps to its step.
- **What the process shows.** Everything here comes from 30 simulated runs of this process.
  - **Headline sentence**, for example "This process takes 420 h a month, 18% of Organic's time; about 30% of it is automatable."
  - **Facts.** What the simulation measured, worst first, three shown with "Show all N". These are evidence, not issues: nobody confirms or dismisses them. Hovering a fact lights up its step on the map.
  - **Hours a month, by role and person.** A donut by role, with total hours. Open a role to see its people.
  - **Heaviest steps.** How the hours divide between steps, heaviest first.
  - **Time split per step.** Hands-on against waiting for a person against waiting on others, plus **Most waiting** (the steps that wait longest, with a "redone" note where work repeats).
  - **Key-person risk per step.** Steps only one person can do, grouped by that person ("if they are away, the work stops"), or "No step depends on one person."
- **Issues and solutions.** Counts at the top. **Current issues** (Open, Testing solutions): rating dot, number and title, status pill, owners, the solutions tried with their verdicts, and a folded **Progress** track. **Solved**: each row is the solution that fixed it, with "Solved #N …" and the verdict, or how it was resolved if no solution did. **Won't fix**: folded. Then **Other improvements**, which are solutions not tied to an issue. From stored issues and solutions.
- **Sources** (closed at the bottom). Notes on where this process's numbers come from, plus the interviews and data linked to the whole process.

**What you can do:**
- **History**, **✎ Edit** (opens the Editor), and **Export** (map image).
- Editors can change type and department with the small pencil by the pills.
- **Log an issue**, open any issue or solution row, **Build solution** from an issue's progress track, and **Open the full register →** (the Issues list).
- Add or edit notes and **+ Link** sources (editors).

---

## The Editor (process map and company map)

**Answers:** How do I change this process, or the company map, safely?

The whole screen is in the edit colour, with a "✎ Editor" bar. The palette is on the left, the map in the middle, and the inspector (side panel) on the right. Edits save to a draft as you go. The live map doesn't change until you **Publish**. The Editor doesn't run the simulation, so there's nothing to play here.

**What you see:**
- **Top bar.** Title ("Draft of X", "New solution · X", "Solution for #N · …", or "New block"), undo/redo, the save buttons for the mode, **Discard…**, **History**, **Exit editor**, and a tour. Under it, a hint line for the mode. If something stops the process simulating, the line reads "N things to fix before this can simulate", and clicking it jumps to the first one. Those problems are also marked in red on the map.
- **Palette (left).** **+ Step**, **+ Wait** and **+ Decision**, joined in after the selected card. On the company map you also get **+ Process**, which opens the process library: pick existing processes or make a new one. **Groups**: group or ungroup selected steps. **Blocks**: each saved block, with **Insert** (after the selection) and **Replace selected**. Process maps only.
- **Map (middle).** Drag to move. Draw a line from a card's right edge to another's left edge. Double-click a step to rename and edit it in place.
  - **Decisions** show each branch as a row with its own **dot** and **%**. Click a % to change it; the other branches rebalance so they always total 100%. Drag a branch's dot onto a step to send it there. Drag the **"+" dot** under the rows to add a branch.
  - **Moving lines**: select a line and drag the round handle in its middle (or use the arrow keys) to route it around cards. Double-click the handle to put it back. You can also drag a line's end to reconnect it.
  - In a draft, new things are dashed, removed ones are struck through (with Restore), and changed values show old → new.
- **Right-click menu** on a card: Rename and edit here, Edit in the inspector, Duplicate, Copy, Split in two, Change kind, Pin to person, Delete. A card that is a whole process gets **Open process page** and "Remove from this map" instead. With several cards selected: Duplicate, Copy or Delete N steps.
- **Inspector (right).** For a step: Name, Type, Who does it (role, or a pinned person), Quickest / Usually / Longest times, Done again (rework), Tool, Time target, What it achieves (purpose; you can add a new one), How often, tier multiplier, work split (including the automatable part), and Notes. In a draft it also shows what changed, with revert. For a **decision**: each branch's Name, Share, **Goes to** (Next step…, Go back to…, End won / lost / done) and "Only when…", plus **+ Add branch**. For a **group**: its first step, Ungroup, and **Save this group as a block**.
- **Company map editor.** Move process cards in department lanes, draw and label handoff lines, and group cards. A line from one pipeline to another (Sales to Onboarding) carries each won client into it. A line into client work is drawing only.

**What you can do:**
- **Draft mode:** **Save draft**, **Publish…**, or **Discard…**. Publishing asks first, warns about unconfirmed estimates (with **Review** buttons for each), and keeps the old version in History. You can't publish while there are red problems.
- **Solution mode** (from an issue's **+ Try a new solution**, **Build solution**, or **✎ New solution**): you edit a copy of live. The issue's area is outlined in red. Name it and press **Save solution**. Live and the draft stay untouched. Every solution must be tied to an issue, or the save is refused, with the two ways out offered.
- **Block mode** (from the Block library): build steps, name and describe them, then **Save to library**.

---

## Issues list

**Answers:** What problems have we confirmed, how bad are they, and who owns them?

**What you see:**
- A table of stored issues. Columns: **Issue** (#number and title), **Rating** (Operational risk, Bad not urgent, Good could improve, Great), **Step** (the steps it touches, or "Whole process: X"), **Owners**, **Status** (Open, Testing solutions, Resolved, Won't fix, with the date resolved), and **Solutions** ("2 tested ✓ passed").
- Sorted by rating, then by what each issue costs a month in the latest 30 simulated runs of the live process.

**What you can do:**
- Search, and filter by **Status**, **Owner**, **Rating** and **Process**. Filters stay in the address, so links keep them. **Clear filters**.
- **+ New issue** (editors).
- Click a row to open the issue page.

## An issue page

**Answers:** What exactly is wrong here, and how are the fixes going?

**What you see:**
- **Header.** Breadcrumb (Issues / #N), title, pills for rating, status and process, owners, created date and last change. When resolved, a green bar says how, with **Open the solution**.
- **Where this issue sits.** The process map, read-only.
- **What's wrong and sources.** Free text, including the target, plus linked sources.
- **Solutions tried.** Each solution with its status, when it was tried, what it changes, your verdict (or "No verdict yet"), and notes.

All of this is stored, not simulated.

**What you can do:**
- Change the status from its pill. Choosing Resolved asks how: "A solution fixed it" (pick which), "We changed the process directly", or "No longer a problem".
- **Edit**, **Resolve** / **Reopen**, change owners, and edit "What's wrong".
- **+ Link** a source, **Link an existing solution**, or **+ Try a new solution** (opens the Editor in solution mode).
- Change a solution's status and add notes on it.

---

## Solutions list

**Answers:** What fixes have we built, what does each fix, and how is each going?

**What you see:**
- Header: "Every solution that has been built and simulated, each one tied to the issue it fixes. They never change the live map." Shows the count.
- Table: **Solution**, **Issue(s) it fixes**, **Status** (Idea, Testing, Works, Doesn't work, Adopted), **Process**, **Updated**. Stored, not simulated.

**What you can do:**
- Search, and filter by Status, Issue (including "No issue") and Process.
- **✎ New solution**: pick an open issue and the Editor opens on its process in solution mode. There is also **Log a new issue**, which goes on to the Editor once the issue is saved.
- Click a row to open the solution.

## A solution page

**Answers:** What does this solution change, compared with live?

**What you see:**
- **Header.** Breadcrumb, name, status pill, process pill, "Edited on …", "Solutions never change the live map", and **Fixes:** the linked issues, each a link.
- **Notes and sources.** What the solution changes, in your own words, plus linked sources.
- **Live and this solution.** The live map above the solution's map. They open and close groups together, and new or changed steps are marked on the solution's map.
- There are no numbers on this page. The numbers are in the Sandbox: click the process on its company map and pick this solution.

**What you can do:**
- Change the status, edit notes, and link sources.
- **✎ Open in editor**, or delete it (it asks first).
- **Link an issue** if it has none.

---

## Other pages

**Block library** (sidebar, Improve). Your saved bundles of steps, such as a standard approval or an AI check. One row each, showing steps, roles, hands-on time, how much of it is automatable, and how many solutions use it. Open a row to see its map. **+ New block** or **Edit** opens the Editor in block mode. A row menu lets you rename, copy or delete.

**Settings (Set up)** (sidebar, Company). The main page holds Workspace (name, currency, monthly overheads), Simulation, **Purposes** (the categories behind "by purpose" in the Sandbox and Overview), Churn drivers, and Demand (lead sources, qualified share, seasonality). It links to three sub-pages:
- **Tiers & clients**: tiers, pricing, tier client counts and named clients.
- **People & roles**: roles with each role's utilisation threshold, shared teams, people's hours, leave, dates, salaries and portfolios.
- **Access**: who can sign in and as what. Only for workspace managers.

Changes save as you type. The Capacity, Overview Money and Sandbox figures all start from here.

**Sources** (not in the sidebar; reached from links such as "Add sources under Sources"). The library of interview transcripts, notes and data from the audit. It flags sources that aren't linked to anything. Open one to read it, link it to a process, step, issue or solution, and see which values quote it. **+ Add source** (editors).

**History** (from History buttons on a process, the Overview or the Editor). Every published version of a process or the company map. **View** an old version read-only, or **Restore** one.

**People** no longer exists as its own page: old links go to Capacity. **Restore a backup** only appears on a brand-new, empty workspace, for filling it from a JSON backup.

**Forecast** isn't a page of its own. Its month-by-month view lives in the Overview's people charts and in the Sandbox.

---

## For reference (main file per page)

- Overview: `apps/web/src/components/overview/overview.tsx` (Money tiles: `department-cards.tsx`)
- Capacity: `apps/web/src/components/capacity/capacity-view.tsx`
- Sandbox: `apps/web/src/components/sandbox/play-page.tsx`, `play-view.tsx`, `play-levers.tsx`, `play-results.tsx`, `play-map.tsx`
- Processes list: `apps/web/src/components/processes/processes-page.tsx`
- Process page: `apps/web/src/components/process-page.tsx`, `process-supporting-data.tsx`, `process-issues-card.tsx`
- Editor: `apps/web/src/components/editor/editor-view.tsx`, `editor-bar.tsx`, `palette.tsx`, `inspector.tsx`, `decision-panel.tsx`; right-click menu `apps/web/src/components/node-menu.tsx`
- Issues: `apps/web/src/components/issues-page.tsx`, `apps/web/src/components/issues/issue-page.tsx`
- Solutions: `apps/web/src/components/solutions/solutions-list.tsx`, `solution-page.tsx`
- Block library: `apps/web/src/components/blocks/block-library.tsx`
- Settings: `apps/web/src/app/w/[slug]/settings/page.tsx`, `apps/web/src/components/setup/`
- Sources: `apps/web/src/components/sources-page.tsx`
- Sidebar: `apps/web/src/lib/shell/nav.ts`

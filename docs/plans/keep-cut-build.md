# Keep / cut / build

Written 31 Oct 2026. Every user-facing feature of the app is judged against the questions and decisions in
`docs/plans/client-requirements.md`: the questions A1–A9 and decisions D1–D20. **Austin signs this off before the
build briefs are written.**

**Verdicts**
- **Keep:** stays as is.
- **Change:** stays, but changes to serve the questions.
- **Cut:** removed from the client's app; the code goes, history keeps it.
- **Hide:** kept in the code, but off the menu in the client's deployment until needed.
- **Build:** new.
- **Ask:** needs Austin's call.

## Summary

| Area | Verdict | Why |
|---|---|---|
| Map editor, engine, playback, history | Keep | The core, and the hardest part. The step inspector gains the base values (section 7 of the requirements) |
| People page | **Change → Capacity page** | It already has busy share per person, "if someone is away" (A9) and the too-busy timeline. It becomes the Capacity page |
| Settings data entry (people, roles, services, clients, groups, demand, market, churn, servicing) | Change | It is where Joe keys in. Gains tiers, named Tier 1 overrides, portfolios, channels and the per-role threshold |
| Sandbox | Change | Already the what-if engine. Gains "add N clients", automation/augmentation changes, client-count goal seek, and clients per employee and DLER in compare |
| Overview | Change | Its health strip is about issues; it becomes a capacity headline |
| First principles | Cut | D12 |
| Scenario share links | Cut | D12 |
| Other share links and the older process-level lever system | Cut | Q1: cut all share links |
| Issues | Keep | Q2: where Austin anchors solutions and changes |
| Solutions, block library | Keep | D12 (routing changes) |
| Sources | Hide | Q3: a simple source label on each value instead |
| Calibration | Keep | The only route to measured times (Monday.com export) |
| MCP, API tokens, backup and restore, access, branding, change log, purposes | Keep | Low cost, and useful |
| Demo (`/demo`) | Cut | Q4: rebuild one client-shaped demo later |

## Page by page

### Overview (`w/[slug]/overview`)

| Feature | Verdict | Note |
|---|---|---|
| Company map + play + horizon | Keep | |
| Health strip (process health, open issues, flow efficiency, improvement delivered) | Change | Replace with a capacity headline: clients per employee, busiest role and its busy share, headroom, DLER against 4.5:1. Each card links to the Capacity page |
| By-process rows | Keep | |
| Trend charts (issues donut, where the time goes) | Keep | "Where the time goes" serves A4 |
| Empty-workspace start | Change | The checklist adds: tiers, tier counts, named Tier 1 clients, portfolios, baselines |

### Processes and process pages

| Feature | Verdict | Note |
|---|---|---|
| Processes list, new process, upload process (`transpera-process/2`) | Keep | Upload is how interview maps get in. The file format later gains the work split and tier multipliers (`process-file` skill) |
| Process page sections: About, Map, Facts from the run, Supporting data | Keep | |
| Process page: first principles card | Cut | D12 |
| Process page: issues & solutions, insights → acknowledge | Keep | Q2 |
| Missing-for-simulation | Change | Also lists steps with no work split or source (section 7) |
| Editor (draft, solution and block modes, palette, tour) | Keep | |
| Editor step inspector | **Change** | Adds the work split (automatable / augmentable / manual, with a line each), tier multipliers (D7), and source and confidence per value |
| History (process and company map) | Keep | |
| First principles (`p/[id]/first-principles`) | Cut | D12. Also the MCP tool `get_first_principles` |

### People page → Capacity page (`w/[slug]/people`)

| Feature | Verdict | Note |
|---|---|---|
| How busy each person is | Keep → Capacity | Adds the per-role threshold (D17), clients and channels per person (A2, D13), and the tier mix of each portfolio |
| "If someone is away" | Keep → Capacity | The base for A9 ("what if someone leaves"). Adds where their clients would go |
| Per-person rows (record, steps, leave) | Keep | |
| 12-month too-busy timeline | Change | Drawn twice today (here and in the Sandbox). Keep one component, used in both |
| Client health against benchmark, client groups | Keep | |
| **New on Capacity:** headroom per tier (A2), bottleneck readout (A3), hours per client by tier and named client (A4), DLER per department (A6), hiring trigger (A8), shared teams shown separately (D16) | Build | Prototype first (D20) |

### Settings (data entry, Owner + Agency admins, D18)

| Section | Verdict | Change |
|---|---|---|
| Workspace, Simulation | Keep | |
| Roles | Change | Overload threshold per role (D17); max-clients rule of thumb (shown as a line); client-facing or shared-team flag (D16); department |
| Services | Change | Act as **tiers**: channels per client (D13), deliverables (words, links, tech hours), per-tier defaults for hand-holding and ad hoc |
| Client groups (counted clients) | Change | Run **alongside** the named roster: a count means unnamed clients in addition to the named ones |
| Clients (named roster) | Change | Adds tier, channels and **per-client overrides** (hand-holding hours per role, ad-hoc rate and size, meeting cadence and length, deliverables, bespoke tasks) (D5) |
| People | Change | Adds tiers they can serve, reserved management share, salary (for DLER), ramp for new starters, offshore/contractor label, **portfolio** (named clients + counts per tier) (D4) |
| Churn drivers, client health (servicing), demand, market | Keep | |
| Access, branding, change log, purposes | Keep | |
| Calibration (historical data imports) | Keep | Later: a Monday.com ticket-time import to measure step times |
| Levers (`settings/levers`) | Cut | Q1: only controls the older process-level levers |

### Sandbox (`w/[slug]/sandbox`)

| Feature | Verdict | Note |
|---|---|---|
| Scenarios, whole-run and timed changes, horizon, timeline | Keep | |
| Levers A (market and sales), C (money), D (people), E (process) | Keep | |
| Levers B (clients): clients on the book, fees, churn, churn driver chance, price rise | Change | "Clients on the book" becomes **add N clients by tier, department and timing** (A1), assigned to the least-busy person. Price rise stays (D12) |
| **New levers:** automation change and augmentation change (acting on step parts, with adoption per change, D8), channels per client, management share | Build | |
| Library presets | Change | Replace "Automate the heaviest step" with the client's change list (requirements section 8) |
| Too-busy alerts, "When" (capacity runs out, hire payback) | Keep | A8 |
| Where the time goes | Keep | A4 |
| Price-rise trade-off | Keep | D12 |
| Compare (up to 3) | Change | Adds clients per employee, headroom, DLER, hours freed per person (A5, A6) |
| Goal seek | Change | Adds the client count as a lever, with "first role over its threshold" as the target (A2) |
| What matters most (tornado) | Keep | A7, once the new changes are levers |
| Export (CSV, print) | Keep | |
| Share a scenario | Cut | D12 |

### Improve: issues, solutions, blocks

| Feature | Verdict | Note |
|---|---|---|
| Issues list and issue page | Keep | Q2. **Change:** a Sandbox automation/augmentation change can name the issue it addresses, as solutions do, so the issue shows what each change would free |
| Solutions list and page | Keep | D12: for routing changes. Its MRR projection and market stress test stay |
| Block library | Keep | D12. The "used in N solutions" count is always 0: a known gap |

### Sources (`w/[slug]/sources`)

| Feature | Verdict | Note |
|---|---|---|
| Source library and linking | Hide | Q3: off the menu; values carry a source label (interview / calculator / measured / estimate) |

### Sharing

| Feature | Verdict | Note |
|---|---|---|
| Scenario share links | Cut | D12 |
| Share links on the overview, process, issue and solution, plus the visitor page `s/[token]` and the link list `w/[slug]/share` | Cut | Q1 |
| Older process-level levers (scenario panel, lever panel, compare view, robustness check, bottleneck panel) | Cut | Q1. Reuse the bottleneck panel's logic for A3 before removing it |

### Plumbing

| Feature | Verdict | Note |
|---|---|---|
| MCP server (15 read-only tools), API tokens | Keep | Cut `get_first_principles`. Later: a capacity tool (clients per employee, headroom) |
| Backup export and restore | Keep | |
| Map image export | Keep | |
| Demo (`/demo`, Northbeam and Larkspur fixtures) | Cut | Q4. Check which tests import the fixtures before removing them |

## Decided (31 Oct, Austin)

| # | Question | Decision |
|---|---|---|
| Q1 | Cut all share links, not just scenario links? | **Cut all**, with the older process-level lever system and `settings/levers` |
| Q2 | Issues: keep, hide or cut? | **Keep**: it's where solutions (and now changes) are anchored |
| Q3 | Sources: keep or hide? | **Hide**; values carry a simple source label |
| Q4 | Demo: update, freeze or remove? | **Remove**; rebuild one client-shaped, anonymised demo later |

## Build list (in order)

Each part is useful on its own. Prototypes come first (D20).

| # | Build | Serves | Size |
|---|---|---|---|
| 0 | **HTML prototypes:** Capacity page; "Add N clients" form + result; client entry (tiers, named Tier 1 with overrides, portfolios); step base values + changes | D20 | Small |
| 1 | **Clients:** named and counted clients in one run; per-client overrides; portfolio counts per person; channels per client; tier fields on services | D3–D5, D13, A2 | New |
| 2 | **Capacity page** (from the People page): busy share against the per-role threshold, clients and channels per employee, shared teams separately, headroom, bottleneck, hours per client, DLER, hiring trigger, "if someone leaves" | A1–A4, A6, A8, A9 | New |
| 3 | **"Add N clients"** lever and form (tier, department, timing; least-busy assignment) + client-count goal seek | A1, A2 | New |
| 4 | **Step base values:** work split, tier multipliers, source and confidence; editor inspector; upload format | Section 7 | New (engine: ENGINE bump, goldens unchanged when the split is unused) |
| 5 | **Changes:** automation / augmentation as Sandbox changes acting on step parts, with adoption, start and ramp; compare gains clients per employee, hours freed, DLER; library presets from the client's change list | A5–A7 | New |
| 6 | Small engine items: reserved management share per person, ramp for new starters, salary for DLER, words → content tasks | A2, A6 | Small |
| 7 | **Cuts and hides:** first principles; all share links and the older lever system; hide Sources; remove `/demo` | D12, Q1, Q3, Q4 | Small–Medium |
| Later | Work priority by tier, week-of-month recurrence (D14); earnings per hour by tier (A10); retention under load (A11); Monday.com time import | | |

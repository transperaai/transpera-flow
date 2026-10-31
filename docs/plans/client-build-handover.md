# Handover: building the client capacity app

Written 31 Oct 2026, at the end of the session that wrote the client requirements and prototyped the refocused app.
Start the next chat with the prompt at the end of this file.

## Where things stand

- **What to build:** `docs/plans/client-requirements.md`. Questions A1–A9 are in v1; decisions D1–D32 are Austin's and
  are final unless he reopens them. Sections 3–7 hold the lever values from the interviews: use them as defaults and as
  test data.
- **What to keep, change, cut:** `docs/plans/keep-cut-build.md` (feature by feature, all questions answered).
- **What it should look like:** the clickable prototype, published at
  https://claude.ai/artifact/Wo11fuJEkrk5CyqWVvi539 (Austin's, private) and saved as
  `docs/prototypes/client-capacity-app.PROTOTYPE.html`. It's a throwaway: one HTML file with a simple monthly-average
  calculator, not the engine. Copy its **screens and wording**, and use its calculator only as the definition of the
  derived figures (below). Its data is made up; first names follow the client's org chart.
- **Branch:** `claude/client-refocus-handover-reqs-yu8mcx`, on top of `claude/supabase-migration-plan-mzchlf` (the Neon
  move, Better Auth, the Sandbox, engine 1.14.0). `main` and production are untouched; see "Where everything stands" in
  `docs/plans/client-refocus-handover.md` for the preview deployment and database.
- **Confidential:** the interview transcripts and extracts are not in the repo and must not be added. The client gets
  its own deployment (`docs/new-client.md`); Joe keys in his own data (D19), so build fields and defaults, not imports.

## Definitions the prototype settled

Port these into `packages/db` or the web app as pure functions over engine outputs, with tests. Names are the
prototype's; search the prototype file for them.

| Figure | Definition |
|---|---|
| Busy share (`loads`) | Hours needed ÷ hours available. Needed = every process step the person does, for every client they look after (steps whose "who" is the client's manager), at the client's tier frequencies, ÷ their speed; plus their share of their team's steps; plus steps pinned to them. Available = hours a week × 52/12 × (1 − leave) × (1 − team time) × ramp. The engine already produces busy share per person and role; the new inputs feed it. |
| Person's max at the line (`personMax`) | clients × role line ÷ busy share. "Can take" = max − clients. |
| Department ceiling (`capDept`) | Sum of client-facing people's max, capped by each shared team: clients its capacity at its line could serve at the win mix. The lowest wins and is named as the limit. Room = ceiling − clients. |
| Room as assigned today (`headroom`) | Add clients one at a time to the least-busy person who serves the tier until someone under their line goes over; people already over get none. Used by goal seek; not shown on Capacity any more. |
| Clients by service line (`lines`) | Organic, Performance, taking both (counted per tier + named clients' "also takes"), and unique = Organic + Performance − both. |
| Clients per employee (Overview) | Department clients ÷ everyone in the department (contractors and leadership out). |
| Revenue per employee | Department retainers ÷ the same people. |
| DLER | Retainers ÷ salaries, directors and managers included (D9, D10); per department and whole business (total ÷ total). No ":1". |
| Hiring advice | First month a role's average busy share passes its line, minus the hiring delay. |
| Leaver | Their clients go one at a time to the least-busy colleague who serves that tier (leaver excluded first: the prototype had a bug where the leaver took clients back). |
| Ad hoc | Chance a client asks in a month × requests if they ask × size (D26). |
| A change on a step (`parts`) | Step time × tier multiplier, split into automatable / augmentable / manual. Automation: automatable × (1 − remove × adoption) + residual × adoption. Augmentation: augmentable ÷ (1 + (factor − 1) × adoption). Adoption ramps from the start month. |

## Work packages

Each is a separate PR into this branch, built in its own worktree. Model policy from the last handover: Opus writes a
precise brief per package (use `to-spec` or `implement-spec`), Sonnet builds strictly from it and commits after every
chunk, Opus reviews adversarially before merging. Run `pnpm lint && pnpm typecheck && pnpm test` before every push.

| # | Package | Depends on | Notes |
|---|---|---|---|
| **P0** | **Cuts and hides** | — | Cut first principles (pages, card, MCP `get_first_principles`), all share links (`s/[token]`, `w/[slug]/share`, share dialogs, scenario share), the older process-level lever system (`scenario-panel`, `lever-panel`, `compare-view`, `robustness-check`, `process-view`, `settings/levers`) after moving the bottleneck panel's logic somewhere reusable, and the `/demo` pages. Hide Sources from the menu. **Keep the Northbeam and Larkspur fixtures**: the engine's golden models use them (`docs/engine-versioning.md`); only the demo routes go. Migrations for dropped tables must pass `copy-from-supabase.test.ts`. |
| **P1** | **Data model and Set up** | — | Tiers: services act as tiers, add/remove tiers, per-tier fields (fee, words, links, tech hours, meetings, builds, creative sets, channels, chance of ad hoc, requests if they ask, churn). Clients: named and counted in one workspace; named clients get tier, "also takes", channels and per-client overrides (hand-holding hours, ad-hoc chance/count/size, meetings, deliverables); counted "taking both" per tier. People: team time, salary, tiers served, start ramp, contractor/offshore label, portfolio counts per tier. Roles: department, client-facing or shared, line per role (D17), rule of thumb. Shared-team units and rates (D27). Owner and Agency admins edit (D18). Screens: prototype's Tiers & clients and People & roles. Run `gen:types`. |
| **P2** | **Engine: inputs** | P1's types (agree the `EngineModel` additions first, then run in parallel) | Named + counted clients in one run; per-client overrides; tier fields driving step frequencies (words ÷ 1,000, links, meetings, builds, creatives, ad-hoc chance × count); per-channel steps; reserved team time per person; new-starter ramp. Bump `ENGINE_VERSION`; every existing golden must stay identical when the new inputs are unused, and add a golden for the new ones. |
| **P3** | **Engine: step base values and changes** | P2 | Work split and tier multipliers on steps (D6, D7); changes acting on step parts with adoption per change (D8), start month and ramp; source label per value. Same golden rule. |
| **P4** | **Editor and process file** | P3 types | Step inspector: work split sliders with a line per part, tier multipliers, source label (prototype's process page). `transpera-process/2` gains the fields; update the `process-file` skill. Missing-for-simulation lists steps with no split. |
| **P5** | **Capacity page** | P1, P2 (can start on today's outputs) | Replaces the People page. Prototype's Capacity: service-line headline and DLER; room for more clients per department (gauge, limits, who can take the next client); client-facing tables with "can take"; shared teams in their units; bottleneck with links to steps; what if someone leaves; time to serve one client (tier cards, named Tier 1 table); next 12 months as a "What to do" list. Each widget leads with a sentence; "How this works" folded. |
| **P6** | **Overview** | P5's derived figures | Per-department widgets and a whole-business row (D22); company map unchanged with all its controls (D25). |
| **P7** | **Sandbox** | P2, P3 | Prototype's Sandbox (D29, D31): company processes on top with play controls and block swaps per step from a month; levers below (market from a month, leads, win rate, churn, price change by tier with start month and client reaction through the existing price churn driver, clients won per month and for how long by department and tier, a named client leaving, leavers, hires); "What happens" verdict; charts against today's path (clients, retainers, DLER with the 4.5 goal, busy by team). Reuse the existing scenario machinery (whole-run and timed changes). Saved scenarios need their own design: ask Austin. |
| **P8** | **Issues and blocks** | P3 | A Sandbox change or swapped block can name the issue it fixes; the issue shows hours freed and clients gained per change. Block library blocks carry base values; wire the "used in N solutions" count. |
| Later | | | Work priority by tier and week-of-month recurrence (D14); earnings per hour by tier (A10); retention under load (A11); Monday.com ticket-time import for calibration; a client-shaped anonymised demo workspace. |

**Suggested order with agents:** P0, P1 and the P2/P3 interface agreement in parallel; then P2 → P3; P5 can start on
P1 alone; then P4, P6, P7, P8 in parallel.

## Open questions for Austin

1. **Goal seek and "what matters most" (tornado).** The free-play Sandbox design dropped "what would help most"; the
   existing goal seek and tornado aren't in the prototype. Keep them, hide them, or cut them?
2. **Saved scenarios and compare.** "Will look different in the actual app": what should they look like?
3. **Shared roles and units.** The full list (writers, editors, outreach, tech, specialists, tracking, anyone else) and
   their rates.
4. **Price rise reaction.** The prototype lifts churn for 3 months by a sensitivity; the build should use the existing
   price churn driver. Confirm the default sensitivities (barely / normally / strongly).
5. **Client confirmations still owed** (ask Joe): DLER salary base includes directors and managers (D10); which
   department is 2.75 and which 3.2.

## How to work (from the last two sessions)

- Read `CLAUDE.md`, then this file, then the two plans above. The handover before this one
  (`docs/plans/client-refocus-handover.md`) has the environment lessons: container restarts kill background agents
  (commit after every chunk), local Postgres for tests, Neon over `--driver neon-ws`, migrations must work on real data,
  goldens and `ENGINE_VERSION` per `docs/engine-versioning.md`, known test noise in `apps/web/test/format.test.ts`.
- Austin's rules: plain English; they/them or Austin's name in docs; never ask for keys in chat; confirm before
  anything that touches production; "defaults" means accept our recommendations.
- Record any new decision in `docs/plans/client-requirements.md` as the next D-number.

## Prompt for the next chat

> Read `CLAUDE.md`, then `docs/plans/client-build-handover.md`, `docs/plans/client-requirements.md` and
> `docs/plans/keep-cut-build.md`, and open the prototype at `docs/prototypes/client-capacity-app.PROTOTYPE.html`. We're
> building the client capacity app with multiple agents. Start by asking me the open questions in the handover, then
> write the briefs for P0, P1 and the P2/P3 engine interface, and run them in parallel worktrees.

## Where it stands (end of 31 Oct build session)

- **Built:** P0–P9 merged into `claude/client-refocus-handover-reqs-yu8mcx` through
  [transperaai/transpera-flow#255](https://github.com/transperaai/transpera-flow/pull/255). Briefs and the package table
  are in `docs/plans/capacity/`. Engine 1.17.0. Lint, typecheck, every package's tests and the web build passed on the
  final branch.
- **Preview:** `transpera-flow-next.vercel.app` now follows the handover branch, not
  `claude/supabase-migration-plan-mzchlf`. Log in to Vercel first, then sign in with Google. Its Neon database (`main`)
  has every migration up to `20270125000100`; apply later ones with `packages/db/scripts/neon-preview-migrate.sh`.
- **Not done, on purpose:** `main` and production. Vercel deploys production from `main`, and production still runs on
  Supabase with no `DATABASE_URL`, so merging to `main` before the Neon cutover would take it down. The cutover runbook
  is `packages/db/scripts/copy-from-supabase/README.md` (7b rehearsal, 7c cutover). It needs Austin present: the
  production export needs their permission rule, and production's Vercel environment needs the Neon and Better Auth
  values.
- **Next (Austin, 1 Nov):**
  - QA and UI feedback on the preview;
  - get it deploy-ready for Joe (`docs/new-client.md`, `capacity:starter`);
  - possibly a clean new repo.

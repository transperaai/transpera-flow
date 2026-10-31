# Handover: refocusing Transpera Flow on the client's real operations

Written 31 Oct 2026, at the end of the session that moved the app off Supabase and built the Sandbox. Start the next
chat with:

> Read `CLAUDE.md`, then `docs/plans/client-refocus-handover.md`. I'm uploading interview transcripts. Help me write
> the requirements described in "The job for this chat".

## Why the direction is changing

Austin built Transpera Flow for a client **before reviewing the client's operations**. Having now looked at the
build, Austin says "the whole build is wrong" for that client. The client wants to know two things:

1. **Based on their workflows and how many clients they manage, are they at capacity?**
2. **If they add augmentation (people working faster with tools) or automation (steps done by software), can each
   employee manage more clients? How many more?**

**Advice given and accepted: refocus, don't rebuild from a boilerplate.** The parts Austin needs to keep are the
hardest and most tested parts of the app:
- the process-map editor;
- the simulation engine and its animation (about 900 engine tests, plus golden reference results that catch drift);
- the per-employee, lead-flow and market variables.

What's wrong is the product built around them. So the plan is:
1. **Write down what's actually required**, from the client's transcripts. This is the job for the next chat; see
   below.
2. **Map each requirement to:** already works / a small change / new to build. That produces a keep / cut / build
   list.
3. **Cut what doesn't serve the two questions, and build what's missing.** The likely centre is a **Capacity** page:
   - clients per employee today;
   - how busy each role and person is;
   - headroom before overload ("about 3 more clients before anyone goes over 85%");
   - side by side "with automation X / with augmentation Y", giving the new clients per employee.

   Goal seek (already built) does that search, once it can vary the number of clients.

## The job for this chat

From the transcripts Austin uploads, write **`docs/plans/client-requirements.md`** with these sections. Each item
gets a value or range from the transcripts where one exists, and "unknown, ask" where it doesn't. Then compare each
item with "What the engine already models" below.

1. **Questions the client wants answered**, plus the ones we think they should be asking.
2. **Stats to show:** what the client asked for and what we recommend, for example utilisation per person and role,
   clients per employee, headroom before overload, hours per client per month by tier, and where the time goes.
3. **Employee levers and values:** per person or role, the hours, which tiers or tasks they handle, speed against
   normal, leave, cost, and max clients if the client already uses a rule of thumb.
4. **Lead flow and market levers and values:** new clients per month, leads per win, seasonality, growth, market
   swings.
5. **Client behaviour levers and values:** for each tier, the time needed to serve a client per month (split by task
   and role), how often each recurring task happens, ad-hoc request probabilities and their size, response-time
   expectations, how clients leave and why, and moves between tiers.
6. **Current state vs future state: how the nodes capture the change.** See the problem below.
7. **Changes the client wants to test:** which automations, which augmentations, hiring, tier mix.
8. **Gaps:** what the transcripts don't answer, phrased as questions for the client.

Austin decides scope. Don't start building until Austin has marked up the requirements and the keep / cut / build list.

**Transcripts are the client's confidential material.** Don't commit them to the repo unless Austin says to. Work
from them in the chat or the session scratchpad.

## The current-vs-future node problem (needs design)

**Today:** a "solution" is a copy of a process map in which someone edits nodes (faster steps, removed steps, new
routing), and the simulation compares it with the live map (`solutions` table, `bundleFromSolution` in
`packages/db/src/sandbox/solution.ts`; ADR 0014; PRD D46/D48). Process levers (step time ×, wait ×, rework) and the
per-person speed factor (`capacity factor`, 0.5–2, overall or per step) also exist.

**Austin's point:** "the current and new state is just changes to a node". The future state is only as good as
someone's guess at the new number. What's needed is **base values on each node that capture what the change acts
on**, so automation and augmentation are applied to a well-founded baseline rather than typed in as a new time.

Questions the requirements should answer, with options to weigh. None of these is decided.

- **What does each step's time consist of?**
  - **Option A:** split each step into parts: hands-on time that can be automated, time that can be augmented, and
    time that stays manual.
  - **Option B:** model tasks inside a step.
  - **Option C:** keep one time per step, and attach an "automation potential" (a share of the time, plus what's left
    after automating) and an "augmentation factor".
- **Does a step's time vary by client tier?** Today a step has one time distribution: lognormal, triangular or
  constant (`steps.work_dist`/`work_params`). The tier mainly changes how often recurring work happens.
- **How confident are the baselines?** Interviews give ranges, which fit a triangular low/likely/high. Time tracking
  gives measured averages. The calibration feature (Settings → Calibration, CSV import) already compares entered
  times with measured ones.
- **How does a future state stay tied to its baseline?** Ideally a change says "automate 60% of step X's data entry",
  not "step X takes 12 minutes", so when the baseline is corrected the future state moves with it.

## What the engine already models (match requirements against this)

The model type is `EngineModel` in `packages/engine/src/model.ts`, built from the database by `toEngineModel` in
`packages/db/src/model.ts`. ENGINE is 1.14.0. Time is in working hours, Monday to Friday.

**People and roles**
- **Roles:** head-count (used when there are no named people), cost per hour, and ongoing hours per client.
- **People:** roles, capacity (hours a week, or FTE × hours), skills (which steps they can do), leave, start and end
  dates, and a speed factor (0.5–2, overall or per step).
- **Workspace settings:** an availability floor (time kept free for pipeline work) and an overtime cap.

**Processes (the map)**
- Steps have a role or a pinned person, hands-on time and external waiting time (each with a distribution and
  spread), a rework chance, routing with probabilities (by service tag), and starting work in progress.
- Processes can nest.
- **Servicing processes** are recurring work per client, with a recurrence of every week or month × N, or **Poisson
  per month for ad-hoc requests**, and an SLA in hours.
- Services can also carry fallback ongoing hours per role per client a month.

**Clients and tiers**
- "Services" act as tiers: price and pricing model (retainer, one-off or hourly), traffic share, fee range
  (low/likely/high), base churn, how health affects churn, tenure, servicing processes and ongoing hours.
- Clients exist as **client groups**, a count per service (fast for many clients), or as a **named roster** with
  assignments of role to person.
- Client health is driven by late and missed servicing tasks.
- **Churn drivers:** late work, slow responses, onboarding, rework, overload, hand-offs, results, tenure, price rise,
  market, and your own. Each is a weight, or a chance plus an effect.

**Lead flow and market**
- Lead sources: volume a week and conversion to qualified.
- Seasonality (12 monthly multipliers) and monthly growth.
- A 24-month market schedule with factors for leads, win rate, sales cycle, price, churn and hiring delay.

**Outputs, per month with a 10–90% range**
- busy share per role and person, uncovered hours, waits and late tasks;
- clients per service and clients at risk;
- revenue by kind, labour, overheads and profit;
- opportunities, wins, losses and conversion;
- overtime;
- **where the time goes by purpose** (time by purpose; steps carry a purpose category).

**Sandbox:** saved scenarios of whole-run or timed changes over about 25 levers (the registry is
`packages/db/src/sandbox-levers.ts`), compare up to 3, goal seek (Agency admins and the Owner only), "what matters
most", CSV and print export, a read-only scenario link, and MCP `list_scenarios`/`run_scenario`.

**Known gaps relevant to the client's questions**
- Goal seek can't yet vary the number of clients, which is needed for "max clients per employee".
- There is no explicit automation or augmentation model beyond step-time changes, solutions and speed factors (see
  the node problem above).
- There is no single "clients per employee" figure on any page yet.

## Where everything stands

**Branch.** All work is on `claude/supabase-migration-plan-mzchlf`. `main` and production are untouched: production
is still Supabase project `vgsjkpwvxkpqvyazwcyq` at migration row 72.

**Preview.**
- `https://transpera-flow-next.vercel.app`: log in to Vercel first, then sign in with Google as austin@transpera.ai,
  the Owner.
- The database is Neon `transpera-flow-db` (project `purple-wind-75278769`, Sydney, PG 18), branch `main`, with all
  migrations up to `20270117000000` and a verified copy of production data.

**Built and reviewed.** Details are in `docs/HANDOVER.md`, `docs/plans/supabase-exit-brief.md`,
`docs/plans/cut-list.md`, `docs/plans/strip-briefs.md` and `docs/plans/sandbox-*.md`.
- The move to Neon and Better Auth (Google), with the copy tooling.
- The strip: no in-app AI, findings or Suggestions; MCP read-only; play links without "send an idea".
- Three roles (Owner, Agency admin, Viewer).
- The full Sandbox, phases 1–5b, plus Austin's follow-ups:
  - goal seek and the tornado for admins only;
  - the deciding sale step counts as Winning work;
  - no "Everyone else" for Viewers in teams of 2 or fewer.

**Not done.**
- Austin's QA (paused: the direction changed first).
- The cutover to Neon: hold it until the new product shape is known. The client will get its own deployment anyway
  (`docs/new-client.md`, `scripts/new-client.sh`).
- The known pre-existing bug: the editor page throws a server error while it loads (`loading.tsx` uses
  `SidebarTrigger` outside a provider).

**Lightly validated features.** Much of the Sandbox may be more than this client needs: price rises, churn drivers,
profit, client value ranges, share links, first principles, solutions and the block library. They are candidates for
the cut list once the requirements exist.

## How to work in this repo (lessons from this session)

- **Model policy:** Opus writes a precise brief, Sonnet builds strictly from it in a git worktree, and Opus reviews
  adversarially before the merge. Run independent builds in parallel worktrees.
- **Container restarts happen and kill background agents.** Tell builders to commit after every chunk. After a
  restart, check the worktree's commits and resume from them; nothing committed was lost this session.
- **Local Postgres** for tests: `postgres://postgres:postgres@localhost:5432/postgres`. Start it with
  `pg_ctlcluster 16 main start`, and set the password once with
  `su postgres -c "psql -c \"alter user postgres password 'postgres'\""` if needed.
- **Neon from the cloud container:** port 5432 is closed, so use `--driver neon-ws` on `migrate` and the `copy:*`
  scripts. Fetch connection URIs from the Neon API, whose key is injected by the proxy: `GET
  https://console.neon.tech/api/v2/projects/purple-wind-75278769/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=false`.
  Write the URI to a 0600 file in the scratchpad and never print it.
- **Production reads** (`copy:export`) need Austin's permission rule, which is in Austin's local settings.
- **Migrations must work on real data:** `packages/db/test/copy-from-supabase.test.ts` imports a production-shaped
  copy at `20261231000000` and runs every later migration. Apply new migrations to the preview database with
  `migrate --driver neon-ws` after merging.
- **Engine changes:** bump ENGINE and approve goldens only as `docs/engine-versioning.md` says. No existing number
  may move without a stated reason.
- **Known test noise:** `apps/web/test/format.test.ts` (an ICU difference, £27.4K vs £27.4k) always fails in this
  container. Timing tests can time out under load and pass when run alone.
- **Austin's rules:**
  - never ask for keys in chat;
  - use they/them, or Austin's name, in docs;
  - confirm before anything that affects production;
  - plain-English explanations;
  - Austin answers "defaults" to accept our recommendations.

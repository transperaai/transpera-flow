# P5: the Capacity page

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p5-capacity`, from `claude/relaxed-babbage-51ysen`.

Sources:
- the P5 row and "Definitions the prototype settled" in `docs/plans/client-build-handover.md`;
- requirements A1–A4, A6, A8, A9 and D16, D17, D22–D24, D30, D32, D37;
- the prototype's **Capacity** screen: `pageCapacity`, `capDept`, `personMax`, `lines`, `reassign`,
  `pickLeastBusy`, `salaries`, `revenue` and `verdict` in `docs/prototypes/client-capacity-app.PROTOTYPE.html`,
  lines ~548–911.

**Copy its sections, wording, and "answer first, then picture, then How this works folded" pattern exactly.**

## The short version

`w/[slug]/capacity` replaces the People page in the menu. The People route redirects to it; keep `people-page.tsx`
reachable only if something else still needs it. Its numbers come from the **engine** (busy share, hours by step,
monthly series), plus **pure derived figures** with tests. "Today" means the current book of clients, not the
prototype's calculator.

**In parallel:** P2b is making the database feed the capacity inputs to the engine and adding an example workspace
loader (`capacity:example`). The orchestrator will tell you when it's merged.
- Until then, build the derived figures against engine results from `capacityModel()` (`@transpera-flow/engine`
  fixtures).
- Build the page against `loadCapacitySetup` (P1) and the engine model the page gets today.

## 1. Derived figures: `packages/db/src/capacity-figures.ts`

Pure functions over the engine result, `personTime` and the Set up data, with hand-checked tests. Use the handover's
definitions, and `capacity-inputs.ts` for anything planned (expected hours a month).

| Function | What it gives |
|---|---|
| `busyShares` | Per person and per role: the engine's busy share and 10–90% range, against the role's `line`. |
| `personMax` | clients × line ÷ busy, and "can take" = max − clients. |
| `departmentCeiling` | The handover's `capDept`: the sum of client-facing maxima, capped by each shared team's room at its line for the tier mix of wins. It returns every limit, sorted, and names the lowest. |
| `serviceLines` | Organic, Performance, taking both (named clients with two departments + `tiers.both_count`), unique. |
| `dler` | Per department and for the whole business. Retainers ÷ salaries, with directors and managers in only when `dler_includes_leadership` is on. Contractors and leadership-flagged people are out. No ":1". |
| `perEmployee` | Clients per employee and revenue per employee (D22, P6 uses them too). |
| `hiringAdvice` | Per role: the first month its mean busy share passes its line in the 12-month run, minus the hiring delay. |
| `leaver(person)` | Hands their clients, one at a time, to the least-busy colleague who serves that tier. Use planned hours per client from `capacity-inputs.ts` for the move. **Exclude the leaver first** (the prototype's bug). Returns who gets how many, and each colleague's busy share before and after. |
| `timeToServe` | Planned hours a month for one client of each tier and for each named client, by purpose, and fee ÷ hours. Use `tasksPerMonth` × `stepParts`. |
| `bottleneck` | The person most over their line, and what fills their month (top steps from `personTime.stepHours`), each linked to its step. Use P0's pinned `rankBottlenecks` for the role and step view. |

The **room headline** follows the prototype's wording: "Organic (SEO) can take about **N more clients**" / "Full."

## 2. Runs

- **Today:** the workspace's model with **demand off** (no new leads) and `personTime` on, at the run length the
  Sandbox uses for a month-by-month run. Take the mean over the run.
- **Next 12 months:** the normal model, 12 months, monthly series on.
- Both run in the app's existing simulation worker (`apps/web/src/lib/sim/*`). Never on the server.
- `capacityModel()` takes about 5 s for 30 replications. **Start with 10 replications for Today and 20 for the 12
  months**, measure, and show the existing progress UI while they run. Report the times.
- Cache by the model's hash, as the Sandbox does.

## 3. The page (prototype order and wording)

1. **Headline row:** clients with Organic, with Performance, taking both (and unique); DLER Organic, Performance and
   whole business, with "goal 4.5".
2. **Room for more clients**, one card per department:
   - the sentence;
   - the gauge with every limit marked;
   - "Who can take the next client" as chips.
3. **Client-facing people**, one table per department: person (with team time), clients with tier chips, can take,
   rule, channels (Performance), hours needed, available, and a busy bar against the line.
4. **Shared teams:** busy share and members per team. Show the unit when one is entered; otherwise "hours" with "Rate
   not entered yet" (D35).
5. **Bottleneck:** the sentence, the stack bar of what fills their month, and the step links to the process page
   (D32).
6. **What if someone leaves?** A person select, the sentence, and before/after dumbbells. Note that "a replacement
   takes about 3 months to reach full speed" (read the ramp default).
7. **Time to serve one client, per month:** tier cards per department, and the named-clients table.
8. **The next 12 months:** the "What to do" list only (D32).

Each widget gets "How this works", folded, with the prototype's text adjusted to say the figures come from the
simulation.

**Empty and missing states:**
- No tier services yet: point to Set up.
- Engine problems (`capacityProblems`) or `missingForCapacity` items: list them, with links to where each is fixed,
  above the widgets they affect.

**Roles:**
- Viewers see the page.
- Salaries never show to whoever can't see pay. DLER still shows as a ratio, but its money breakdown is hidden.

Light and dark, and phone width: the tables scroll inside their card, and the page never scrolls sideways.

## Tests

- **Derived figures:** each function hand-checked on a small model.
  - `departmentCeiling` names a shared-team limit when it's lower.
  - `leaver` never gives a client back to the leaver.
  - `dler` is right with the leadership switch both ways.
- **Page:** render on the example workspace (once P2b is in) or on engine results from `capacityModel()`; the empty
  state; the missing state; the leaver select; the pay-hidden view; a phone-width check.

## Out of scope

- Overview (P6) and the Sandbox (P7).
- Editing anything: the page links to Set up.

## Done when

- `pnpm lint && pnpm typecheck` and the web and db suites for files you touched pass, and the web build passes.
- Screenshots of the page on the example workspace, light and dark, at 1440 and 400 px, saved under
  `apps/web/visual/` or attached to the report.
- The report gives run times and any figure where the engine and the prototype's definition disagree.

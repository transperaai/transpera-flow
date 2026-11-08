# P6: the Overview, per department

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p6-overview`, from `claude/relaxed-babbage-51ysen`.

Sources:
- the P6 row of `docs/plans/client-build-handover.md`;
- D22, D24 and D25;
- the prototype's **Overview** (`pageOverview`, `deptStats`, `deptEmployees` in
  `docs/prototypes/client-capacity-app.PROTOTYPE.html`, lines ~732–801);
- the existing Overview (`apps/web/src/app/w/[slug]/overview`, `components/overview/*`);
- P5's `packages/db/src/capacity-figures.ts` and the Capacity page's runs.

## What to build

1. **One card per department** (Organic, Performance), in the prototype's wording, with these figures:
   - **Clients**, and how many also take the other department.
   - **Clients per employee:** department clients ÷ everyone in the department, with contractors and
     leadership-flagged people out (D22). Use `perEmployee`.
   - **Revenue per employee:** retainers ÷ the same people, a month.
   - **DLER:** retainers ÷ salaries, with "goal 4.5" and no ":1" (D24).
   - **At or over their line:** the count and the first names.
   - **Room for more clients:** from `departmentCeiling`, with its limit named.

   Below the figures: **Busiest people** (top 6, a busy bar against the line), and **Where the time goes** (purposes,
   hours a month and share).

   Each card links to Capacity.
2. **Whole business row:** unique clients (Organic + Performance − taking both), revenue per employee, and DLER as all
   retainers ÷ all salaries.
3. **The company map stays exactly as it is, with every control** (play, speed, scrubber, horizon, click through:
   D25), below the cards.
4. **What it replaces:** the health strip (issues-based) goes. If the by-process rows and trend charts are still on
   the page, they stay below the map ("Where the time goes" serves A4).
5. **Runs:** reuse the Capacity page's "Today" run and cache (same model hash, so opening Overview after Capacity costs
   nothing). Never run on the server.
6. **States:**
   - no tier services: the start checklist, with links to Set up;
   - missing salaries: DLER shows "Salaries not entered", with a link.
7. **Pay-hidden viewers** see the ratios but not the money behind them, as P5 does.

## Tests

- Figures on a small hand-checked model: per-employee excludes contractors, and DLER follows the leadership switch.
- Page render on the example workspace; the empty state; the pay-hidden view; phone width.
- The company map's existing tests still pass, untouched.

## Done when

- `pnpm lint && pnpm typecheck`, the suites for the files you touched, and the web build pass.
- Screenshots on the example workspace, light and dark, at 1440 and 400 px.

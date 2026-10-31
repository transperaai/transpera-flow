# P9: follow-ups and clean-up

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p9-cleanup`, from `claude/relaxed-babbage-51ysen`.
Migration versions `20270125000000`–`20270125009999`.

Each item comes from an earlier package's report. Do them in this order, one commit each, and skip none without
saying why.

1. **Set a driver recurrence in the app.**
   - The servicing-link editor (Settings, and the tier "More" in Set up) gains "From the tier" next to fixed and ad
     hoc: a deliverable (words, links, tech hours, meetings, builds, creative sets, channels, or ad hoc), × n, per m.
   - It saves `{perMonth, driver, per}` (P4 made the database accept it).
   - `transpera-process/2` has no servicing links, so nothing changes there.
2. **A leadership flag on roles.**
   - `roles.leadership boolean default false`, edited in Set up → People & roles. It means: left out of "clients per
     employee" and "revenue per employee" (D22).
   - It replaces P5's role-name guess (`isLeadershipRole` in `capacity-figures.ts`). Keep the guess only as the
     starter's default for the prototype's role names.
   - DLER keeps following `dler_includes_leadership` (D37).
3. **Hiring delay.** `hiringAdvice` reads the workspace's own hiring delay (market / demand settings, the "Hiring
   delay" lever's base), not the fixed 2 months.
4. **One place per field in Set up.** P1 kept the old full Clients, People and Roles lists in folds, so some fields
   can be edited twice on a page.
   - Move what only the old lists have (the add forms, inactive filters) into the new tables.
   - Then remove the folds and the old section components, with their tests moved or replaced. Nothing a user could
     edit may be lost; list each field and where it now lives.
5. **Step links.** A deep link `/w/[slug]/p/[processId]?step=<id>` opens the process page with that step selected.
   The Capacity page's bottleneck and the Overview use it.
6. **Viewers see step base values.** The process page shows a read-only `StepBaseValues` for the selected step (P4
   built `readOnly`).
7. **Demo-mode sweep.** P0 left `mode: "demo"` code paths, orphaned modules and the unreachable `guest` sign-in
   plumbing (list in [transperaai/transpera-flow#253](https://github.com/transperaai/transpera-flow/pull/253)).
   - Remove what no route reaches.
   - Where tests render screens in demo mode, give them a plain test mode or fixture instead. Don't lose coverage.
   - The old `lever_settings` table: drop it in a migration (with rollback; check `copy-from-supabase`), since P0
     stopped reading it.
8. **Unused Overview health strip.** Delete `components/overview/health-cards.tsx` (unused since P6), its tests in `overview-b15.test.ts`, and the by-path reads in `process-help.test.ts` and `settings-help.test.ts`. Keep whatever those help tests check for the files that remain.
9. **Docs.** Update `README.md`, `docs/HANDOVER.md` and `docs/new-client.md` so they describe the capacity app as it
   now is: Set up, Capacity, Overview, the free-play Sandbox, the starter and example loaders, and the preview
   migration script.

## Done when

- `pnpm lint && pnpm typecheck && pnpm test` and the web build pass.
- Goldens unchanged.
- The report lists every removed file and every moved field.

# Q6: example issues and solutions for QA (Austin, 5 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q6-example-issues`, from `claude/relaxed-babbage-51ysen`.
No migration.

Austin wants to QA Issues and Solutions on the preview's **Example agency 2**, which the example loader filled with the
made-up agency (`packages/db/src/fixtures/capacity-example.ts`). It has 13 stored changes but no issues or solutions.

## Build

1. **`packages/db/src/fixtures/capacity-example-issues.ts`: `addExampleIssues(client, workspaceId)`.** It adds, to a
   workspace the example loader filled, the following. Write everything through the same SQL functions and RPCs the app
   uses (log an issue, add a solution, link a change), so the rows are exactly what the app makes. Find them in
   `packages/db/src` and `apps/web/src/app/w/[slug]/issues/**` and `solutions/**`.
   - **About 8 issues**, logged on real steps of the example processes, in plain words, with a mix of ratings and
     statuses (open, in progress, resolved; at least one each), owners from the example people, and a short note each.
     Start from the prototype's list (`ISSUES` in `docs/prototypes/client-capacity-app.PROTOTYPE.html`, ~line 1113):
     - pacing lives in three places;
     - link team runs near its line, with vetting through one person;
     - onboarding crowds out monthly work. The example has no onboarding process, so put this one on the heaviest
       Organic manager step instead and say so;
     - content briefs re-typed for freelancers;
     - meeting prep is data hunting.

     Add 3 more that fit the data:
     - one on a step the run flags as a single-person dependency;
     - one on a waiting or approval step;
     - one resolved.
   - **Link the stored changes to the issues they fix**, as the prototype does:
     - pacing gets "Unified pacing with alerts" and "Anomaly and threshold alerts";
     - links get "AI link-domain pre-vetting" and "Link health monitor…";
     - briefs get "Content brief automation…";
     - meeting prep gets the two "Pre-call data collation" changes;
     - and so on, where a change fits.

     Set `capacity_changes.issue_id`.
   - **3 solutions**, each a copied map of one process with a real routing change (a step removed, merged or rewired),
     linked to an issue, at different stages:
     - **"One budget entry instead of three":** Performance pacing, which removes two copy steps or merges two steps;
     - **"Vetting by a second person":** the vetting step's work shared with another person or role;
     - **one more of your choice.**

     Each must open in the app and simulate: valid map, routing odds summing to 1, and so on.
   - **Idempotent:** if the workspace already has issues, it changes nothing and says so. It refuses a workspace that
     doesn't hold the example (check for a known example process name).
2. **The preview script.** `packages/db/scripts/neon-preview-example.sh` gains a mode, `--workspace <slug> --add-issues`.
   It runs a new `scripts/capacity-example-issues.ts` the same way the loader runs: through jiti, connection from the
   Neon API, never printed. Keep the existing modes unchanged.
3. **Tests** (`packages/db/test/capacity-example-issues.test.ts`):
   - it loads into a freshly loaded example workspace;
   - the issue count, statuses and ratings;
   - each linked change points at its issue;
   - each solution's map is valid and simulates;
   - a second run changes nothing;
   - a non-example workspace is refused.

## Done when

- `pnpm lint && pnpm typecheck` and the db tests you touched pass, plus the issues and solutions web tests if you
  changed anything they use (you shouldn't need to).
- The report lists the issues, the change links and the solutions, with the step each sits on.

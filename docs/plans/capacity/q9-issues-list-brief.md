# Q9: the Issues list, tidied, and adding a change from an issue (Austin, 5 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q9-issues-list`, from `claude/relaxed-babbage-51ysen`. No
migration expected.

Austin's QA of the Issues page (`apps/web/src/app/w/[slug]/issues/page.tsx`, `components/issues-page.tsx`,
`issues-register.tsx` and related). The preview's Example agency 2 has 8 example issues (Q6). Screenshot before and
after.

## Changes

1. **Remove the "Export CSV" button** from the Issues page. Delete its code and tests if nothing else uses them.
2. **Rename the "Touches" column to "Step"**, including its header, help text and any sort label.
3. **Status tags in distinct colours.** Every status (open, in progress / testing solutions, resolved, and any other the
   app has) gets its own pill colour from the existing theme tokens, readable in light and dark. Use one shared
   `StatusPill`, and use it on the issue page too.
4. **Redesigned toolbar.** Today the filters and buttons at the top are poorly laid out. Make one row above the table,
   like Q7's Processes toolbar:
   - left, search (if there is one);
   - then filter dropdowns: **Status** (multi-select, with counts), **Owner** (multi-select, with "Unassigned"), and
     the filters the page already has (rating, process), restyled to match;
   - right, the page's primary action (log an issue, if it lives here).
   - A "Clear filters" link appears when any filter is on.
   - Filters persist in the URL query, so a link keeps them.
   - Wrap cleanly at 400 px.
5. **"+ Add a change" on the issue page.**
   - In the issue page's "Changes anchored to this issue" section (P8), add a button for editors.
   - It opens P7's change dialog (`play-change-dialog.tsx`) with "Fixes issue" already set to this issue, and saves
     through the same server action.
   - The section refreshes its figures after a save.
   - Explain in the section's (i) help, in one sentence, what a change is and that it's also editable in the Sandbox.

**In parallel:** Q8 (the process page redesign) and Q7 (Processes page) are building. Keep the shared toolbar pieces
small. If Q7 has already added a toolbar component, reuse it after merging; otherwise build yours so it can be shared.

## Done when

- `pnpm lint && pnpm typecheck`, the issues tests (pages, register, issue page, change dialog), and the web build pass.
- Screenshots of the Issues page with the example issues, at 1440 px light and dark and at 400 px, plus the issue page
  showing the new button, under `docs/plans/capacity/q9-shots/`.

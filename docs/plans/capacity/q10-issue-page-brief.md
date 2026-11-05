# Q10: the issue page redesigned, solution status, solutions tried (Austin, 5 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q10-issue-page`, from `claude/relaxed-babbage-51ysen`
**after Q8 (process page redesign) and Q9 (Issues list) have merged**. Migration range
`20270128000000`–`20270128009999`.

Austin: the issue page is a mess, and UI is inconsistent across the app. Q8 introduced the page's card system (header
card, section cards, button groups, pills, empty states).
- Step 1 (do it first): extract those pieces into `apps/web/src/components/page-kit/`: `PageHeader`, `SectionCard`,
  `Toolbar`, `StatusPill`, `EmptyState`, `MetaLine` and `Timeline`. Move Q8's and Q9's usages onto them without
  changing how those pages look.
- Then build this page with them. Later packages sweep the rest of the app onto the same kit.

## The page (`apps/web/src/components/issues/issue-page.tsx`, `app/w/[slug]/issues/[number]/page.tsx`)

1. **Header** (`PageHeader`):
   - "#6 Only Karl can vet link domains";
   - pills: rating, status, and the process and step it's on;
   - meta line: owner(s), created date, last change;
   - right, a button group: Edit · Resolve / Reopen.
   - **The status is a pill dropdown** (Open, Testing solutions, Resolved, Won't fix) that saves at once, through the
     same status save the app uses (`issue-status.ts`, `save_issue`).
   - Choosing Resolved still opens the existing Resolve dialog, to pick the solution that fixed it.
   - Owners are editable in place, through a popover.
2. **Where this issue sits** (`SectionCard`): the map, framed as on Q8's process page, with the issue's step lit.
3. **What's wrong** (`SectionCard`): the issue's `evidence` text, **editable in place**.
   - Click, edit and save. Saves through the existing per-field save, with compare-and-set.
   - When empty: "Say what you saw: what goes wrong, how often, and what it costs." and an "Add" button for editors.
   - Readers see the text only.
4. **Solutions tried** (`SectionCard`), which replaces "Solutions tested". One row per linked solution:
   - name;
   - **status pill dropdown** (item 6);
   - date tried;
   - what it changes, in one line from the solution's own description or its step diff;
   - result against today, using the comparison the solution page already computes (the auto verdict and the headline
     measure). Show it only if it's already loaded or cheap; otherwise "Open to compare";
   - notes, editable in place;
   - opening the row opens the solution page.

   Header buttons (editors):
   - **"+ Try a new solution"**: creates a solution from this issue's process, linked to this issue, with the same
     server action the Solutions page uses to make one, then opens it in the editor;
   - **"Link an existing solution"**: the existing picker.

   **Empty state:** "No solutions tried yet. Copy the map, change it, and compare it with today."
5. **History** (`Timeline`): the existing `issue_events`, newest first. Each entry has an icon per kind (created,
   edited, status, linked, solution, resolved, reopened), who, when, and one plain line: "Status: Open → Testing
   solutions"; "Edited what's wrong"; "Linked step Domain vetting". The fold explains: "Written automatically when
   the issue is created, edited, changes status, gains or loses a link, a solution is judged, or it's resolved."
6. **Solution status (new).**
   - **Migration:** `solutions.status text not null default 'testing'`, check in (`idea`, `testing`, `works`,
     `doesnt_work`, `adopted`).
   - **Backfill:** `works` where every link's user verdict is pass, `doesnt_work` where any is fail, else `testing`.
   - **Labels:** Idea, Testing, Works, Doesn't work, Adopted.
   - **Editing:** a pill dropdown on the solution page header and on each Solutions tried row; editable by editors,
     saved at once.
   - **Logging:** a status change logs a `solution_tested`-style event on each linked issue's history. Extend the
     `issue_events.kind` check with `solution_status` if needed, with rollback.
   - **Verdicts:** the existing per-issue pass/fail verdicts stay, under the status, as detail.
   - **Carried by:** the bundle and its restore, `save_fields` (copy the latest body), and the Q6 example loader (its
     three solutions: testing, works, adopted).
   - **Migration rules:** full rollback, `copy-from-supabase` passes, copy the latest `import_workspace_bundle` body.
   - Record decision D43 in `client-requirements.md`.
7. **Remove** anything Q9 left of "Changes anchored to this issue" (D42).

## Done when

- `pnpm lint && pnpm typecheck`, the issue page, solution page, issues list and history tests, `copy-from-supabase`, and
  the web build pass.
- Screenshots of issue #6 and #8 from the example (Q6 data), at 1440 px light and dark and at 400 px, plus the solution
  page header with its status, under `docs/plans/capacity/q10-shots/`.

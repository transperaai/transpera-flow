# P8: issues show what each change frees; blocks carry base values

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p8-issues`, from `claude/relaxed-babbage-51ysen`.
Migration versions `20270124000000`–`20270124009999`.

Sources:
- the P8 row of `docs/plans/client-build-handover.md`;
- `docs/plans/keep-cut-build.md` ("Improve");
- the prototype's **Issues** and issue page (`ISSUES`, `libEffect`, `pageIssues`, `pageIssue` in
  `docs/prototypes/client-capacity-app.PROTOTYPE.html`, lines ~1113–1136);
- P7's `capacity_changes` table (`issue_id`);
- P3's hours-freed output (`personTime.freed`);
- P5's `departmentCeiling`.

## What to build

1. **A change names the issue it fixes.**
   - `capacity_changes.issue_id` is already there (P7). Add the picker to P7's change editor: the workspace's open
     issues, by number and title.
   - Solutions already link to issues; leave that as it is.
2. **The issue page gains "Changes anchored to this issue".** It's a table, in the prototype's wording, with three
   columns:
   - the change and its kind;
   - **hours freed a month**: the engine's `freed.byChange` for that change alone, against today;
   - **more clients the department can hold**: `departmentCeiling` with the change against without.

   These come from one run per change, in the worker, cached. Show progress, and run them only when the issue page
   is open. The issue list shows "N changes →" per issue.
3. **Blocks carry base values.**
   - A block library block's steps keep P4's split, tier multiplier, `to_client_manager` and sources when a block is
     saved and when it's dropped into a map. Check every copy path P4 listed.
   - The block page shows each step's split bar.
4. **The "used in N solutions" count.** It is always 0 today (a known gap). Count the solutions whose map contains the
   block's steps, using the block-insertion record if there is one; otherwise match by the step ids the insert
   copies. Say which you used.

## Tests

- **Picker:** saves and clears `issue_id`.
- **Issue page:**
  - the hours-freed and more-clients figures on the example workspace match a direct engine run of the same change;
  - an issue with no changes shows the empty state.
- **Blocks:** a block round-trip keeps the split; the used-in count is right with 0, 1 and 2 solutions.

## Done when

- `pnpm lint && pnpm typecheck`, the suites for the files you touched, and the web build pass.
- The report lists the copy paths checked for blocks.

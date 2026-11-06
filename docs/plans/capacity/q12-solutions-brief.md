# Q12: solutions as a list, every solution tied to an issue, the Editor's "Try again", example blocks (Austin, 6 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q12-solutions`, from `claude/relaxed-babbage-51ysen`. A
migration only if item 2 needs one (range `20270129000000`–`20270129009999`).

## Changes

1. **The Solutions list is a list.**
   - Replace the card board with kit `ListRow`s, or a table like the Issues list.
   - **Columns:** solution name, **linked issue(s)** (#n title, linking to the issue), status pill, process, last updated.
   - Keep Q11c's toolbar (search, Status, Process), and add an **Issue** filter (including "No issue").
   - Rows open the solution page.
2. **Every solution starts from an issue.**
   - **"+ New solution"** on the Solutions list opens a dialog. The person picks an open issue (searchable), or "Log a new issue" (the existing new-issue flow, then back here). Then they go to the Editor in solution mode on that issue's process, with the issue pre-linked. Use the existing solution-mode href and the existing `linkSolutionToIssue` on first save.
   - **In the Editor's solution mode,** saving a solution with no linked issue is refused, in plain words: "Pick the issue this solution fixes. To change the process without an issue, edit the process itself (a new draft), or save the steps to the Block library." There are two buttons: "Edit the process instead" (the normal draft) and "Save as a block".
   - **Existing solutions with no issue** show "No issue" in the list, with a "Link an issue" action.
   - **The issue page's "+ Try a new solution"** already passes the issue. Make sure it lands pre-linked.
3. **The Editor's "Try again" screen.**
   - Opening the Editor shows the error screen first, every time, then works after "Try again". The likely cause is that `EditorSkeleton` → `ProcessTopBar` renders `SidebarTrigger` (which calls `useSidebar`) where no `SidebarProvider` wraps the Editor route, so the loading state throws.
   - Confirm it, then fix it so the Editor's loading state never needs the provider. For example, render a plain placeholder there, or render `SidebarTrigger` only inside a provider.
   - Check every other `loading.tsx` and skeleton for the same pattern.
   - Add a test that renders each route's loading component without a `SidebarProvider` where the route has none, or an equivalent guard.
4. **Example blocks for QA.**
   - Extend Q6's `addExampleIssues`, or add `addExampleBlocks` and run both from `--add-issues`, idempotently: 3–4 reusable blocks in the Block library, built from the example's real steps:
     - "Client approval loop": send, wait for approval, revise;
     - "QA and sign-off": check, sign off;
     - "Monthly report": pull data, commentary, send;
     - "Link vetting pair": pre-screen, final look.

     Each carries base values (split, tier multipliers), and at least one is used in one of the example solutions, so "Used in N solutions" shows 1.
   - Use the same SQL or RPC the app uses to save a block.
   - Extend the preview script's `--add-issues` so it also adds blocks when none exist.
   - Tests, as for Q6.

**Not in this package (Austin deciding):** descoping the solution page.

## Done when

- `pnpm lint && pnpm typecheck`, the solutions, editor, issue page, blocks and loading tests, and the web build pass.
- Screenshots of the Solutions list, the New solution dialog, and the Editor refusing an unlinked solution, under
  `docs/plans/capacity/q12-shots/`.
- The report states the "Try again" cause.

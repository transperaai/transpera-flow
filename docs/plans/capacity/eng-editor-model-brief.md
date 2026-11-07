# Editor model: the data side of the simpler editor (Chat A)

Read `docs/plans/capacity/README.md` and `docs/plans/capacity/editor-brainstorm.md` (settled items 1–6) first.

- **Branch.** `claude/eng-editor-model`, from `claude/relaxed-babbage-51ysen`.
- **No migration** is expected. If one turns out to be needed, stop and report; the range is `20270135000000`–`20270135009999`.
- **Scope.** Pure functions and one server action, with tests. No UI: Chat B builds the screens on top of these
  (`ui-editor-simplify-brief.md`).
- **Where the edits go.** Edits live next to today's: `apps/web/src/lib/editor/` (`commands.ts`, `groups.ts`) and
  `apps/web/src/lib/blocks/blocks.ts`. Each one returns an `Edit`, as `insertBlock` and `addAfter` do, so each is a single
  undo.

1. **`turnIntoSteps(bundle, holderId, part)`: a linked process becomes steps.**
   - **What it does.** It replaces a holder step (`kind: "subprocess"`, `child_process_id`) with a copy of the held
     process's live steps and lines: new ids, put where the holder was, and grouped under a group named after the
     process.
   - **Reuse.** Use `replaceWithBlock`'s wiring (the lines into the holder go to the copy's entry, and the copy's ends go
     to the holder's next steps).
   - **Ends.**
     - Map the child's ends exactly as the engine reads a held child today (`resolveGraph` in `packages/db/src/model.ts`).
     - The test: `toEngineModel` before and after gives the same simulation summary for a fixed seed and run count, on
       a seeded process that holds a child.
     - If the ids make an exact comparison impossible, compare the summary's numbers. Say which you did.
   - **When it refuses.** It returns `null` with a reason when the child has no live version, or when the holder is a
     company map card (that's not the editor's).
2. **`nodeProblems(bundle)`: what stops the process simulating, by node.**
   - **Returns** `{ steps: Map<stepId, string[]>, edges: Map<edgeId, string[]>, total }`, in plain words.
   - **Built from** `stepWarnings` (`commands.ts`), the `toEngineModel` `ModelError` (pinned to its step or line where
     the message names one; otherwise a process-level entry), and a decision whose shares don't add up to 100%.
   - **The editor bar's line:** "1 thing to fix before this can simulate" or "N things…".
   - **Publish.** Check that what blocks Publish today is the same set, or a subset; if it isn't, report the
     difference.
3. **Decision edits** (settled item 5):
   - **`addDecision(bundle, selectedId, view)`.**
     - It puts the decision after the selection.
     - The selection's next step becomes the "Yes" branch. The "No" branch goes to a new step named "Next step", placed
       in view. With no next step, both branches get a new step.
     - The shares are 0.5 and 0.5, and the branch name is the line's `label`.
     - It replaces the palette's decision path in `addAfter`.
   - **`setBranchShare(bundle, decisionId, edgeId, percent)`.**
     - It sets one branch, and the last branch, in line order, takes what is left. Other branches keep theirs unless the
       total would pass 100%; then they shrink in proportion.
     - Whole percents, and the stored values always sum to exactly 1.
   - **`addBranch(bundle, decisionId, target)`.**
     - It takes its share from the last branch.
     - The target is one of: a step id; `{ goBackTo: stepId }`, which must be a step that leads to the decision, or it
       refuses with the reason; or `{ end: "won" | "lost" | "done" }`, which reuses an end with that outcome or makes
       one. Won and lost are for pipelines only.
   - **`setBranchTarget(bundle, edgeId, target)`**, with the same targets.
   - **`setBranchName`** and **`setBranchCondition`.** These are plain field edits; use the existing ones if they cover
     it.
   - **`isGoBack(bundle, edgeId)`.** True when the line points to a step that leads to its decision. The canvas draws
     these as "Go back to X".
   - **Check the engine.** Confirm it runs a loop through any such line (`packages/engine/test/loops.test.ts`). If a go
     back to some steps isn't supported, `addBranch` and `setBranchTarget` refuse it with the reason.
4. **`addPurpose(workspaceId, base, { name, description })`**, a server action beside `savePurposes`
   (`apps/web/src/app/w/[slug]/settings/actions.ts`).
   - It appends a workspace purpose and returns its new key. It uses the same compare-and-set, the same permission
     (`canEditWorkspace`) and the same limits (12 at most, name length).
   - It makes no step edit: the editor sets the step's purpose with the key it gets back.
5. **No new links.** Nothing above makes a holder step. Confirm no editor command except the process library's makes
   one (Chat B removes the library).

Tests for each function, edge cases included: a decision as the last step, a go back to the decision itself, a share of
0% and of 100%, a holder whose child holds a child. Done when `pnpm lint && pnpm typecheck && pnpm test` and the web
build pass.

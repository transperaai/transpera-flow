# The simpler process editor (Chat B)

Read `docs/plans/capacity/README.md` and `docs/plans/capacity/editor-brainstorm.md` first; the brainstorm's settled items
are the design.

- **Branch.** `claude/ui-editor-simplify`, from `claude/relaxed-babbage-51ysen`.
- **Blocked by** Chat A's `eng-editor-model-brief.md`, which provides `turnIntoSteps`, `nodeProblems`, the decision edits,
  `isGoBack` and `addPurpose`. It is also best done after `editor-quick-fixes-brief.md`. No migration.

1. **Node types look different** (settled item 2): Step, Wait, Decision, End and Go back, plus a fixed Start.
   - The palette is "+ Step", "+ Wait" and "+ Decision". End and Go back come from a decision's branch menu, and from
     the Type field.
   - Start can't be deleted, and the Type field doesn't offer it.
2. **Decisions** (settled item 5).
   - **Adding one.** "+ Decision" uses `addDecision`.
   - **On the canvas.** The node shows the question and a row per branch (name and %).
   - **The side panel.** It holds the question, then each branch's name, %, "Goes to" menu ("Next step…", "Go back to…",
     "End (won / lost / done)") and an optional "Only when…" (the condition tag). There is a "+ Add branch" button.
   - **Branch lines.** Clicking a branch line selects its decision, with that branch's row in focus.
3. **Go back.** A line that `isGoBack` says is a go back is drawn as a small "Go back to X" node at the branch's end,
   linked to X. Clicking it selects the branch.
4. **Remove processes from the editor** (settled item 3).
   - "+ Process" and the process library (`components/editor/process-library.tsx`) go.
   - An existing holder step shows as a card labelled "Linked process: changes when 'X' changes", with a "Turn into
     steps" button (`turnIntoSteps`).
   - The company map's editor is unchanged.
5. **Problems on the nodes** (settled item 4).
   - The "Loose ends" panel goes.
   - Each node or line in `nodeProblems` gets a red mark, with its reasons on hover and on focus.
   - The editor bar shows the count line, which jumps to the first problem and selects it.
   - **Publish is blocked while `nodeProblems(bundle).total` is above 0,** as well as by today's reasons (unsaved edits,
     conflicts). This is stricter than today: branches that don't add up to 100% now block Publish too.
   - Use `problemsLine` for the bar's text, and `firstProblem` for its jump.
6. **Evidence leaves the editor.**
   - The `EvidencePanel` comes out of the step inspector, in the editor only.
   - Check that a step can still be linked to a source from the Sources library ("+ Link") and from the process page's
     step detail. If neither can, stop and report.
7. **Purpose** (settled item 1).
   - "What it achieves" gains "+ New purpose…" (a name and an optional description) through `addPurpose`. The step then
     takes the new key.
   - It is hidden for anyone `addPurpose` would refuse: only Agency admins and the Owner can add a purpose, as on
     Settings → Purposes.
   - It says "You have 12 purposes, the most there can be" at the limit.
8. **Help and the tour.** Update the (i) text and the editor tour for all of the above. Remove references to groups as
   nodes, the process library, loose ends and evidence.

Screenshots to Austin before merging: an editor with each node type, a decision with three branches and a go back, a
problem mark, and the new-purpose form, at 1440 light and dark. Done when `pnpm lint && pnpm typecheck && pnpm test` and
the web build pass.

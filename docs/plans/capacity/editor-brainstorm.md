# Brainstorm: a simple process editor (Austin and Chat A, 7 Nov)

These notes come from Austin's editor QA. Each answer is settled once it's written here. Briefs come after the last
question.

## Settled

1. **Purpose stays in the editor, and you can add one there.**
   - The "What it achieves" selector stays.
   - It gains "+ New purpose…" (a name and an optional description). This saves to the workspace's purposes straight
     away and sets the new purpose on the step.
   - Anyone who can edit the workspace can do this, as on Settings → Purposes, within the limit of 12.
   - The selector keeps showing the step's default purpose until a person changes it.
2. **Five node types a person adds, each looking different on the canvas.**

   | Node | What it is | What the side panel asks |
   |---|---|---|
   | Step | Someone does work | Who, how long, purpose |
   | Wait | Time passes, nobody works | How long |
   | Decision | The flow splits | Its branches and each one's %, shown on the node itself and not only on the lines |
   | End | The flow stops | Won, lost or done (pipelines); client work just ends |
   | Go back | Repeat from an earlier step | Which step, and how often. It sits after a decision's branch. |

   - **Start** is one fixed, labelled node per process: it can't be deleted or added.
   - **Group** is never added as a node. You group a selection and ungroup it (in the quick-fixes brief).
   - **Go back** replaces drawing a loop line by hand. The engine already runs loops, so the engine doesn't change (see 6).

3. **No processes in the editor: blocks only.**
   - Editing a linked process changes every process that holds it, so the editor's "+ Process" and its process
     library go.
   - Processes connect only on the company map, by hand-off lines (D51).
   - A block is always copied in and is yours to change.
   - **Existing links** (holder steps) stay visible, as a card labelled "Linked process: changes when 'X' changes", with
     one action, "Turn into steps". This copies the steps in and cuts the link. No new links can be made.
4. **Loose ends and evidence leave the side panel.**
   - **Loose ends.** Each problem shows on its node as a red mark that explains itself on hover. The editor bar has one
     line, "2 things to fix before this can simulate", that jumps to the first. Publish stays blocked while any are left.
   - **Evidence** leaves the editor. The record stays, and it is shown and edited on the Sources pages.
6. **"Go back" is stored as a line, drawn as a node** (a technical choice, made by Chat A).
   - It is a line from a decision's branch back to an earlier step, which is what the engine already runs.
   - The canvas draws the branch's end as a "Go back to X" node.
   - Its "how often" is the branch's %.
   - There is no new step kind, no migration and no engine change.

5. **A decision shows and edits its branches.**
   - **Adding one.** A new decision comes with two branches, "Yes" and "No", at 50% each, already drawn as lines out of
     it.
   - **On the canvas.** The node shows its question as the title, then one row per branch: name and %.
   - **The side panel.** It holds the question, then each branch's name and %, and "+ Add branch". The last branch
     always takes what is left, so the shares always add up to 100%.
   - **Where a branch goes.** Drag its line, or pick from its row's menu: "Next step…", "Go back to…" or "End (won /
     lost / done)".
   - **Conditions.** The condition tag stays, as an optional "Only when…" field on a branch.

## Briefs

- Chat A, the data: `docs/plans/capacity/eng-editor-model-brief.md`.
- Chat B, the screens: `docs/plans/capacity/ui-editor-simplify-brief.md`. It is blocked by Chat A's package.
- Already briefed: `docs/plans/capacity/editor-quick-fixes-brief.md`, which covers the five categories, block
  placement, undo and redo buttons, and no "+ Group".

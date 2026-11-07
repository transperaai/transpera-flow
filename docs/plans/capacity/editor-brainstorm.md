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
   - **Go back** replaces drawing a loop line by hand. The engine already runs loops, so the engine doesn't change; how
     it's stored is still to decide.

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

## Open

5. How a decision's branches are made and edited.

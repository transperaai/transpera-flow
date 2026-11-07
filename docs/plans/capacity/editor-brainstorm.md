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

## Open

3. Processes and blocks in the editor: keep both, merge them, or rename them.
4. What leaves the side panel (loose ends, evidence), and where it goes.
5. How a decision's branches are made and edited.
6. How "Go back" is stored: as a node, or as a line drawn as a node.

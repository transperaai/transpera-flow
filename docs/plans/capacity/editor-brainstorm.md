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

## Round 2 (Austin and Chat C, 8 Nov)

From Austin's QA of the process and company map editors on the Neon preview. Each answer is settled once it's written here.

### Settled

7. **One editor layout for both maps.**
   - Both maps have + Step, + Wait and + Decision. **+ Process** (the process library) is on the company map only.
   - "From a template" goes from the process library. "New process" (a name and a category) stays.
   - The canvas right-click menu works on both maps. "Open process page" shows only on a node that links to a process: every
     card on the company map, and the old linked-process nodes in a process.
   - The Simulate footer goes. The editor is for editing; simulating happens elsewhere.
8. **One side panel shape for every node.** The same order everywhere, and a node type skips what it doesn't have:
   type and name (Question for a decision); what it does; capacity values; more; Delete or Remove from this map.
9. **Step fields that go:** Promised time, Work already in progress, and all three analysis rules (Expected wait, Lost per
   day of waiting, Work lost benchmark). Pinned person and Done again stay visible.
10. **Time is entered one way.** Hands-on time and Wait each read "`[ ]` h usually", with a tick box "It varies" that opens
    Quickest / Usually / Longest.
    - Unticked runs as "about this, sometimes longer" with the usual spread (lognormal, as a blank spread does now).
    - Ticked runs as the range (triangular).
    - "Always the same" and the "How much it varies" number leave the screen. Steps already stored that way keep running
      as they are.
11. **"Automation and augmentation" leaves the step panel.** Automate… / Augment… and "Make a solution to try an
    automation" go. The stored step changes and the code that copies and runs them stay; the step's
    Work split stays. The Sandbox's automation levers were already removed (D53).
12. **A decision has one connector per branch on the canvas.**
    - Each branch row on the node has its own dot, labelled with its name and %. Dragging a dot connects or moves that branch.
    - A "+" dot adds a branch and connects it in one drag.
    - A branch's % can be edited on the node and in the side panel.
    - **Changing one branch's % shares the difference across the others in proportion** (this replaces "the last branch
      takes what is left" from item 5).

13. **A step, wait or decision on the company map is part of the run.** Adding or deleting one changes what the Sandbox
    simulates, as it does in a process (a decision between two processes splits the clients that pass it).
14. **The fields that go are hidden, not dropped.** Their columns, stored values and the issue detectors that read them
    (wait, drop-off, SLA) stay; only the editor stops showing them.
15. **The Solution page is the team's own words.** "What it changes" (lines worked out from the map) goes; the notes say what
    it changes, with its sources in the same card. The live map sits above the solution's. "Built by" becomes "Edited on
    <date>", and "Try it in the Sandbox" goes.
16. **An issue belongs to a process, not a step**, as its solutions do.
    - The issue form asks for no steps; a finding acknowledged from the run becomes an issue of its process.
    - No issue badges on any map. Steps an older issue was linked to stay in the database but are not shown.
    - The Issue page has no step pill, no History, and no right column: its sources sit under What's wrong.
17. **The target is part of What's wrong.** An empty What's wrong starts with four questions (what goes wrong, how often,
    what it costs, what good would look like). A target stored in the old fields shows as the text's last line and moves
    into the text the next time the issue is saved. The target columns stay in the database, unused.
18. **No automatic pass or fail.** Saving or linking a solution stores no automatic verdict; only the person's own counts,
    including over one stored before.

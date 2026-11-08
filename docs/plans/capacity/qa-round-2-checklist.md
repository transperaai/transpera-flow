# QA round 2: what changed, to check

Austin's QA notes of 8 Nov, and what was built for each. Tick each line on the preview
(`transpera-flow-git-claude-gallant-davinci-zamh91-transpera-ai.vercel.app`, a laptop or tablet: the Editor is not
shown on phones). The decisions behind them are in `editor-brainstorm.md`, round 2.

## Request 1: the editor's step panel (PR #308)

Open any process → ✎ Edit → click a Step.

- [ ] 1.1 No "Automation and augmentation" section: no Automate… / Augment… buttons, no "Make a solution to try an automation".
- [ ] 1.2 No "Promised time".
- [ ] 1.3 No "Work already in progress".
- [ ] 1.4 No "Analysis rules" (Expected wait, Lost per day of waiting, Work lost benchmark).
- [ ] 1.5 Still there: Name, Type, Who does it, Pinned person, Hands-on time, Wait, Work split, Done again, Tool, What it
      achieves, Notes.
- [ ] 1.6 Issues that relied on the hidden fields still show on the Issues page (nothing stored was removed).

## Request 2: the Solution page and the Issue page (PR #308)

Solutions → open one.

- [ ] 2.1 No "What it changes" list. In its place, one card "Notes and sources": your notes (say what the solution
      changes), then its Sources.
- [ ] 2.2 The two maps are stacked: "Live" on top, "With this solution" below.
- [ ] 2.3 The header says "Edited on <date>", not "Built by …".
- [ ] 2.4 No "Try it in the Sandbox" button. "Open in editor" is still there.

Issues → open one.

- [ ] 2.5 The header has the process pill only, no step pill.
- [ ] 2.6 No "History" card.
- [ ] 2.7 "What's wrong and sources": the issue's sources sit under What's wrong, with + Link. No separate Sources or
      "Linked to" card on the right.

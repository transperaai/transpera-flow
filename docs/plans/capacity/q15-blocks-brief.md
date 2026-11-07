# Q15: the Block library as a list, with Open and Edit (Austin, 7 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-q15-blocks`, from `claude/relaxed-babbage-51ysen`. A migration
only if editing needs a new function (range `20270133000000`–`20270133009999`).

Austin: the Block library still shows cards. Make it a list like the Processes page (rows that expand to show the item).
Each block needs Open and Edit buttons; today there's only "New block". Don't show fluff.

## Changes

1. **A list, like Processes** (`components/processes/processes-table.tsx` is the model to copy): one row per block. The
   columns, in this order (provisional; Austin may adjust):
   - **Block:** name, with a one-line muted description (first line, truncated).
   - **Steps:** the count of working steps.
   - **Who does it:** the distinct roles its steps use, as small pills, with "+N" past three.
   - **Time per run:** the sum of the steps' likely hands-on time, in hours or minutes.
   - **Automatable:** the share of that time in the steps' automatable part (from `split`), or "–" when no step has a
     split.
   - **Used in:** "N solutions" (P8's usage count); clicking it lists them in a popover, with links.
   - **Updated:** a relative date.

   Centre the columns except Block, as on Processes. A chevron expands a row to show the block's map read-only inline,
   with its steps' split bars. Drop the block type, the creator, the long description and the step list.
2. **Row actions.**
   - **Open:** the expand.
   - **Edit:** editors only.
   - **⋯** menu: Rename, Duplicate, Delete.
   - **Delete** is refused while the block is used in any solution, with a plain line saying where it's used. Use
     whatever block delete exists; add one through the app's write path if none does.
   - **Duplicate** copies it as "<name> (copy)".
3. **Edit an existing block.**
   - Today block mode in the Editor only makes a new block on an empty map.
   - Add editing: `edit?mode=block&block=<id>` opens block mode seeded with the block's steps and edges.
   - Save writes back to that block (name, description, steps, edges, base values) through the existing save path
     (extend it for an update, or add `update_block` in a migration with RLS like the neighbours), and keeps the
     `provenance.block` stamps on solutions untouched.
   - Cancel returns to the library.
4. **Toolbar:** search, plus a "Who does it" (role) filter. "+ New block" on the right. The page header from Q11c stays.
5. **Empty state:** keep Q11c's.

## Done when

- `pnpm lint && pnpm typecheck`, the blocks tests (db and web, browser ones included), the editor block-mode tests and
  the web build pass.
- Screenshots on the example agency (Q12's four blocks): the list, an expanded row, the ⋯ menu, and the Editor editing a
  block, at 1440 px light and dark and at 400 px, under `docs/plans/capacity/q15-shots/`.

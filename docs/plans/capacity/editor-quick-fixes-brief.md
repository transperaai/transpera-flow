# Editor quick fixes (Austin's editor QA, 7 Nov)

For Chat B. Read `docs/plans/capacity/README.md` first. Branch `claude/ui-editor-quick-fixes`, from `claude/relaxed-babbage-51ysen`.
No migration. Four small fixes. The bigger editor questions (node types, start, end and repeat, processes vs blocks, what
the side panel keeps) go to a brainstorm with Austin in Chat A first. Don't redesign the editor here.

1. **New process: the five categories, not the two kinds.**
   - **Today.** `components/new-process-dialog.tsx` asks for the engine kind (Pipeline or Servicing), and
     `createProcess` in `app/w/[slug]/process-actions.ts` derives the category from it. D41 made the category what
     people see.
   - **Change.** Offer the five categories (Sales, Onboarding, Routine client work, Ad hoc, Internal), with the same
     words and one-line descriptions as the Processes page's Type column. Derive the kind from the category (D52 below).
     Keep the start and end names, which come from the kind.
   - **Tests.** Update the dialog and action tests, and add one per category.
   - **D52 (Chat A, 7 Nov): a category's engine kind.** Sales and Onboarding are pipelines. After Q17, an onboarding
     pipeline runs when the company map hands won clients to it. Routine client work, Ad hoc and Internal are servicing.
     D52 is recorded in `docs/plans/client-requirements.md`.
2. **A block lands where you're looking.**
   - **Today.** "+ Step / Decision / Wait" pass the view (`viewRef`) to `addAfter`, which uses `nearestFreeSpot`.
     `insertBlock` (`lib/blocks/blocks.ts`, called from `components/editor/use-blocks.ts`) ignores the view. With nothing
     selected, it puts the block to the right of the last step, often off screen.
   - **Change.** Give `insertBlock` the same optional view hint. With nothing selected and a view, place the block's box
     at the free spot nearest the view's centre, measured as it measures today. With a step selected, keep today's
     placement after it, but if that is off screen, pan the map to the new block.
   - **Test.** Insert with nothing selected lands in view.
3. **Undo and redo buttons** in the editor bar (`components/editor/editor-bar.tsx`).
   - The editor already has `undo()`, `redo()`, `undoLabel` and `redoLabel` (`lib/editor/editor.ts`), and
     `use-edit-commands.ts` binds ⌘Z / ⇧⌘Z.
   - Add two icon buttons, disabled when there's nothing to undo or redo. Their tooltip is the label, e.g. "Undo: Added
     Discovery call".
   - Use the page kit's icon button if there is one.
   - **Test.** A component test for the buttons.
4. **Remove "+ Group" from the palette** (`components/editor/palette.tsx`, `PALETTE`).
   - Grouping stays as it is: select steps, then Group; select a group, then Ungroup.
   - Remove the `group` palette kind from `addAfter` if nothing else uses it.
   - Update the Add section's (i) text so it no longer mentions groups.
   - Update the editor tour if it points at "+ Group".

Done when `pnpm lint && pnpm typecheck && pnpm test` and the web build pass. Send Austin screenshots of the dialog and the
editor bar, at 1440 light and dark.

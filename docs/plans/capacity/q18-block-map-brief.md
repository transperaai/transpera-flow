# Q18: the Block library's open row shows the real map (Austin, 7 Nov)

Read `docs/plans/capacity/README.md` first. Branch `claude/ui-block-map`, from `claude/relaxed-babbage-51ysen`. No migration.
Chat B (page refinement) owns this package.

Austin: opening a row in the Block library shows a map that looks fake (small grey SVG boxes) with a step list under it.
It should look like an opened row on the Processes page: the real process map, read-only. Drop the step list.

## What the Processes page does today (copy it)

- `components/processes/processes-table.tsx`: the open row renders `MapCard` → `ReadOnlyMap`, which is
  `<ProcessCanvas … showPlayback={false} showLanes={false} height="auto" legend zoomControls />` inside
  `div.min-w-0.overflow-hidden.rounded-token.border.bg-card`, with `ProcessCanvas` loaded through `next/dynamic`
  (`ssr: false`, `MapSkeleton height={256}` while loading).
- The card's data is loaded the first time the row opens, through a server action (`app/w/[slug]/processes/actions.ts`
  `openProcessCard`), with a loading skeleton and an error line.

## Changes

1. **The real map in the open row.** In `components/blocks/block-library.tsx`, `BlockCard` draws the block with
   `ProcessCanvas`, using the same props and wrapper as Processes' `ReadOnlyMap` (no issue badges: pass none).
   - Turn the block into a `ProcessBundle` with `bundleFromBlock(base, readBlock(block.steps), block.name)`
     (`lib/blocks/blocks.ts`). It already exists for the Editor's block mode, keeps the step ids, and takes roles and
     people from `base`.
   - `base` is the live bundle of the workspace's first process, the same process the page already uses for
     `editBase` (`app/w/[slug]/blocks/page.tsx`, `processes[0]`). Load it the first time any row opens, through a new
     server action next to the page (e.g. `app/w/[slug]/blocks/actions.ts` `openBlockBase(slug, processId)`, validated
     like `openProcessCard`, read as the signed-in user so RLS applies; viewers can open rows too). Cache it in the
     library's state: one load serves every row. Pass the loader in as a prop so the browser harness can stub it.
   - While it loads: the Processes skeleton. If it fails: "Couldn't load the map. Close the row and open it again."
   - **No process in the workspace** (no `base`): keep today's SVG `BlockMap` as the fallback. Default; don't ask.
   - A block with no steps keeps today's "No steps in this block yet." line.
2. **Drop the step list** from the open row: remove `BlockSteps` from `BlockCard`. Delete
   `components/blocks/block-steps.tsx` if nothing else uses it, with its unit test in `test/blocks.test.ts` ("the block
   page draws each step's split bar"): the test covers removed code. This replaces Q15's "with its steps' split bars".
3. **Nothing else on the page changes**: columns, toolbar, row actions, the ⋯ menu, the header and the empty state stay
   as Q15 left them.

## Tests

- Update `test/q15-blocks-browser.test.ts` ("Open shows the map…") and `test/q11c-sweep.test.ts` (the Block library
  case): the open panel holds a React Flow canvas with one node per working step (`.react-flow__node[data-id]`, as
  `q15` already checks for the Editor), and no `[data-block-steps]` / `[data-block-step]`. Keep the `[data-block-panel]`
  checks. Rename the test to match.
- Add a case for the fallback (no base: the SVG `[data-block-map]` still draws) and for a failed load (the error line).
- Keep `test/server-client-boundary.test.ts` green: the server action file is `"use server"`, and the page passes it as a
  prop; the client library never imports a server component.

## Done when

- `pnpm lint && pnpm typecheck`, the blocks tests (db and web, browser ones included), the editor block-mode tests and
  the web build pass.
- Screenshots on the example agency (Q12's four blocks), an expanded row next to an expanded row on Processes for
  comparison, at 1440 px light and dark and at 400 px, under `docs/plans/capacity/q18-shots/`.

# Map UX: drag tiles in place, cleaner self-attaching lines, smoother animation (build brief)

Scoped 8 Oct 2026 against `origin/main` at `0ac7a626` (#246), with `claude/map-controls` at `2f13effc` read but not merged.
Read `docs/plans/builder-brief.md` first; its GitHub, branch and commit rules apply, and this brief wins where they differ.
Build strictly from this brief. If the code doesn't match what it says, **ask; don't guess.** Every open question has a
default (section 12). Use it.

Issue: see the GitHub issue "Map: drag tiles in place, cleaner self-attaching lines, smoother animation" (sub-issue of #3).
**Start only after the `claude/map-controls` PR has merged** (section 11). Branch `claude/map-ux` from the `origin/main` that
includes it. Use three PRs in this order: **A** (animation), **B** (lines), **C** (dragging, with the migration). Commit
and push after every numbered step.

---

## 1. What Austin asked for (verbatim)

On production, after asking for a bigger company map and zoom/fit controls (built in `claude/map-controls`):

> "allow me to move nodes in that view, just the ndies, i cant break relationships. can we make the liens cleaner, its a
> mess, we need auto locking for the lines, also the animations are choppy"

Then, on the drag:

> "the nodes move just in that session, it doesnt save the change"

Then, on the lines:

> "its stopping them getting overlapped mess. they can overlap but not so its filthy and confusing"

"That view" is the company map on the Overview, and by extension any read-only map of a live process. The goal for the
lines is readability, not zero crossings. In priority order:

1. Lines don't sit on top of each other: lines between nearby tiles are spread apart, not drawn on one path.
2. No long runs where two lines share a segment.
3. When several lines meet one side of a tile, their attachment points are spread out.
4. Labels don't sit on other lines (or on other labels).
5. Crossings are fine if they are clean: at right angles, not tangled.

## 2. What the investigation found

### 2.1 "The nodes move just in that session" (where a move is kept and where it isn't)

The read-only maps on `main` **cannot drag a tile**. Checked in the production build (`next start`, demo data):

- `process-canvas.tsx` passes `nodesDraggable={editable}`, `elementsSelectable={editable}` and
  `nodesConnectable={editable}` to `<ReactFlow>` (lines 1763–1767), and `editable` is `editor !== null`. The Overview
  (`overview/overview.tsx:532`), the process page (`process-page.tsx:381`), the issue page, solution compare, the processes
  list and the Larkspur view (`process-view.tsx` hard-codes `const editable = false`, line 154) never pass an editor.
- On `/demo/overview` and `/demo/p/…`, a tile has no `draggable` class. A pointer drag that starts on a tile **pans the
  whole map**: 92 DOM mutations, and the tile keeps its `translate(…)` while the viewport moves. On screen this looks like
  "the tile moved". It is the map panning, and it is "just in that session" because nothing is ever saved.
- The only place a tile really moves is the **Editor** (process or company map, "✎ Edit company map"). There
  `onNodesChange` (lines 1338–1366) turns a drop into `moveSteps` through `editor.run`, which saves to the **draft**
  ("Saved to draft"). The Overview and the process page show the **live** version, so the move doesn't appear there
  until the draft is published. This is the other way a move looks "not saved".

Both readings lead to the same fix: a drop on a read-only map of the live version is saved to the live version, for the
people who may edit (section 3). Nobody else drags. There is no silent drag-without-saving anywhere (section 3.1).

### 2.2 Why the lines are a mess (measured)

Today every connection is `getSmoothStepPath` from the source's single right-hand `Handle` to the target's single
left-hand `Handle` (`BranchEdge`, lines 575–653; handles at 418/457, 487/500, 518/534, 552/569). Read-only labels sit at
`(sourceX + 4, sourceY − 2)` (line 637), the same point for every line that leaves a tile. Measured on the demo maps with
`docs/plans/map-ux/lines.mjs` (the e2e metric in section 9.3 is the same code). Units are map units, at
1280 × 800:

| Map | Pairs of lines sharing a run > 8 units (longest) | Pairs sharing an end point | Labels lying on another label |
|---|---|---|---|
| Northbeam pipeline `/demo/p/c000…01` | 8 (325: Discovery call → Lost and Client decision → Lost are one path) | 8 | 4 ("55% / 45%", "30% / 70%", "68% / 32%", "55% · seo / 45% · ppc") |
| Larkspur `/demo/larkspur` | 10 (102) | 10 | 6 (every branch's labels are stacked) |
| Overview company map `/demo/overview` | 1 (48: both handoffs leave on one trunk) | 1 | 0 |
| Issue page `/demo/issues/1` | as Northbeam | 8 | 4 |

So a branch's labels are drawn on top of each other: only the top one can be read. Every line out of a tile leaves from
one point, and lines into one tile arrive at one point. Back lines (e.g. Client decision → Contract & onboarding) leave to
the right and wrap round the whole row. The #246 guard (`e2e/map-nodes.spec.ts`) checks only "under a tile", so none of
this fails a test today. The map image export (`lib/export/map-image.ts:234–270`) draws a different shape again: a cubic
from the right middle to the left middle.

### 2.3 Why the animations are choppy (measured)

Measured on the production build with CPU throttled 4× (CDP `Emulation.setCPUThrottlingRate`, a mid laptop on battery):
frame intervals from a `requestAnimationFrame` loop, median of 3 runs. React renders were counted on `next dev` with a
stand-in DevTools hook that counts components that actually ran in each commit. The scripts are in `docs/plans/map-ux/`.

**Root cause 1: the whole canvas re-renders on every zoom frame.** `Canvas` subscribes to the zoom
(`const zoom = useStore((st) => st.transform[2])`, line 1527) only to feed `ZoomControls`. `BranchEdge` subscribes to it
too (line 578), only to scale the inline editor. So every frame of a zoom or fit animation (150 ms `zoomTo`, line 1604;
200 ms `setViewport`, line 1565) re-renders `Canvas`, the whole `<ReactFlow>` tree, every node and every edge.
`claude/map-controls` keeps this: it passes `zoom` from `Canvas` to its new `MapViewControls`.

**Root cause 2: new handler functions on every render.** `<ReactFlow>` gets fresh inline functions on every `Canvas`
render (`isValidConnection`, `onReconnect`, `onNodeDoubleClick`, `onNodeContextMenu`, `onSelectionContextMenu`,
`onMoveStart`, `onNodeClick`, `onPaneClick`, and the `onNodesChange`/`onEdgesChange`/`onConnect` closures). React Flow's
`StoreUpdater` copies each changed prop into its store, which wakes every subscribed handle and edge. During a drag,
`Canvas` re-renders on each pointer move (`dragging` state), so **every** edge and **every** step tile re-renders on each
move. Only the dragged tile and its own lines should.

Both were checked with a throwaway patch (`docs/plans/map-ux/animation-experiment.diff`, not merged):
`LiveZoomControls` and an `Unscaled` wrapper are the only zoom subscribers, and `useStable` gives stable handlers.

| Interaction | Before | After the patch |
|---|---|---|
| Overview: Zoom in (150 ms), renders per animation | 7 × (Canvas + ReactFlow tree + 3 cards + 2 edges) | ZoomControls + Background only (10 commits) |
| Overview: Zoom in, frames over 25 ms | 3 (p95 33 ms) | 1 (p95 17 ms) |
| Overview: Fit (200 ms), frames over 25 ms | 3 (p95 33 ms) | 0 (p95 17 ms, max 17 ms) |
| Process page: Zoom in, frames over 25 ms | 5 (p95 50, max 67 ms) | 2 (p95 17, max 33 ms) |
| Process page: Fit, frames over 25 ms | 5 (max 50 ms) | 3 (max 33 ms) |
| Editor: drag a step 30 moves, renders | BranchEdge 521, StepNode 300, NodeWrapper 390, EdgeAnchor 1042 | BranchEdge 101, StepNode 31, NodeWrapper 31, EdgeAnchor 202 |
| Editor: drag 40 moves, frames over 25 ms | 5 | 2 |

**Root cause 3: opening a card on the Overview remounts the map.** `overview.tsx:534` keys `<ProcessCanvas>` by the open
set (`key={[...expanded].sort().join("|")}`), so Expand throws the canvas away and mounts it again (measure, frame, fit).
This gave one 350 ms frame and long tasks of 226, 137 and 70 ms (4×). The canvas already re-frames on request
(`requestFit`, used by Expand all), so the remount isn't needed.

**Root cause 4: closed cards skip the node cache.** `nodeCache`/`sameNode` (lines 193–198, 1198–1202) reuse only step and
terminal nodes. Group and closed-process cards are new objects on every `nodes` recompute. Each of the Overview's 6
re-renders on a horizon change (`result` changes) re-renders every card: 24 `GroupNode` renders for 3 cards.

**Secondary: playback.** Playback draws by `requestAnimationFrame` straight into the DOM, with no React (2 commits in 2 s,
good). It still costs about 3.7 ms of main thread per frame unthrottled (trace: 459 ms of 2 s, with Layout, Paint, Commit
and style recalculation **every frame**, 124 layouts in 2 s). At 4× that is a 33 ms median frame. The layouts come from
moving SVG `<circle>`s by `cx`/`cy` attributes (`place`, `playback-layer.tsx`) and rewriting badge text. JS self-time is
small (draw 10 ms, `frame` 6 ms in 3 s). The container has no GPU, so paint numbers here are pessimistic. Treat this as
"improve and measure", not a blocker.

**Secondary: the Editor's drop.** The drop (save) gave a 267–300 ms longest frame at 4×. The whole `EditorView`
re-renders, and the engine model is rebuilt and stringified (`editor-view.tsx:283`, `useEngineModel`), although
positions don't feed the model. That is out of Austin's view; section 6.6 has a cheap fix.

Not causes (checked): no `transition: all` or `transition-all` on map components (tiles use
`transition-[box-shadow,opacity]`). The simulation runs in a Web Worker (`lib/sim/use-simulation.ts`). The `PlaybackClock`
notifies React only on coarse changes. Panning re-renders only `Background` (30 renders for 30 moves).

### 2.4 Positions and the database (checked on a local database from `bootstrap.sql`)

- Positions are `public.steps.x`, `y` (`numeric not null default 0`), per revision. Step ids are stable across revisions.
- **Positions feed nothing that is computed.** `toEngineModel` (`packages/db/src/model.ts`) never reads `x`/`y`. #246 moved
  six steps and the engine goldens passed unchanged. The analysis hash (`apps/web/src/lib/ai/model-hash.ts`
  `analysisBaseHash`) hashes the engine model, first principles and sources, so it is position-free. Headline numbers
  (`workspace_headlines`) come from runs. Share and play links are frozen snapshots. `flowOrder` (tab order) uses `y` only
  to order unreachable steps.
- Triggers on `public.steps`, and what each does on an `UPDATE` of `x`, `y` only:

  | Trigger | Fires? | Effect |
  |---|---|---|
  | `edit_drafts_only` | yes | Refuses `authenticated`/`anon` on a non-draft revision. A SECURITY DEFINER function runs as the owner, so it passes. |
  | `refuse_archived_rows` | yes | Refuses any update to an archived process's step, owner or not. The function checks first, to give a clear error. |
  | `flag_conflicts` | yes | Sets `conflict = true` if the provenance has an open conflict and the flag is false. Preflight 4 checks no live row is like that. |
  | `set_updated_at` | yes | Bumps `steps.updated_at`. `private.revision_changes` ignores `updated_at`. |
  | `audit_mcp` | yes, no-op | Logs only API-token requests. |
  | `refuse_row_moves` | no | `update of revision_id, process_id, workspace_id` only |
  | `company_holder_update_guard` | no | `update of child_process_id` only |
  | `log_perception_gaps`, `link_cited_sources` | no | `update of provenance` only |
  | `nesting_is_a_tree` | no | `update of kind, parent_step_id, …` only |

- Realtime: `apps/web/src/lib/realtime/supabase-transport.ts` subscribes to `steps` filtered by `revision_id` (the
  Editor's draft). A live-revision update reaches nobody. A mirrored draft update (section 4.3) reaches an open Editor,
  which is what we want.
- `publish_process`, `open_draft` and `discard_draft` take `select … from processes … for update`
  (`20261006000000_drafts.sql:86,142,179`).
- `audit_log` (`actor_kind` checked to `user|mcp|system`) is read by owners and admins only. The company change log reads
  only `COMPANY_AUDIT_TABLES` (`lib/company-data.ts:149`), so a new `processes` entry doesn't show there. That is right:
  arranging a map isn't a company-model change.

### 2.5 The company map's tiles

Overview cards are **processes**. `lib/overview/company-map.ts` `companyMap()` makes one group step per top-level process
with `id = process.id`. It places the card at the position of its **holder step** in the live revision of the workspace's
company process (`processes.is_company`). That step has `child_process_id = <process id>`, a real uuid in a workspace;
`holderStepId()` = `company:<id>` exists only in the demo's `defaultCompanyPart`. So moving a card means saving its holder
step's `x`/`y` in the company process's live revision. That is the same function, with `p_process` = the company process.
Two details:

- `makeRoom` shifts the cards to the right of, or below, an open card. A card's **drawn** position can differ from its
  stored one. Save `stored + (dropped − drawn before the drag)`, never the drawn position.
- Inside an open card, steps are drawn at offsets from their process's own min x/y (`inside()`), and child processes sit
  in their holder's place. Those tiles are **not** draggable on the Overview (section 12).

---

## 3. Decisions: dragging tiles (positions only)

### 3.1 Who may drag, and where

| Who | Live process page, Overview company map (live) | Everything else |
|---|---|---|
| Owner, editor, agency admin (`can_edit_workspace`) on a screen 640 px or wider | **Drag, saved** | Not draggable |
| Member, viewer | **Not draggable** (dragging a tile pans the map, as today) | Not draggable |
| Phone (under 640 px, `useIsPhone()`) | Not draggable | Not draggable |
| Demo (`/demo/*`, no database) | Drag, **kept for the visit only**, and labelled so: "Demo: moves aren't saved" | Not draggable |
| Share and play links, a history version ("Viewing version N"), an archived process, the issue page, solution compare, the processes list, swimlanes view | Never | Never |

Members and viewers cannot drag at all. A local-only move is what Austin complained about ("it doesnt save the change"),
and a viewer can't save. So the only honest options were "no drag" or "a drag that visibly says it's temporary". "No
drag" is simpler, needs no explanation, and keeps every reader's map the same as everyone else's. The demo is the one
exception: it has no database, it is where people try the product, and the e2e suite needs a draggable map without
Supabase. Its moves are labelled, so they are never silent.

"Just the nodes": no connecting, reconnecting, deleting, selecting, inline editing, context menu or arrow-key moves on a
read-only map. The tile's detail still opens on a click, and React Flow suppresses the click after a real drag.

### 3.2 Behaviour

- Drag a tile. Its lines follow live, re-routed (section 5). On drop the move is queued. **600 ms after the last drop**,
  all queued moves go in one call (one audit entry).
- A quiet status sits in the map's top bar, right-aligned with `aria-live="polite"`: "Saving…", then "Saved · **Undo**".
  On failure it reads "Couldn't save · **Retry**". On a refusal (42501, 22023, 55000) the tile returns to where it was
  and the bar reads "Couldn't save: you can't change this map any more" (42501) or "Couldn't save: refresh the page"
  (others). On a network failure the tile stays and Retry resends. The status fades after 4 s, apart from Undo, which
  stays until the next move or 30 s.
- Undo: the last saved batch's previous positions are sent through the same call. One level only. `Ctrl/⌘+Z` is not bound
  on read-only maps.
- `nodeDragThreshold={4}`, so a click that wobbles doesn't move a tile.
- A closed group or child-process card moves as one tile (its steps are inside it). In an open group, a step's position
  is relative to the group (`parentId`), as stored. An open group's box moves with its steps.
- The map doesn't re-fit after a drop, and a drop doesn't count as "moved by hand" (`handZoomed`). The panel-width refit
  carries on.
- The page's data isn't refetched after a save (no `router.refresh`, no `revalidatePath`). The canvas keeps the saved
  positions as an overlay until the bundle catches up (next navigation).

---

## 4. Migration (row 73): `20261228000000_save_step_positions.sql`

Additive: one new function. No table, column, trigger, policy or grant on an existing object changes.

### 4.1 Function

```sql
-- public.save_step_positions(p_process uuid, p_positions jsonb) returns jsonb
--   SECURITY DEFINER, set search_path = '', volatile.
--   p_positions: [{"id": "<step uuid>", "x": <number>, "y": <number>}, ...]
```

In this order:

1. `auth.jwt() ? 'api_token_id'` → `42501` "Map positions are arranged in the app". MCP edits go through drafts.
2. `select * into proc from public.processes where id = p_process for update`. This serializes with
   `publish_process`/`open_draft`/`discard_draft`, which take the same lock. Not found, or
   `not public.can_edit_workspace(proc.workspace_id)` → `42501` "You can't arrange this map", the same message for both,
   so it never says whether a process exists.
3. `proc.archived_at is not null` → `55000` "<name> is archived". `proc.live_revision_id is null` → `55000` "<name> has no
   published version yet".
4. Shape → `22023` "Bad positions" on any failure: `jsonb_typeof(p_positions) = 'array'`, 1 ≤ length ≤ **500**. Every
   element is an object with exactly the keys `id`, `x`, `y`. `id` is text that casts to uuid (check with a regex before
   casting, so a bad id gives 22023, not 22P02). `x` and `y` have `jsonb_typeof = 'number'`. Ids are distinct.
5. Clamp: `x`, `y` to `[-100000, 100000]` (`greatest/least`), rounded to 1 decimal place (`round(v::numeric, 1)`).
6. Every id must be a step of the live revision in the process's workspace (`s.revision_id = live and s.workspace_id =
   proc.workspace_id and s.process_id = proc.id`). If the count of matches ≠ the count of ids → `22023` "Unknown step".
7. `old` := the current `(id, x, y)` of those live rows.
8. Update the live rows whose position changes:
   `update public.steps s set x = v.x, y = v.y from v where s.revision_id = live and s.id = v.id and (s.x, s.y) is distinct from (v.x, v.y)`.
   Set nothing else.
9. **Draft mirror** (section 4.3): if `proc.draft_revision_id` is not null, update the draft rows with the same id **whose
   `(x, y)` still equals the live row's `old` position**. Collect their ids as `mirrored`.
10. Audit, one row, only if at least one live row changed:
    `insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)`
    with `values (proc.workspace_id, auth.uid(), 'user', 'arrange', 'processes', proc.id, jsonb_build_object('revision_id', live, 'moves', <[{id, from: {x, y}, to: {x, y}}] for changed rows>, 'draft_revision_id', proc.draft_revision_id, 'mirrored', <ids>))`
    (`jsonb_strip_nulls`).
11. Return `{"saved": <live rows changed>, "mirrored": <draft rows changed>, "revision_id": <live>}`.

`revoke execute on function public.save_step_positions(uuid, jsonb) from public, anon;`
`grant execute on function public.save_step_positions(uuid, jsonb) to authenticated;`

It touches nothing else: no `processes`, `process_revisions`, `simulation`, `ai_analyses`, `workspace_headlines` or
`issues` row. A move doesn't make a version, mark the model changed, make an analysis stale or re-run anything. It works
the same for the company process: holders are ordinary steps, and `company_holder_update_guard` fires only on a
`child_process_id` change.

Pattern to copy for structure, header and errors: `public.restore_version` in `20261127500000_company_map_editing.sql`
(SECURITY DEFINER, `can_edit_workspace`, the audit insert with `auth.uid()`), and `private.company_map_edit` for the
"only touch what the person hasn't moved" rule.

### 4.2 Header comment (required)

Purpose; what it touches and what it doesn't (the trigger table in 2.4); the decisions in 3.1 and 4.3; preflight;
post-apply; rollback:

```sql
-- Rollback:
--   drop function if exists public.save_step_positions(uuid, jsonb);
--   delete from supabase_migrations.schema_migrations where version = '20261228000000';
--   ('arrange' rows in audit_log are left; they are harmless history.)
```

### 4.3 Concurrent drafts

If the process has an open draft, a step's draft copy follows the live move **only if the draft still has that step
where live had it** (nobody moved it in the draft). A draft that moved the step keeps its own position, and publishing
the draft wins, as any draft edit does. This is the rule the company-map sync already uses ("a rename or a move only
touches a holder the user has not renamed or moved", `20261127500000`). Without the mirror, a live-only move would show
up as a "moved" difference in the draft's change list and be undone by the next publish. With it, an untouched draft
stays equal to live. A step that exists only in the draft (new) or only in live (removed in the draft) is skipped
naturally.

### 4.4 Production steps (`docs/HANDOVER.md` → "Applying a migration")

Apply file `packages/db/scripts/apply/20261228000000_save_step_positions.sql`: `begin;`, the migration SQL, the
`schema_migrations` insert with `$mig$…$mig$`, `commit;`.

Preflight (each expects the result shown):

0. Row 72 is the latest. `select max(version) from supabase_migrations.schema_migrations` → `20261227000000`.
1. Nothing at or past this one. `select count(*) … where version >= '20261228000000'` → 0.
2. The name is free. `select to_regprocedure('public.save_step_positions(uuid, jsonb)')` → null.
3. The columns and helpers it uses exist. `processes.live_revision_id`, `draft_revision_id`, `archived_at`;
   `steps.x`, `y` are `numeric`; `public.can_edit_workspace(uuid)` exists.
4. No live row would be changed by `flag_conflicts` → 0:
   `select count(*) from public.steps s join public.processes p on p.live_revision_id = s.revision_id where not s.conflict and cardinality(s.replaced_by) = 0 and private.has_open_conflict(s.provenance)`.
5. The triggers on `public.steps` are the 12 listed in 2.4, with the same `update of` column lists
   (`select tgname, pg_get_triggerdef(oid) …`). A new trigger on `x`/`y` would need a review.

Post-apply:

1. `prosecdef` true, `proconfig = array['search_path=""']`, owner `postgres`.
2. `has_function_privilege('authenticated', 'public.save_step_positions(uuid, jsonb)', 'execute')` true; for `anon`,
   false.
3. The `schema_migrations` row is present.
4. A **rolled-back smoke test** through `prod-sql.sh -f`, one file, `begin; … rollback;`:
   - `set local role authenticated`, with `request.jwt.claims` set to the agency admin's `sub`.
   - Pick one live step of a non-archived process. Call with `x + 1`, check `saved = 1`, `steps.x` moved, one
     `audit_log` row with `action = 'arrange'`.
   - Create a throwaway `auth.users` row and a `member` membership (rows 70–72 do the same), switch the claims to it, and
     check the call raises 42501.
   - `rollback;`. Then, outside the block, check the step's `x` is unchanged and there is no `arrange` row.
5. Log row 73 in `docs/production-migrations.md` (version, name, date, PR, the preflight/post-apply results, rollback
   summary), mark it applied and push.

Also: `pnpm --filter @transpera-flow/db gen:bootstrap`. Hand-add the function to `packages/db/src/database.types.ts`
`Functions` (as #205–#207 did). Note in `docs/supabase-notes.md` that the smoke test of the RPC through PostgREST was run
on plain PostgREST only.

### 4.5 PRD and ADR

- Add **D50** to the PRD decision table, "Can a live map be rearranged without publishing?": yes, for owners, editors
  and agency admins, positions only, in place on the live version, with no new version. Positions aren't the model.
  Members and viewers can't drag. Draft mirror as in 4.3.
- Amend PRD §7.1b "Draft rules": "except tile positions (D50)".
- Add ADR `docs/adr/0018-arranging-the-live-map.md` with the why (2.1, 2.4), the alternatives (draft and publish per drag;
  local-only drags; per-user layouts) and the trigger audit.

---

## 5. Decisions: cleaner lines ("auto locking")

### 5.1 What "auto locking" means here

Each line **attaches itself to the best side of each tile** and re-routes as tiles move. Lines are orthogonal (horizontal
and vertical runs, rounded corners), go round tiles, keep apart from each other, and their labels sit where nothing else
is.

### 5.2 Options weighed

| Option | Fixes stacked labels | Fixes shared runs and points | Goes round tiles | Bundle | Risk |
|---|---|---|---|---|---|
| React Flow "floating edges" example (straight or bezier between nearest sides) | partly | no | no | 0 | low, but lines cut through tiles: fails #246 |
| Smoothstep with dynamic sides only | partly | partly (no spreading) | no | 0 | low |
| `elkjs` | yes | yes | yes | ~1.4 MB min | ELK *lays out* the graph (moves tiles); its fixed-position mode doesn't route edges. Wrong tool for user-placed tiles. |
| `libavoid-js` (Adaptagrams libavoid, WASM) | yes | yes (nudging) | yes | ~800 KB unpacked plus WASM init | **LGPL-2.1**, `0.5.0-beta`, async WASM in Next and in the export: a licence and stability call we shouldn't make for this |
| **Own small orthogonal router** (`lib/map/routing.ts`) | yes | yes | yes, at map sizes we have | ~10–15 KB | medium. Pure, deterministic, unit-testable, shared with the export |

**Chosen: our own router.** It is the only option that meets all five of Austin's priorities with no new dependency and no
licence question. It is pure, so the export uses the very same code (the screen and the PNG/SVG match). Maps are small (Larkspur: 19 tiles, 17
lines; the company map: a handful of cards), so a simple visibility-grid A* plus nudging is fast enough (budget in 5.4).

### 5.3 The router (`apps/web/src/lib/map/routing.ts`, new, framework-free)

```ts
export interface RouteBox { id: string; x: number; y: number; width: number; height: number; /** an open group's frame: lines may cross it */ frame?: boolean }
export interface RouteEdge { id: string; from: string; to: string; label?: string | null }
export type Side = "left" | "right" | "top" | "bottom";
export interface Route { id: string; points: { x: number; y: number }[]; fromSide: Side; toSide: Side; label: { x: number; y: number; width: number; height: number } | null; back: boolean }
export function routeEdges(boxes: readonly RouteBox[], edges: readonly RouteEdge[], options?: { only?: ReadonlySet<string>; previous?: ReadonlyMap<string, Route> }): Map<string, Route>;
export function routePath(route: Route, radius?: number): string; // SVG "d" with rounded corners (radius min(8, half the shorter neighbouring run))
export const LABEL_SIZE: (text: string) => { width: number; height: number }; // the same estimate the export uses: 6.4 px per char + 8, 16 high
```

Steps, all deterministic. Edges are processed in `flowOrder` rank and then id, so the same map always draws the same.

1. **Obstacles.** Every non-frame box is inflated by `M = 12`. Lines never enter an inflated box, except the short
   stubs at their own two ends.
2. **Sides.** Let `a` be the source and `b` the target:
   - `b` fully right of `a` (`b.x ≥ a.x + a.width + 2M`): right → left.
   - Else `b` fully below: bottom → top. Fully above: top → bottom.
   - Else (`b` is left of `a` and their rows overlap: a **back line**): leave and enter on the same side, top or bottom,
     whichever route costs less. Ties go to bottom. Mark it `back: true`.
   - Terminals (start, end) take the same rules.
3. **Ports (spreading).** Group line ends by (tile, side). Sort them by the far end's coordinate along that side, then by
   edge id. Space them evenly across the side: `side · (i + 1) / (k + 1)`, at least 14 apart and at least 10 from a
   corner. If they don't fit (e.g. 4 on a 46 px terminal side), keep 14 apart, centred, and let them run past
   `side − 20`, never past the corners. No two ends ever share a point.
4. **Route.** A* on the orthogonal visibility grid: the x and y lines through every inflated box edge, every port stub end
   (port + M outward) and the midlines between neighbouring boxes. Cost = length + **24 per bend** + **3 × length run
   within 4 units of, and parallel to, a segment already routed** + **8 per crossing**. Cap 6 bends. If no route is
   found, fall back to a 3-segment orthogonal route between the ports (never fails).
5. **Nudge.** Collinear runs of different lines in one channel (same x or y within 1, spans overlapping) are spread
   **8 apart** around the channel. They are ordered by where their lines come from and go to, so the spreading adds no
   crossing (libavoid's idea). If spreading would push a run into an inflated box, use 4 apart.
6. **Labels.** Candidates along the line: 28 units after the source stub, then the middle of each run, longest
   horizontal run first. The label box is centred on the line, so a label rides its own line. Take the first candidate
   whose box (inflated 2) touches no tile, no label already placed, and **no other line**. If none is clear, take the
   one touching least (tiles first). The label's text is unchanged: share and tag, or the handoff label.
7. **Incremental use.** With `only` (the lines of tiles being dragged) and `previous`: route just those lines, re-spread
   ports only on the sides they touch, and keep every other route as it was. On drop, route everything again.

Crossings are right angles by construction (every run is horizontal or vertical).

### 5.4 Wiring it into the canvas (`process-canvas.tsx`)

- **Handles.** Every tile gets four `source` and four `target` handles with ids `l`, `r`, `t`, `b`, at the side centres.
  Use `connectionMode={ConnectionMode.Loose}`, so in the Editor a connection can be drawn from any side. `isValidConnection`
  is unchanged. On read-only maps the handles are `opacity-0 pointer-events-none` (today `!bg-line-2`, a visible grey
  dot). In the Editor they show on hover and focus.
- **Routes.** A `useMemo` in `Canvas` builds `RouteBox`es from the drawn nodes: absolute positions (`positionAbsolute` for
  children) and **measured** sizes, falling back to `CARD_SIZE`/`TERMINAL_SIZE`/`GROUP_CARD`, with open groups as
  `frame: true`. It calls `routeEdges`. While `dragging` is non-empty, call it with `only` = lines touching dragged
  tiles. On drop, route all. Hand each edge its `sourceHandle`/`targetHandle` = the chosen sides, so React Flow's reconnect
  anchors (Editor) sit on the right side. Put the route in the edge's `data.route` (or a context map keyed by id). **Never
  store sides or routes**: they are derived.
- **`BranchEdge`** draws `routePath(data.route)` with `BaseEdge`, and the label at `data.route.label`. It ignores React
  Flow's `sourceX…`/`getSmoothStepPath`, except as a fallback when `route` is missing (the first frame before
  measurement). The editing label keeps its zoom-independent scale through `Unscaled` (section 6.1). Removed-in-draft
  ghost lines and `rolled` lines are routed like the rest.
- **Looks** (tokens only; `raw-colours.test.ts` must pass):

  | Line | Stroke | Dash | Label |
  |---|---|---|---|
  | Branch (process map) | `var(--line-2)`, 1.5 | none | mono 11 px share and tag pill, `bg-panel`, on its own line |
  | Back line (`route.back`) | same | none | same; the route goes over or under the row, never through it |
  | Handoff (company map) | `var(--line-2)`, 1.5 | none | sans 11 px pill, max 9 rem, centred on the longest run |
  | To or from a closed group (`rolled`) | `var(--line-2)`, 1.5 | `2 4` (as today) | none |
  | New in draft / removed ghost / selected | as today | as today | as today |

  `data-back` goes on the edge's `<g>` for tests. Rework (`rework_rate`, `rework_to_step_id`) is a step field, not a line,
  and stays undrawn (out of scope).
- **Export.** `lib/export/map-image.ts` replaces its cubic (lines 234–270) with
  `routeEdges(boxesItAlreadyBuilds, edges)` and `routePath`, and draws labels at `route.label`. It keeps its
  card-size boxes (it has no DOM), so its sides and topology match the screen's.

### 5.5 Budget

`routeEdges` on Larkspur (19 boxes, 17 lines): **≤ 8 ms** full, **≤ 2 ms** with `only` = one tile's lines (vitest perf
tag, unthrottled, CI). A drag in the Editor and on the Overview keeps frames over 25 ms at or below the post-fix numbers
in 2.3 (perf harness, section 9.5).

---

## 6. Decisions: smoother animation (PR A, first)

Exact fixes, in `apps/web/src/components/process-canvas.tsx` unless named:

1. **Only the zoom readout follows the zoom.** Remove `const zoom = useStore(…)` from `Canvas`. Add
   `function LiveMapViewControls(props)`, which subscribes itself and renders `map-controls`' `MapViewControls` (after
   `claude/map-controls`; it was `ZoomControls`) with `zoom`, `canOut` and `canIn`. `zoomBy` reads `flow.getZoom()`. In
   `BranchEdge`, drop the top-level `useStore` and wrap the two editing label containers in
   `function Unscaled({ x, y, after, children })`, which subscribes and applies `scale(1/zoom)`. Copy from
   `docs/plans/map-ux/animation-experiment.diff` (give the handlers their React Flow types).
2. **Stable handlers.** Add `useStable(fn)` (a ref updated in an effect, plus a `useCallback` with no dependencies that
   calls `ref.current`). Pass every `<ReactFlow>` function prop through it: `onNodesChange`, `onEdgesChange`, `onConnect`,
   `isValidConnection`, `onReconnect`, `onNodeDoubleClick`, `onNodeContextMenu`, `onSelectionContextMenu`, `onMoveStart`,
   `onNodeClick`, `onPaneClick`. `onMoveEnd` is already a `useCallback`. Keep the `editable ? fn : undefined` switches.
3. **No remount on Expand.** `overview.tsx`: remove `key={[...expanded].sort().join("|")}`. The canvas must re-frame when
   the controlled `expanded` set changes from outside. Add an effect in `Canvas` on `expandedProp` identity that calls
   `requestFit()`. A per-card toggle already calls `setExpanded` and the owner's `onExpandedChange`, so make the toggle
   path call `requestFit()` too, as `toggleAllGroups` does. Keep the existing rule: a highlight never moves the view.
4. **Cache closed cards.** Extend the node cache to group nodes: `sameGroupNode(a, b)` compares type, selected,
   ariaLabel, position, measured, width and height, and `data` shallowly, with `roll` compared field by field (it's a new
   object each time).
5. **Playback without layout per frame** (`components/playback-layer.tsx`, `app/globals.css`). Draw tokens at `cx = cy = 0`
   and move each with `style.transform = translate(x px, y px)` (CSS transforms on SVG don't re-lay-out). Rewrite badge
   text at most every 100 ms (positions still every frame). Keep `.playback-tokens`'s own layer. Target: at 4×, playback
   p50 ≤ 20 ms on `/demo/overview`. If it isn't met, report the numbers and stop. Don't go further without asking.
6. **The Editor's drop** (cheap, optional in A): `useEngineModel` (in `editor-view.tsx`) memoises the model on a key of
   the bundle with `x`/`y` stripped, so a move doesn't rebuild and re-stringify the engine model. Measure the drop frame
   before and after. Keep it only if the longest frame drops.
7. Leave the animation durations as they are (zoom 150 ms, fit 200 ms). They were choppy because of dropped frames, not
   their length.

Done for A: the table in 2.3, re-measured on CI-like settings, at or better than the "After" column, with no failing map
tests.

---

## 7. Dragging: UI wiring (PR C)

- **New prop** on `ProcessCanvas`:
  `arrange?: { positions: ReadonlyMap<string, { x: number; y: number }>; draggable: (id: string) => boolean; onDrop: (moves: { id: string; x: number; y: number }[]) => void; status: ReactNode } | null`.
  With `arrange` and no `editor`:
  - `nodesDraggable` is true. Each node's `draggable` comes from `arrange.draggable(id)`. Ghosts don't occur read-only.
  - `elementsSelectable`, `nodesConnectable` and `edgesReconnectable` stay false.
  - `nodeDragThreshold={4}`.
  - The node position is `dragging.get(id) ?? arrange.positions.get(id) ?? stored`.
  - In `onNodesChange`, a `position` change with `dragging: false` calls `arrange.onDrop(moves)` instead of
    `editor.run(moveSteps)`.
  - `status` renders in the top bar, after the legend, `ml-auto`, with `data-arrange-status`. Remember `claude/map-controls`
    moved the zoom buttons onto the map.
  - In the swimlanes view, `arrange` is ignored (not draggable).
- **Hook** `apps/web/src/lib/map/use-arrange.ts` (client): `useArrange({ processId, mode, save })` returns `arrange` for
  the canvas. It holds the overlay map, the 600 ms debounce batch, the status, the last batch for Undo and Retry, and the
  refusal revert. `mode === "demo"` never calls `save`: its status is a fixed "Demo: moves aren't saved".
- **Server action** `apps/web/src/app/w/[slug]/arrange-actions.ts` (`"use server"`):
  `saveStepPositions(processId: string, positions: unknown)`. Validate with `isId` and the same shape and limits as the
  function, then `supabase.rpc("save_step_positions", { p_process, p_positions })`. Map 42501 → forbidden, 22023/55000 →
  refused, anything else → failed. Copy `history/actions.ts` (`signedIn`, the result union).
- **Process page** (`components/process-page.tsx:381`): `arrange` when `mode === "live"`, not `old`, `editHref` set (it is
  `canEdit && !archivedAt`, `workspace-process-page.tsx:97`) and `!useIsPhone()`. Demo: `mode === "demo"` and not a phone.
  Never for `share`/`play`.
- **Overview** (`components/overview/overview.tsx:532`): `arrange` when `mode === "live"` (that is `canEdit`), there's no
  `viewingMapVersion`, and not a phone. Demo as above. `processId` = the company process id (`company.process.id`, from
  `workspace-overview.tsx`). `draggable(id)` = the id is a top-level card (`processIds` and no `parent_step_id`).
  `onDrop` maps card id → holder step id and stored position. Extend `companyMap()` to return
  `holders: ReadonlyMap<processId, { stepId: string; x: number; y: number }>` and use the drawn-vs-stored delta (2.5).
- **Phones:** `useIsPhone()` false only. `e2e/phone.spec.ts` must still pass (no edit-named controls appear). The status
  text has no edit-like name.

---

## 8. Edge cases

- A publish lands between the drag and the save: the function locks `processes`, reads the **new** live (step ids are
  stable), and saves there. Saving to the version that just went live is what the person sees after a refresh.
- A step removed by that publish: the count doesn't match → 22023 → the tile goes back, "Couldn't save: refresh the page".
- The process is archived mid-session (55000), or the editor is demoted (42501): revert with the message.
- Two editors move the same tile: last write wins (no realtime on read-only pages). Accepted.
- Dropping a tile on another tile: allowed (no snapping or collision in scope). The router routes round both. The e2e
  overlap check runs only on the seeded layouts, not after a test drag.
- A huge drag off-screen: clamped to ±100,000 by the database; the panel-width refit carries on.
- Company map with a card open: only top-level cards drag; the saved position is stored + delta (2.5).
- The demo's company map has no stored part: overlay only.
- A step inside an open group dragged outside the box: allowed. It stays a child (relative position), and the box grows,
  as in the Editor.
- Undo after the draft moved the step meanwhile: the mirror rule applies to the undo too (it only follows untouched draft
  rows).
- Keyboard: tiles can't be moved by keyboard on read-only maps (out of scope). Tab order is unchanged (`flowOrder`; a move
  can change it only for unreachable steps).
- Routing: a line between two tiles that touch or overlap gets the fallback route. A self-loop (from = to) is never drawn
  (none exist; `connectionProblem` refuses them).

---

## 9. Tests

### 9.1 Database (`packages/db/test/save-step-positions.test.ts`, new; copy `company-map-editing.test.ts` and `role-matrix.test.ts` helpers)

- Owner, editor and agency admin save; member, viewer, a non-member and anon are refused (42501, same message whether or
  not the process exists). An API-token claim is refused (42501).
- Only `x`/`y` change on the live rows (compare `to_jsonb(row) - 'x' - 'y' - 'updated_at'` before and after). No row in
  `processes`, `process_revisions` or `issues` changes, and no new revision.
- Clamping: 1e9 is stored as 100000, and 12.345 as 12.3. Refused (22023): not an array, empty, 501 entries, a duplicate id,
  a bad uuid, a string number, an extra key, an id from another process, workspace, a draft-only step or a superseded
  revision.
- Archived → 55000. Never published → 55000.
- Draft mirror: an untouched draft row follows; a draft row moved in the draft keeps its own position; `mirrored` lists
  only the former.
- Company map: moving a holder works, and `child_process_id` is untouched.
- One `audit_log` row per call with the moves; none when nothing changed (same positions sent).
- Concurrency: a second connection holding `processes … for update` makes the call wait (statement timeout in the test).

### 9.2 Unit (`apps/web/test/routing.test.ts`, new)

On fixtures of Northbeam's and Larkspur's boxes (from `northbeamStepIds` and the fixtures), and the company map:

- Determinism (same input, same output).
- No point of any route inside an inflated non-frame box, except its own stubs.
- Every run axis-aligned.
- No two line ends within 10.
- No two lines collinear and overlapping for more than 8.
- Labels touch no tile, no label and no other line.
- Back lines (`back: true`) leave and enter on top or bottom.
- `only` routes only the named lines, and the others are `===` the previous routes.
- Perf, tagged `perf`: the budgets in 5.5.
- `map-image.test.ts`: the exported SVG's paths equal `routePath` of `routeEdges` on the export's boxes, and the labels sit
  at `route.label`.

### 9.3 E2E (`apps/web/e2e/map-nodes.spec.ts`, extended; it runs in `check`)

- Keep (a)–(d). The `hiddenConnections` comment changes: lines now end on any side of the tiles nearest their ends.
- **Clear Larkspur's `KNOWN_HIDDEN`** (delete the entry). If the router can't clear one, stop and ask. Don't add entries.
- Add **(e) readability** on every page in `PAGES` at both widths, using the sampling in `docs/plans/map-ux/lines.mjs`:
  - (e1) no two lines share a run longer than 8 map units (points of one within 2 units of the other);
  - (e2) no two line ends within 6 units;
  - (e3) no label overlaps another label;
  - (e4) no label lies on a line other than its own;
  - (e5) every line's path is axis-aligned apart from corner arcs: sampled direction changes happen only within the
    corner radius.

  On `main` today, Northbeam fails e1 (8 pairs), e2 (8) and e3 (4).
- **(f) crossings, a budget not a ban:** count crossings per page, record them in a `MAX_CROSSINGS` table (initial values
  = what the new router gives, rounded up), and fail if a later change raises one.
- New `apps/web/e2e/map-arrange.spec.ts` (demo):
  - `/demo/overview` at 1280: drag a card 120 px right. It moves, and its lines follow (the line end stays on the card's
    border). The status reads "Demo: moves aren't saved". Run (d) and (e) after the move.
  - The same on `/demo/p/…`: a click without moving still opens the step's detail.
  - At 400 px: a card can't be dragged (the transform is unchanged after a drag), and no status appears.
  - `/demo/issues/1` and the share/play stories: tiles never draggable.

### 9.4 Browser harness (`apps/web/test/map-browser.test.ts` and `test/map-harness/entry.tsx`)

- Add an `arrange` option to the harness. A drag calls `onDrop` once per drop with the stored-coordinate delta. A drag
  doesn't change the viewport (`handZoomed` untouched). `nodeDragThreshold` stops a 2 px wobble from moving a tile.
- Render counts: in the harness, wrap `StepNode` and `BranchEdge` with a counter (test-only `window.__renders`). Assert a
  zoom animation re-renders no node or edge, and a drag re-renders only the dragged tile and its own lines. This guards
  root causes 1 and 2 against regressions.

### 9.5 Performance harness (kept out of CI)

Commit `apps/web/scripts/map-perf.mjs`, which merges `docs/plans/map-ux/perf2.mjs` and `renders.mjs` (frame stats at 4×, render
counts with the stand-in DevTools hook). Put the before/after table in each PR description.

### 9.6 Visual baselines

Lines and handles change every map story (`stories/map/process-canvas.stories.tsx`: ReadOnly, GroupsOpen, Highlight,
CompanyMap, Editable, and the map-controls stories). Run `build-storybook`, then `visual:update` and `visual` twice
locally, push, and approve with an empty commit "Approve visual changes [visual-update]" (`docs/visual-regression.md`).
Prune baselines this change doesn't move, as #245 did.

---

## 10. Out of scope

- Moving tiles in the Editor differently (the Editor keeps draft saves, undo and arrow keys; it gains routed lines and
  four-side handles).
- Snapping, alignment guides, auto-layout, collision resolution, multi-select drag on read-only maps.
- Drawing rework (`rework_to_step_id`) as a line.
- Per-user layouts, or a layout in share and play snapshots (they stay frozen).
- Dragging inside open cards on the Overview.
- Realtime position updates to other viewers of a live page.
- MCP tools for positions.

## 11. Sequencing against `claude/map-controls`

`claude/map-controls` (3 commits, `01877adc..2f13effc`) touches `process-canvas.tsx` (+99/−20: `height="tall"`,
`MapViewControls` moved onto the map, full screen, `fitPadding(…, controls)`, `fitViewport(…, { middle })`, the foot-bar
`ResizeObserver`), `map-controls.tsx`, `overview.tsx` (`height="tall"`), `lib/map/zoom.ts`, a new
`e2e/map-controls.spec.ts`, and the map stories and baselines.

- **Do not start until its PR is merged.** Then `git merge origin/main` (or branch from it) before step 1.
- Fix 6.1 applies to **its** `MapViewControls` call (it passes `zoom` from `Canvas`): move that subscription into
  `LiveMapViewControls`. Keep its full-screen and foot-height logic as it is.
- Fix 6.3 (no remount on Expand) must keep its `height="tall"` centred framing (`middle`). Re-run `e2e/map-controls.spec.ts`.
- The arrange status goes in the top bar (`legend` row), which still exists after map-controls; the zoom buttons don't.
- Order: **PR A** (animation; no visual change, so no baselines move) → **PR B** (router; baselines
  move once) → **PR C** (drag and migration row 73; small baseline change for the status slot only if it renders in
  stories). PR C's migration follows the production steps in 4.4 before merge.

## 12. Defaults taken (Austin isn't asked; each is reversible)

1. Members and viewers can't drag (3.1); the demo drags with a "not saved" label.
2. Moves save in place on the live version, with no new version, for owners, editors and agency admins (D50).
3. An open draft's untouched copy of a moved step follows the move; a draft that moved it keeps its own (4.3).
4. Overview: only top-level cards drag; tiles inside open cards don't.
5. One audit row per save batch, `action = 'arrange'`, not shown in the company change log.
6. Save 600 ms after the last drop; one level of Undo; a refusal puts the tile back.
7. Own router rather than elkjs or libavoid-js (licence, size, beta, wrong tool).
8. Back lines run over or under their row on the top or bottom sides; same stroke as other lines, no dash.
9. Handles on all four sides; in the Editor, connections can start from any side (`ConnectionMode.Loose`).
10. Animation durations unchanged.
11. Limits: 500 positions per call, ±100,000, 0.1 precision.

**Genuinely Austin's call (flag in the issue; build with the default meanwhile):** whether editors rearranging the **live**
map without a publish (default 2) is acceptable. It is the first in-place change to a published version. It is what he
asked for ("move nodes in that view"), and positions don't touch any number, so it was taken as the default.

## 13. Done criteria

- PR A: the 2.3 "After" numbers or better, re-measured, in the PR. The harness render-count tests pass. No visual change.
- PR B:
  - Every map draws routed, self-attaching lines (process page, Overview, Editor, issue page, solution compare, processes
    list, share and play, and the PNG/SVG export).
  - e2e (a)–(f) pass at 1280 and 400 with Larkspur's `KNOWN_HIDDEN` gone.
  - Connecting and reconnecting in the Editor still work (existing editor tests plus one new: connect from a tile's top
    handle).
  - Routing budgets met. Baselines approved.
- PR C:
  - An owner, editor or agency admin drags a tile on the live process page or the Overview company map. It's saved, the
    status shows "Saved · Undo", and Undo works.
  - A member or viewer, a phone, share and play links, and history versions can't drag. The demo drags with its label.
  - DB tests pass. Migration row 73 is applied with preflight, post-apply and the rolled-back smoke test, logged and
    pushed.
  - D50 and ADR 0018 are written.
- `pnpm lint && pnpm typecheck && pnpm test` and e2e green; CI `check` and `visual` green. The issue gets a comment per PR.

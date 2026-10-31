# P4: step base values in the editor and the process file

Read `docs/plans/capacity/README.md` first. Branch `claude/cap-p4-editor`, from `claude/relaxed-babbage-51ysen`.
Migration versions `20270120000000`–`20270120009999`.

Sources:
- the P4 row of `docs/plans/client-build-handover.md`;
- requirements section 7 and D6, D7, D32;
- `docs/adr/0022-capacity-inputs.md`, for the engine fields (merged; engine 1.16.0 reads them);
- the prototype's **Processes** and **process page** screens (`pageProcesses` and `pageProcess` in
  `docs/prototypes/client-capacity-app.PROTOTYPE.html`): the step inspector with time, how often, tier multiplier,
  who, source, work split sliders with a line per part, and the split bar on each node.

## The short version

A step carries its base values in the database, the editor, the process file and the engine model:
- a work split (automatable / augmentable / manual, with a one-line description of each part);
- a tier multiplier per tier;
- "goes to the client's manager";
- a source label per value.

A servicing link's recurrence can follow a tier deliverable ("per 1,000 words"). **With none of this entered,
`toEngineModel` gives exactly today's model**, so goldens and db snapshots don't move.

P1 is building Set up in parallel; it adds `tiers`, `departments` and tier deliverables on `services`. Don't touch
its tables or screens. Where you need the workspace's tier keys, read them through a small loader that returns
`["T1","T2","T3"]` when P1's `tiers` table doesn't exist yet. The orchestrator swaps this for P1's loader on merge.

## 1. Database (`20270120000000_step_base_values.sql`)

Additive only, with full rollback in the header.

**Columns on `steps`:**
- `split jsonb null`: `{automatable, augmentable, manual}` shares that sum to 1, checked to ±0.001.
- `split_notes jsonb null`: `{automatable, augmentable, manual}`, one line of text each.
- `tier_multiplier jsonb null`: `{tierKey: number >= 0}`.
- `to_client_manager boolean not null default false`.
- **No new source column.** Steps already have `provenance jsonb`. Store the source labels there as
  `{work|split|tier_multiplier: {source, at, by}}`, with `source` in `interview | calculator | measured | estimate`
  next to the existing provenance kinds. Check how `provenance` is used today and extend it rather than add a column.

**Driver recurrences:**
- Extend `private.is_recurrence` so `service_servicing.recurrence` also accepts
  `{"perMonth": n, "driver": "words"|"links"|"techHours"|"meetings"|"builds"|"creativeSets"|"channels"|"adhoc",
  "per": n?}`.
- Every existing recurrence stays valid.

**Saving and copying:**
- Every place a step row is copied must carry the new columns: draft and publish, revisions, solutions (copied maps),
  the block library, the process import and export bundles, and the workspace bundle.
- Find them with `grep` on an existing step column, e.g. `rework_to_step_id`.

Run `gen:types` and `gen:seed`. `copy-from-supabase.test.ts` must pass.

## 2. `toEngineModel` (`packages/db/src/model.ts`)

| Step data | Engine field |
|---|---|
| `split` | `EngineStep.split` |
| `tier_multiplier` | `EngineStep.tierMultiplier` |
| `to_client_manager` | `EngineStep.toClientManager` |
| source labels | `EngineStep.sources` |

- A driver recurrence maps to the engine's `{perMonth, driver, per}`.
- Leave the field undefined when the column is null or false. Never set an empty object.
- Add a test that every seed and fixture model is deep-equal to before (P1 adds a snapshot test like this; write your
  own if theirs isn't merged yet).

## 3. The process file `transpera-process/2`

- The step gains optional `split`, `split_notes`, `tier_multiplier`, `to_client_manager` and `sources`, with the same
  meanings. The servicing link gains the driver recurrence.
- Update the schema (`process-file-2-schema.ts`), the parser and validator with plain-English problems, the importer,
  the exporter if there is one, `docs/import/transpera-process-2.*` and the example files.
- A file without the fields imports exactly as before.
- **Update the skill** `.agents/skills/process-file/SKILL.md`: tell it to capture the split as gather / judge / check
  from interviews (section 7's table is the model), tier multipliers when the interviews say a tier takes longer, and
  a source per value.

## 4. Editor step inspector (`components/editor/inspector.tsx`, `components/step-inspector.tsx`)

Copy the prototype's inspector layout and wording.

**Time per occurrence:** as today.

**How often**, for a step in a servicing process:
- show the link's recurrence, in words, for each tier;
- for a driver, "From the tier (words ÷ 1,000), T1 4 · T2 1.5 · T3 1", reading the tier values when P1's columns
  exist, else "Set in Tiers & clients";
- edit the recurrence (fixed, ad hoc, or from a tier value) where the editor already edits servicing links. If it
  edits none today, show it read-only and say where it's edited.

**Tier multiplier on time:** one number per tier, default 1.

**Who:** add "The client's manager" to the who-picker beside a role or a pinned person. It sets `to_client_manager`
and keeps the role as the fallback.

**Source and confidence:** a select per value (Interview / Calculator / Measured / Estimate), shown as a small pill.

**Work split:**
- three sliders in steps of 5%, kept summing to 100% (moving one takes from the others in the prototype's way);
- a text line under each part;
- a stacked bar using the prototype's colours (`--auto`, `--aug`, `--man`; add them as theme tokens in light and
  dark);
- a "Clear split" action.

**On the map:** each step node with a split shows the small split bar, as the prototype's nodes do. A step without one
shows nothing new.

Leave out the prototype's **"Changes that act on this step"** block and the **"Show future state with"** select.
Changes are stored by the Sandbox (P7). Leave a clearly marked slot.

Viewers see everything read-only. Owner and Agency admins edit (D18); match the editor's existing role rule.

## 5. Missing for simulation

`packages/db/src/simulation-gaps.ts`:
- list working steps of servicing processes **with no split**, and steps with a value and no source, as **notes**
  (not blockers);
- add the engine's `capacityProblems(model)` (exported by `@transpera-flow/engine`) as blockers.

Show both where missing-for-simulation shows today.

## Tests

- **DB:** constraints, recurrence validation old and new, a copy and publish round-trip carrying the new columns,
  bundle round-trip.
- **Model:** the mapping for each field, and the seeds unchanged.
- **Process file:** parse, validate and import each new field; old files unchanged; bad split and bad driver problems
  in plain English.
- **Web:** inspector edits each field and saves; the split sliders stay at 100%; read-only for Viewers; the split bar
  on the node.

## Out of scope

- Storing changes, and the Sandbox (P7).
- Tier deliverables and the Set up screens (P1).
- The Capacity page (P5).

## Done when

- `pnpm lint && pnpm typecheck && pnpm test` and the web build pass. If the machine is loaded, run the db and web
  suites for the files you touched, plus `copy-from-supabase`, and say so.
- Goldens unchanged.
- The report lists every place a step row is copied, and confirms each carries the new columns.

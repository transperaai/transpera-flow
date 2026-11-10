-- A step's rework rate is at most 95% (security review: a rework rate of 1 sends every item back for ever).
--
-- `steps.rework_rate` allowed 0 to 1. At 1 every visit is sent back, so an item never leaves the step and a run spins until its time
-- cap. The engine now caps the rate at 0.95 too (packages/engine, packages/db/src/model.ts and process-file.ts); this makes the
-- stored value agree.
--
-- What it does:
--   1. Clamps every `steps.rework_rate` above 0.95 to 0.95, in every version (live, drafts and history), so the tighter check can be
--      added. `refuse_archived_rows` (which refuses any write to an archived process's steps, even the owner's) and `set_updated_at`
--      are disabled for this one statement, so archived processes are clamped too and no row looks edited by someone. No audit entry
--      is written (`audit_mcp` logs MCP token writes only; `edit_drafts_only` lets the owner through).
--   2. Replaces `steps_rework_rate_check` (0 to 1) with the same name, 0 to 0.95.
--   Not changed: solutions' and blocks' jsonb copies and saved scenario patches keep what they hold; the engine caps them when it
--   builds a model. A workspace backup restored after this has its steps' rates clamped by the restore plan
--   (packages/db/src/workspace-import.ts), which says so in its warnings.
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270203000200';` expect 0, and 20270203000100 applied.
--     `select count(*) from public.steps where rework_rate > 0.95;` the rows this clamps (expect a handful at most).
--     Locks: ACCESS EXCLUSIVE on `steps` for the trigger changes and the constraint (the check validates every row), held to commit.
-- Post-apply checks: select count(*) from public.steps where rework_rate > 0.95; expect 0.
--     select pg_get_constraintdef(oid) from pg_constraint where conname = 'steps_rework_rate_check'; expect '... <= 0.95'.
--
-- ROLLBACK (run as one transaction; the clamped values are not restored):
--
--   begin;
--   alter table public.steps drop constraint steps_rework_rate_check;
--   alter table public.steps add constraint steps_rework_rate_check check (rework_rate >= 0 and rework_rate <= 1);
--   delete from public.schema_migrations where version = '20270203000200';
--   commit;

select set_config('transpera.actor_kind', 'system', true);

alter table public.steps disable trigger refuse_archived_rows;
alter table public.steps disable trigger set_updated_at;
update public.steps set rework_rate = 0.95 where rework_rate > 0.95;
alter table public.steps enable trigger set_updated_at;
alter table public.steps enable trigger refuse_archived_rows;

alter table public.steps drop constraint steps_rework_rate_check;
alter table public.steps add constraint steps_rework_rate_check check (rework_rate >= 0 and rework_rate <= 0.95);

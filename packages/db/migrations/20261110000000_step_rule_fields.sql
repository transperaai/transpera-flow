-- Step fields for the new analysis rules (docs/analysis-rules.md rules 5, 12 and
-- 13; issue #107, A42). Four optional numbers on `public.steps`, each saved on
-- its own like every other step field, so a draft carries them and publishing
-- one copies them (open_draft copies every column):
--
--   * `expected_wait_hours`: how long an item may queue for a person before it
--     counts as waiting too long (rule 5, "Waiting too long"). Null: the
--     workspace's default for the step's kind (1 working day for pipeline
--     steps, 2 for servicing steps).
--   * `lost_per_day_waiting`: the share of items that go cold for each working
--     day they wait here, 0 to 1 (0.05 is 5% a day). Prices the cost of
--     waiting (A43). Null: no loss is assumed, so the insight shows time, not
--     money.
--   * `dropoff_benchmark`: the share of the items leaving the step that may be
--     lost here and still be fine, 0 to 1 (rule 12, "Work lost at a step").
--     Null: the rule doesn't rate this step.
--   * `target_cycle_hours`: how long an item should take end to end, in
--     working hours (rule 13, "Too slow overall"). Set on the process's
--     `start` step, the one place that is once per process and travels with
--     its revision; ignored on any other step. Null: the rule doesn't rate
--     this process.
--
-- Strictly additive: four nullable columns with check constraints, no default,
-- no data change. `save_fields` is unchanged: `steps` is already in its
-- allow-list and it accepts any column the stored row has.
--
-- Preflight (run each with `bash packages/db/scripts/prod-sql.sh -c "..."`):
--
--   1. The columns must not exist yet. Expect 0 rows:
--        select column_name from information_schema.columns
--        where table_schema = 'public' and table_name = 'steps'
--          and column_name in ('expected_wait_hours', 'lost_per_day_waiting', 'dropoff_benchmark', 'target_cycle_hours');
--   2. Nothing is applied at or past this version yet. Expect no rows:
--        select version from supabase_migrations.schema_migrations where version >= '20261110000000';
--
-- Rollback (run as one transaction):
--
--   begin;
--   alter table public.steps
--     drop column expected_wait_hours,
--     drop column lost_per_day_waiting,
--     drop column dropoff_benchmark,
--     drop column target_cycle_hours;
--   delete from supabase_migrations.schema_migrations where version = '20261110000000';
--   commit;
--
-- Rolling back loses the values people entered in these fields; the rules fall
-- back to their defaults. Production data: none needed.

alter table public.steps
  add column expected_wait_hours numeric
    constraint steps_expected_wait_hours check (expected_wait_hours >= 0 and expected_wait_hours <= 10000),
  add column lost_per_day_waiting numeric
    constraint steps_lost_per_day_waiting check (lost_per_day_waiting >= 0 and lost_per_day_waiting <= 1),
  add column dropoff_benchmark numeric
    constraint steps_dropoff_benchmark check (dropoff_benchmark >= 0 and dropoff_benchmark <= 1),
  add column target_cycle_hours numeric
    constraint steps_target_cycle_hours check (target_cycle_hours > 0 and target_cycle_hours <= 100000);

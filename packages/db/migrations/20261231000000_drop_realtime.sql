-- Live editing removed (docs/plans/rework-direction.md decision 6; docs/adr/0005 superseded): drop what
-- 20261007000000_realtime.sql added, so nothing in our schema refers to Realtime any more.
--
-- 1. steps, edges and processes leave the `supabase_realtime` publication.
-- 2. The two policies on realtime.messages go.
-- 3. private.process_topic(text), which only those policies used, goes.
--
-- Everything is guarded, so it applies on Supabase (the publication and realtime.messages are real), on plain
-- Postgres and on Neon with packages/db/sql/legacy-shims.sql (stand-ins), and again without effect. The shim
-- itself stays: older migrations still need it.
--
-- Rollback: re-run the body of 20261007000000_realtime.sql.

do $$
declare
  t text;
begin
  -- A FOR ALL TABLES publication (someone switched Realtime on for everything) lists every table and refuses `drop table`;
  -- nothing of ours was added to it, so it is left alone.
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    foreach t in array array['steps', 'edges', 'processes'] loop
      if exists (
        select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime drop table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    drop policy if exists "join process channels" on realtime.messages;
    drop policy if exists "use process channels" on realtime.messages;
  end if;
end;
$$;

drop function if exists private.process_topic(text);

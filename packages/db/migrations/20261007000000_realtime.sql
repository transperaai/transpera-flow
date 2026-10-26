-- Presence and live changes in the process editor (issue #10; docs/PRD.md
-- §4.1, decision D14; docs/adr/0005-realtime-presence-and-live-changes.md).
--
-- 1. Postgres Changes: steps, edges and processes join the
--    `supabase_realtime` publication, so an editor hears about rows other
--    people (or the MCP server, acting as them) save. Supabase checks each
--    change against the listener's RLS select policies before sending it.
--    `processes` is there for its live_revision_id / draft_revision_id, which
--    change when a draft is opened, published or discarded.
-- 2. Realtime Authorization: the editor's presence channel `process:<uuid>` is
--    private. These policies on realtime.messages let people who can read the
--    process's workspace join it and track presence, and people who can edit
--    it send broadcasts (the "who saved what" notes that name the author).
--
-- Both parts only exist on Supabase: on plain Postgres (the test database)
-- there is no `supabase_realtime` publication and no `realtime` schema, and
-- this migration does nothing. Replica identity stays default: updates carry
-- the whole new row, and deletes carry the primary key, (revision_id, id) for
-- steps and edges, which is all the editor needs.
--
-- Strictly additive.
--
-- Rollback:
--   do $$ begin
--     if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
--       alter publication supabase_realtime drop table public.steps, public.edges, public.processes;
--     end if;
--     if to_regclass('realtime.messages') is not null then
--       drop policy if exists "join process channels" on realtime.messages;
--       drop policy if exists "use process channels" on realtime.messages;
--     end if;
--   end $$;
--   drop function if exists private.process_topic(text);
--   delete from supabase_migrations.schema_migrations where version = '20261007000000';

do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['steps', 'edges', 'processes'] loop
      -- Someone may have switched Realtime on for a table in the dashboard already.
      if not exists (
        select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

-- The process a `process:<uuid>` topic names, or null for any other topic.
create function private.process_topic(topic text) returns uuid
language sql immutable
set search_path = ''
as $$
  select (regexp_match(topic, '^process:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'))[1]::uuid;
$$;

revoke all on function private.process_topic(text) from public;
grant execute on function private.process_topic(text) to authenticated;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    -- Receive presence and broadcasts on a process's channel: anyone who can read the process.
    create policy "join process channels" on realtime.messages for select to authenticated
    using (
      realtime.messages.extension in ('presence', 'broadcast')
      and exists (
        select 1 from public.processes p
        where p.id = private.process_topic((select realtime.topic()))
          and public.can_read_workspace(p.workspace_id)
      )
    );
    -- Track presence: anyone who can read it. Send broadcasts (save notes): editors only.
    create policy "use process channels" on realtime.messages for insert to authenticated
    with check (
      exists (
        select 1 from public.processes p
        where p.id = private.process_topic((select realtime.topic()))
          and case realtime.messages.extension
            when 'presence' then public.can_read_workspace(p.workspace_id)
            when 'broadcast' then public.can_edit_workspace(p.workspace_id)
            else false
          end
      )
    );
  end if;
end;
$$;

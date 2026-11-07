-- The company map drives the run (Q17, decision D51, ADR 0023): the processes on a company map version are what is simulated, and its hand-off
-- lines route work between them. A live map a person already changed before Q17 (a card taken off, a line drawn) would move a run nobody touched,
-- so the live map drives the run only once a person publishes a company map version after this migration.
--
-- What it does:
--   * `processes.map_drives_run boolean not null default true`, meaningful on company map rows only (every other row keeps the default and nothing
--     reads it).
--   * Backfill: `false` for each company map that has any version a person published (`published_by` not null: a publish or a restore). A map the
--     system alone has made (published_by null on every version) keeps `true`: its map run is today's run anyway.
--   * A trigger on `process_revisions`: when a company map version is published with `published_by` not null (a person's publish, a person's
--     restore included), its process's `map_drives_run` becomes true. A system-made version (published_by null) leaves it alone. It is never set
--     back to false.
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270134000000';` expect 0.
-- ROLLBACK: `drop trigger map_drives_run_on_publish on public.process_revisions; drop function private.map_drives_run_on_publish();
--            alter table public.processes drop column map_drives_run; delete from public.schema_migrations where version = '20270134000000';`

alter table public.processes add column map_drives_run boolean not null default true;

update public.processes p
   set map_drives_run = false
 where p.is_company
   and exists (select 1 from public.process_revisions r where r.process_id = p.id and r.published_by is not null);

create or replace function private.map_drives_run_on_publish() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and new.published_by is not null then
    update public.processes p
       set map_drives_run = true
     where p.id = new.process_id and p.is_company and not p.map_drives_run;
  end if;
  return new;
end;
$$;

create trigger map_drives_run_on_publish after insert or update of status, published_by on public.process_revisions
  for each row execute function private.map_drives_run_on_publish();

revoke all on function private.map_drives_run_on_publish() from public, anon, authenticated;

-- Audit every write the MCP server makes (issue #24; docs/PRD.md §7.1, §7.1c
-- "All changes are audit-logged with actor_kind", decision D18).
--
-- The MCP endpoint acts as the token's user through the PostgREST pre-request
-- hook (docs/adr/0002-mcp-acts-as-user-via-pre-request.md), whose claims carry
-- `api_token_id`. Opening, publishing and discarding drafts are already logged
-- by `public.audit_revision_change` (with actor_kind 'mcp' for such requests).
-- This adds the row writes the process-building tools (and the analysis tools)
-- make: steps, edges, processes, sources, scenarios and issues. One entry per
-- row inserted, updated or deleted, only for requests made with an API token,
-- so the canvas, the seed and migrations are unaffected. Rows written by other
-- triggers (cascades, perception-gap issues) and the copy open_draft makes
-- are covered by the entry for what caused them. Updates record just
-- the columns that changed; an update that changes nothing but `updated_at`
-- (or, on processes, only the draft/live pointers, which the revision audit
-- already covers) is not logged.
--
-- Strictly additive: one private security-definer trigger function and six
-- triggers. No table, column, policy or save_fields change.
--
-- Rollback:
--   drop trigger if exists audit_mcp on public.steps;
--   drop trigger if exists audit_mcp on public.edges;
--   drop trigger if exists audit_mcp on public.processes;
--   drop trigger if exists audit_mcp on public.sources;
--   drop trigger if exists audit_mcp on public.scenarios;
--   drop trigger if exists audit_mcp on public.issues;
--   drop function if exists private.audit_mcp_write();
--   delete from supabase_migrations.schema_migrations where version = '20261013000000';

create function private.audit_mcp_write() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
  row_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  row_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  target jsonb := coalesce(row_new, row_old);
  ignored text[] := array['updated_at'];
  changed_old jsonb;
  changed_new jsonb;
begin
  -- Only requests made with an API token (the MCP server) are logged here.
  if claims is null or not (claims ? 'api_token_id') then
    return null;
  end if;
  -- Writes made by other triggers (cascades from deleting a revision, the
  -- perception-gap issue a conflicting step logs) follow from the write that
  -- is logged, or from a revision change audit_revision_change logs.
  if pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;
  -- open_draft copying live into a draft it created in this transaction: the
  -- open_draft entry covers it.
  if tg_op = 'INSERT' and tg_table_name in ('steps', 'edges') and exists (
    select 1 from public.process_revisions r
    where r.id = (row_new ->> 'revision_id')::uuid and r.xmin = pg_catalog.pg_current_xact_id()::xid
  ) then
    return null;
  end if;
  if tg_table_name = 'processes' then
    ignored := ignored || array['live_revision_id', 'draft_revision_id'];
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, row_old -> n.key), jsonb_object_agg(n.key, n.value)
      into changed_old, changed_new
    from jsonb_each(row_new) n
    where not (n.key = any (ignored)) and (row_old -> n.key) is distinct from n.value;
    if changed_new is null then
      return null;
    end if;
    row_old := changed_old;
    row_new := changed_new;
  end if;

  insert into public.audit_log (workspace_id, actor_id, actor_kind, action, target_table, target_id, diff)
  values (
    (target ->> 'workspace_id')::uuid,
    auth.uid(),
    'mcp',
    lower(tg_op),
    tg_table_name,
    (target ->> 'id')::uuid,
    jsonb_strip_nulls(jsonb_build_object(
      'old', row_old,
      'new', row_new,
      -- Steps and edges are keyed by (revision_id, id): say which revision.
      'revision_id', target -> 'revision_id',
      'api_token_id', claims -> 'api_token_id')));
  return null;
end;
$$;

revoke all on function private.audit_mcp_write() from public, anon, authenticated;

create trigger audit_mcp after insert or update or delete on public.steps
  for each row execute function private.audit_mcp_write();
create trigger audit_mcp after insert or update or delete on public.edges
  for each row execute function private.audit_mcp_write();
create trigger audit_mcp after insert or update or delete on public.processes
  for each row execute function private.audit_mcp_write();
create trigger audit_mcp after insert or update or delete on public.sources
  for each row execute function private.audit_mcp_write();
create trigger audit_mcp after insert or update or delete on public.scenarios
  for each row execute function private.audit_mcp_write();
create trigger audit_mcp after insert or update or delete on public.issues
  for each row execute function private.audit_mcp_write();

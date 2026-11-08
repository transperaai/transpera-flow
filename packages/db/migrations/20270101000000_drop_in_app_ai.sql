-- Remove in-app AI and findings (docs/plans/cut-list.md items 1, 3 and 6; docs/plans/strip-briefs.md S1).
--
-- Austin, 27-28 Oct 2026: the app no longer calls a language model, and findings are gone (an issue is logged by a
-- person, by hand). Existing AI data is dropped completely: analyses, AI findings (accepted or not), AI runs,
-- narrations and the AI settings. Nothing is converted into issues.
--
-- Drops (tables first, so their triggers, policies, indexes and grants go with them; then the functions they used):
--   tables     public.findings, public.ai_analyses, public.ai_runs, public.ai_settings, public.narrations,
--              public.reports (PDF reports were removed in A32 and nothing reads or writes the table any more; its only
--              reader was `report_download`, and the report's narrated summary lived in `reports.content`)
--   functions  public.reserve_ai_run(uuid, uuid, text), public.report_download(text),
--              private.ai_analyses_stamp(), private.findings_before_write()
-- Changed:
--   public.agency_workspace_list()  no longer counts `findings` toward a workspace's last activity (same signature,
--                                   same grants; `create or replace` keeps them)
-- Kept on purpose:
--   public.robustness_results (the cache of robustness jobs; not AI)
--   issues.detected_key and source_links.insight_key values like `finding:<origin>:<id>` or `ai:insight:<hash>` stay as
--   plain text on the issues that were acknowledged from a finding; nothing reads them as a finding any more.
--   The AI-related workspace settings: `workspaces.settings` holds only hours_per_week, currency and horizon_weeks, and
--   the five AI switches lived in `ai_settings`, so there is no settings key left to remove.
--
-- Foreign keys between the dropped tables (findings -> ai_analyses -> ai_runs, findings -> ai_runs) are all inside
-- this set, and no other table references any of them (checked against pg_constraint), so `cascade` only removes
-- the dropped tables' own dependants. Nothing else depends on the functions (checked against pg_proc bodies:
-- only `agency_workspace_list` read `findings`).
--
-- Rolling back means restoring the tables from 20261020000000_narration.sql, 20261121000000_ai_analysis.sql,
-- 20261205000000_analysis_findings.sql, 20261207500000/700000 and 20261212000000_connector_findings.sql, and 20261019000000_reports.sql;
-- the rows are not recoverable from here (take a database copy before applying).

create or replace function public.agency_workspace_list() returns table (
  id uuid,
  name text,
  slug text,
  open_risk_issues bigint,
  last_activity timestamptz,
  numbers jsonb,
  computed_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    w.id,
    w.name,
    w.slug,
    (select count(*) from public.issues i
      where i.workspace_id = w.id and i.severity = 'critical' and i.status in ('open', 'in_progress')),
    -- greatest() ignores nulls; null only when the workspace has no activity at all.
    greatest(
      (select max(greatest(r.updated_at, r.created_at)) from public.process_revisions r where r.workspace_id = w.id),
      (select max(greatest(i.updated_at, i.created_at)) from public.issues i where i.workspace_id = w.id),
      (select max(greatest(s.updated_at, s.created_at)) from public.sources s where s.workspace_id = w.id),
      (select max(greatest(o.updated_at, o.created_at)) from public.solutions o where o.workspace_id = w.id),
      (select max(a.created_at) from public.audit_log a where a.workspace_id = w.id)
    ),
    h.numbers,
    h.computed_at
  from public.workspaces w
  left join public.workspace_headlines h on h.workspace_id = w.id
  where public.can_read_workspace(w.id)
  order by w.name, w.id;
$$;

drop table if exists public.findings cascade;
drop table if exists public.ai_analyses cascade;
drop table if exists public.ai_runs cascade;
drop table if exists public.ai_settings cascade;
drop table if exists public.narrations cascade;
drop table if exists public.reports cascade;

drop function if exists public.reserve_ai_run(uuid, uuid, text);
drop function if exists public.report_download(text);
drop function if exists private.ai_analyses_stamp();
drop function if exists private.findings_before_write();

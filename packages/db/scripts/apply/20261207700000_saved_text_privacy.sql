-- Production apply file for 20261207700000_saved_text_privacy (B1 part 2 of 3, slice 2b, issue #30). Two new columns
-- (`ai_analyses.person_labels`, `findings.person_labels`), a one-off clean-up of saved text (overtime issues lose the money clause
-- and `overtime_cost`; AI analyses and AI findings get "Team member N" labels where full names were, with the labels written to
-- `person_labels`), and three temporary helper functions that are dropped again; applies after row 55 (20261207500000, B1 2a);
-- this is row 56. Preflight, post-apply checks and rollback are in the migration's own header, repeated below. Apply BEFORE
-- deploying the app (the app selects `person_labels`), and deploy straight after. Sets `lock_timeout` to 5 s: each
-- `disable trigger` takes a brief lock on its table.

begin;
set local lock_timeout = '5s';

-- Saved text carries no pay and no real names (issue #30, B1 part 2 of 3, slice 2b; docs/plans/b1-brief.md).
--
-- The review of slice 2a (#202) found two leaks that no screen change can fix, because both sit in rows every member reads:
--
--   1. SAVED OVERTIME ISSUES HOLD PAY. The engine's overtime issue said "...h/wk overtime on average within the 10% cap,
--      costing about £1,234 at cost rates over the 26-week run." and saved the same money as `evidence_metrics.overtime_cost`.
--      With the hours in the same sentence, a member divides one by the other and gets a person's rate. Austin, 6 Oct:
--      members and viewers get no pay data. (Engine 1.8.0 states hours only and the app strips the clause on save; this
--      migration cleans the rows already saved.)
--   2. SAVED AI TEXT HOLDS REAL NAMES. AI analysis is sent labels ("Team member A"), but the app put the real names back
--      before saving, so `ai_analyses` and `findings` named people to every member. Austin's Q2: members see their own name
--      and "A team member" for everyone else. From now on AI text is saved as the model wrote it, with labels, and a
--      `person_labels` map (label -> person id) beside it; names go back at render, per reader. This migration relabels
--      what is already saved.
--
-- What changes:
--   * Two columns: `ai_analyses.person_labels` and `findings.person_labels` (jsonb object, not null, default '{}', at most
--     32 KB). Both tables have table-level grants, so the new columns need none. No policy, grant or trigger is created, no
--     existing function is redefined, and `save_fields` is not touched.
--   * `issues` whose `detected_key` starts 'overtime:' lose the clause ", costing about ... at cost rates over the N-week
--     run." (it becomes ".") and the `overtime_cost` metric. History and updated_at stay as they were: it is a clean-up, not
--     an edit (the `issue_log` and `set_updated_at` triggers are switched off for the statement, then back on).
--   * `ai_analyses` (summary, insights, review, reason) and AI `findings` (title, evidence, why, facts): every FULL NAME of a
--     person in the row's workspace, as written (case-sensitive) and not inside a longer word, becomes 'Team member ' || n,
--     where n ranks the workspace's people by (created_at, id): the same numbering as `team_capacity`. The labels used are
--     written to `person_labels`. The money clause is cut from facts and pre-B17 insights too (a fact quoted the overtime
--     evidence). `findings_before_write` and `ai_analyses_stamp` (which forbid changing an AI finding's facts and require a
--     reserved run) and `set_updated_at` are switched off for those statements, then back on. Findings added by hand are
--     human-typed text and are not touched.
--   * Three helper functions are created in `private` and dropped again inside this migration.
--
-- ACCEPTED LIMITS:
--   * In rows written before this migration, a person named only by first name, a nickname or a misspelling keeps it (first
--     names in old rows mostly come from source quotes, which every member already reads; matching them would also catch
--     words like "May" or "Will"). Names under 3 characters, and names with a double quote or a backslash, are skipped.
--     Two people with the same name both match the lower-numbered label.
--   * Old AI text may QUOTE a pay-dependent cost the model was given ("overtime here costs about £1.2k a month"). Free text
--     can't be recognised reliably. Production has no members or viewers yet, so nobody can read it today. After applying,
--     re-run Analyse on each analysed process and the whole company (every stored analysis reads as out of date anyway, from
--     the prompt-version bump), and dismiss or edit any accepted AI finding that quotes overtime money.
--   * Analyses run between apply and deploy (old app) keep real names. Deploy straight after apply, then re-run post-apply
--     check 4.
--
-- Apply BEFORE deploying the app: the app selects `person_labels`.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`; with prod-sql.sh a `like` against a
-- function body needs `can''''t`, and `tgenabled` needs `::text`):
--   0. Row 55 the latest. Expect exactly 20261207000000 and 20261207500000 (nothing >= 20261207700000):
--        select version from supabase_migrations.schema_migrations where version >= '20261207000000' order by 1;
--   1. The columns don't exist yet. Expect 0:
--        select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name in ('ai_analyses', 'findings') and column_name = 'person_labels';
--   2. The six triggers this disables and re-enables exist and are enabled. Expect 6 rows, each O:
--        select tgrelid::regclass, tgname, tgenabled::text from pg_trigger
--        where not tgisinternal and (tgrelid, tgname) in (
--          ('public.issues'::regclass, 'issue_log'), ('public.issues'::regclass, 'set_updated_at'),
--          ('public.ai_analyses'::regclass, 'ai_analyses_stamp'), ('public.ai_analyses'::regclass, 'set_updated_at'),
--          ('public.findings'::regclass, 'findings_before_write'), ('public.findings'::regclass, 'set_updated_at'))
--        order by 1, 2;
--   3. The regex features work here (lookbehind, classes, shortest match). Expect 'x T y.' and 'a.':
--        select regexp_replace('x Ann Lee y.', '(?<![[:alnum:]_])Ann Lee(?![[:alnum:]_])', 'T', 'g'),
--               regexp_replace('a, costing about £1,234 at cost rates over the 26-week run.', ', costing about .+? at cost rates over the [0-9,]+-week run\.', '.', 'g');
--   4. For the log, and to compare after: what will change, the history size and the latest timestamps.
--        select count(*) filter (where evidence_metrics ? 'overtime_cost') as with_metric,
--               count(*) filter (where evidence ~ ', costing about .+ at cost rates over the [0-9,]+-week run\.') as with_sentence
--        from public.issues where detected_key like 'overtime:%';
--        select (select count(*) from public.issue_events) as issue_events,
--               (select count(*) from public.ai_analyses) as analyses, (select max(updated_at) from public.ai_analyses) as analyses_latest,
--               (select count(*) from public.findings where origin = 'ai') as ai_findings, (select max(updated_at) from public.findings) as findings_latest;
--   5. No saved AI text already holds a label (it would stay unmapped). Expect 0, 0:
--        select (select count(*) from public.ai_analyses where (summary::text || insights::text || review::text || coalesce(reason, '')) ~ 'Team member [A-Z0-9]'),
--               (select count(*) from public.findings where (title || evidence || why || facts::text) ~ 'Team member [A-Z0-9]');
--   6. Room for longer text. Expect each well under its limit (262144, 131072, 32768):
--        select max(octet_length(insights::text)), max(octet_length(review::text)) from public.ai_analyses;
--        select max(octet_length(facts::text)) from public.findings;
--   7. For the log: names the clean-up skips (under 3 characters, or a quote or backslash) and names two people share (both
--      get the lower-numbered label). Expect no rows from either:
--        select workspace_id, name from public.people where char_length(btrim(name)) < 3 or name ~ '["\\]';
--        select workspace_id, btrim(name), count(*) from public.people group by 1, 2 having count(*) > 1;
--
-- POST-APPLY CHECKS:
--   1. Re-run preflight 1: `2`. Re-run preflight 2: still 6 rows, all `O`.
--   2. select to_regprocedure('private.b1_2b_relabel(text, uuid)'), to_regprocedure('private.b1_2b_labels(text, uuid)'),
--             to_regprocedure('private.b1_2b_people(uuid)');   -- null, null, null
--   3. Re-run the first query of preflight 4: `0, 0`. The second: `issue_events` and both `max(updated_at)` unchanged.
--   4. No AI text still holds a full name of its workspace. Expect 0, 0:
--        select (select count(*) from public.ai_analyses a join public.people p on p.workspace_id = a.workspace_id
--                where char_length(btrim(p.name)) >= 3 and (a.summary::text || a.insights::text || a.review::text || coalesce(a.reason, ''))
--                      ~ ('(?<![[:alnum:]_])' || regexp_replace(btrim(p.name), '([.^$*+?(){}|\[\]\\-])', '\\\1', 'g') || '(?![[:alnum:]_])')),
--               (select count(*) from public.findings f join public.people p on p.workspace_id = f.workspace_id
--                where f.origin = 'ai' and char_length(btrim(p.name)) >= 3 and (f.title || f.evidence || f.why || f.facts::text)
--                      ~ ('(?<![[:alnum:]_])' || regexp_replace(btrim(p.name), '([.^$*+?(){}|\[\]\\-])', '\\\1', 'g') || '(?![[:alnum:]_])'));
--   5. For the log: select count(*) from public.ai_analyses where person_labels <> '{}';  and the same for public.findings.
--   6. The schema_migrations row is present.
--
-- ROLLBACK (one transaction; redeploy the app from before 2b first, since 2b's app selects the column). The overtime clause
-- and `overtime_cost` are NOT put back: the money is still shown live to editors, so nothing is lost.
--   begin;
--     -- Put names back where labels were written: each label in a row's person_labels becomes that person's current name,
--     -- or "A team member" if they were deleted. Inside jsonb the name is JSON-escaped.
--     create function private.b1_2b_unlabel(t text, labels jsonb, as_json boolean) returns text
--     language plpgsql stable set search_path = ''
--     as $f$
--     declare l record; nm text;
--     begin
--       if t is null then return null; end if;
--       for l in select k.label, k.pid from jsonb_each_text(labels) as k(label, pid) order by char_length(k.label) desc, k.label loop
--         select p.name into nm from public.people p where p.id = l.pid::uuid;
--         nm := coalesce(nm, 'A team member');
--         if as_json then nm := substr(to_jsonb(nm)::text, 2, char_length(to_jsonb(nm)::text) - 2); end if;
--         t := regexp_replace(t, l.label || '(?![[:alnum:]])', replace(replace(nm, '\', '\\'), '&', '\&'), 'g');
--       end loop;
--       return t;
--     end;
--     $f$;
--     alter table public.ai_analyses disable trigger ai_analyses_stamp;
--     alter table public.ai_analyses disable trigger set_updated_at;
--     update public.ai_analyses
--     set summary  = private.b1_2b_unlabel(summary::text, person_labels, true)::jsonb,
--         insights = private.b1_2b_unlabel(insights::text, person_labels, true)::jsonb,
--         review   = private.b1_2b_unlabel(review::text, person_labels, true)::jsonb,
--         reason   = left(private.b1_2b_unlabel(reason, person_labels, false), 2000)
--     where person_labels <> '{}';
--     alter table public.ai_analyses enable trigger set_updated_at;
--     alter table public.ai_analyses enable trigger ai_analyses_stamp;
--     alter table public.findings disable trigger findings_before_write;
--     alter table public.findings disable trigger set_updated_at;
--     update public.findings
--     set title    = left(private.b1_2b_unlabel(title, person_labels, false), 200),
--         evidence = left(private.b1_2b_unlabel(evidence, person_labels, false), 2000),
--         why      = left(private.b1_2b_unlabel(why, person_labels, false), 2000),
--         facts    = private.b1_2b_unlabel(facts::text, person_labels, true)::jsonb
--     where person_labels <> '{}';
--     alter table public.findings enable trigger set_updated_at;
--     alter table public.findings enable trigger findings_before_write;
--     drop function private.b1_2b_unlabel(text, jsonb, boolean);
--     alter table public.findings drop column person_labels;
--     alter table public.ai_analyses drop column person_labels;
--     delete from supabase_migrations.schema_migrations where version = '20261207700000';
--   commit;

-- 1. Columns

alter table public.ai_analyses add column person_labels jsonb not null default '{}'
  constraint ai_analyses_person_labels_shape check (jsonb_typeof(person_labels) = 'object' and octet_length(person_labels::text) <= 32768);
alter table public.findings add column person_labels jsonb not null default '{}'
  constraint findings_person_labels_shape check (jsonb_typeof(person_labels) = 'object' and octet_length(person_labels::text) <= 32768);

-- 2. Saved overtime issues: no money.

-- History and updated_at stay as they were: this is a clean-up, not an edit.
alter table public.issues disable trigger issue_log;
alter table public.issues disable trigger set_updated_at;
update public.issues
set evidence = regexp_replace(evidence, ', costing about .+? at cost rates over the [0-9,]+-week run\.', '.', 'g'),
    evidence_metrics = evidence_metrics - 'overtime_cost'
where detected_key like 'overtime:%'
  and (evidence_metrics ? 'overtime_cost'
       or evidence ~ ', costing about .+ at cost rates over the [0-9,]+-week run\.');
alter table public.issues enable trigger set_updated_at;
alter table public.issues enable trigger issue_log;

-- 3. Saved AI text: full names to labels, best effort.

-- Temporary helpers, dropped below. Longest names first, so "Ann Lee" goes before "Ann". Names under 3 characters, and
-- names with a double quote or a backslash (they would break the jsonb text), are skipped.
create function private.b1_2b_people(ws uuid) returns table (id uuid, name text, pattern text, label text)
language sql stable set search_path = ''
as $$
  select n.id, n.name,
    '(?<![[:alnum:]_])' || regexp_replace(n.name, '([.^$*+?(){}|\[\]\\-])', '\\\1', 'g') || '(?![[:alnum:]_])',
    n.label
  from (
    select pe.id, btrim(pe.name) as name, 'Team member ' || row_number() over (order by pe.created_at, pe.id) as label
    from public.people pe where pe.workspace_id = ws
  ) n
  where char_length(n.name) >= 3 and n.name !~ '["\\]'
  order by char_length(n.name) desc, n.label;
$$;

create function private.b1_2b_relabel(t text, ws uuid) returns text
language plpgsql stable set search_path = ''
as $$
declare p record;
begin
  if t is null then return null; end if;
  for p in select * from private.b1_2b_people(ws) loop
    t := regexp_replace(t, p.pattern, p.label, 'g');
  end loop;
  return t;
end;
$$;

-- The labels relabel would use in `t`: { label: person id }.
create function private.b1_2b_labels(t text, ws uuid) returns jsonb
language plpgsql stable set search_path = ''
as $$
declare p record; found jsonb := '{}';
begin
  if t is null then return found; end if;
  for p in select * from private.b1_2b_people(ws) loop
    if t ~ p.pattern then
      found := found || jsonb_build_object(p.label, p.id);
      t := regexp_replace(t, p.pattern, p.label, 'g');  -- so a shorter name inside a longer one isn't counted again
    end if;
  end loop;
  return found;
end;
$$;

alter table public.ai_analyses disable trigger ai_analyses_stamp;  -- it requires a run the caller reserved in the last 15 minutes
alter table public.ai_analyses disable trigger set_updated_at;     -- "latest analysis" is ordered by updated_at
-- Pre-B17 analyses keep facts inside `insights`: the money clause goes from there too.
update public.ai_analyses a
set summary  = private.b1_2b_relabel(a.summary::text, a.workspace_id)::jsonb,
    insights = private.b1_2b_relabel(
                 regexp_replace(a.insights::text, ', costing about .+? at cost rates over the [0-9,]+-week run\.', '.', 'g'),
                 a.workspace_id)::jsonb,
    review   = private.b1_2b_relabel(a.review::text, a.workspace_id)::jsonb,
    reason   = left(private.b1_2b_relabel(a.reason, a.workspace_id), 2000),
    person_labels = private.b1_2b_labels(a.summary::text || a.insights::text || a.review::text || coalesce(a.reason, ''), a.workspace_id)
where private.b1_2b_labels(a.summary::text || a.insights::text || a.review::text || coalesce(a.reason, ''), a.workspace_id) <> '{}'
   or a.insights::text ~ ', costing about .+ at cost rates over the [0-9,]+-week run\.';
alter table public.ai_analyses enable trigger set_updated_at;
alter table public.ai_analyses enable trigger ai_analyses_stamp;

alter table public.findings disable trigger findings_before_write;  -- it forbids changing an AI finding's facts, and would mark it edited
alter table public.findings disable trigger set_updated_at;
update public.findings f
set title    = left(private.b1_2b_relabel(f.title, f.workspace_id), 200),
    evidence = left(private.b1_2b_relabel(f.evidence, f.workspace_id), 2000),
    why      = left(private.b1_2b_relabel(f.why, f.workspace_id), 2000),
    facts    = private.b1_2b_relabel(
                 regexp_replace(f.facts::text, ', costing about .+? at cost rates over the [0-9,]+-week run\.', '.', 'g'),
                 f.workspace_id)::jsonb,
    person_labels = private.b1_2b_labels(f.title || ' ' || f.evidence || ' ' || f.why || ' ' || f.facts::text, f.workspace_id)
where f.origin = 'ai'
  and (private.b1_2b_labels(f.title || ' ' || f.evidence || ' ' || f.why || ' ' || f.facts::text, f.workspace_id) <> '{}'
       or f.facts::text ~ ', costing about .+ at cost rates over the [0-9,]+-week run\.');
alter table public.findings enable trigger set_updated_at;
alter table public.findings enable trigger findings_before_write;

drop function private.b1_2b_labels(text, uuid);
drop function private.b1_2b_relabel(text, uuid);
drop function private.b1_2b_people(uuid);

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261207700000', 'saved_text_privacy', array[$mig$-- Saved text carries no pay and no real names (issue #30, B1 part 2 of 3, slice 2b; docs/plans/b1-brief.md).
--
-- The review of slice 2a (#202) found two leaks that no screen change can fix, because both sit in rows every member reads:
--
--   1. SAVED OVERTIME ISSUES HOLD PAY. The engine's overtime issue said "...h/wk overtime on average within the 10% cap,
--      costing about £1,234 at cost rates over the 26-week run." and saved the same money as `evidence_metrics.overtime_cost`.
--      With the hours in the same sentence, a member divides one by the other and gets a person's rate. Austin, 6 Oct:
--      members and viewers get no pay data. (Engine 1.8.0 states hours only and the app strips the clause on save; this
--      migration cleans the rows already saved.)
--   2. SAVED AI TEXT HOLDS REAL NAMES. AI analysis is sent labels ("Team member A"), but the app put the real names back
--      before saving, so `ai_analyses` and `findings` named people to every member. Austin's Q2: members see their own name
--      and "A team member" for everyone else. From now on AI text is saved as the model wrote it, with labels, and a
--      `person_labels` map (label -> person id) beside it; names go back at render, per reader. This migration relabels
--      what is already saved.
--
-- What changes:
--   * Two columns: `ai_analyses.person_labels` and `findings.person_labels` (jsonb object, not null, default '{}', at most
--     32 KB). Both tables have table-level grants, so the new columns need none. No policy, grant or trigger is created, no
--     existing function is redefined, and `save_fields` is not touched.
--   * `issues` whose `detected_key` starts 'overtime:' lose the clause ", costing about ... at cost rates over the N-week
--     run." (it becomes ".") and the `overtime_cost` metric. History and updated_at stay as they were: it is a clean-up, not
--     an edit (the `issue_log` and `set_updated_at` triggers are switched off for the statement, then back on).
--   * `ai_analyses` (summary, insights, review, reason) and AI `findings` (title, evidence, why, facts): every FULL NAME of a
--     person in the row's workspace, as written (case-sensitive) and not inside a longer word, becomes 'Team member ' || n,
--     where n ranks the workspace's people by (created_at, id): the same numbering as `team_capacity`. The labels used are
--     written to `person_labels`. The money clause is cut from facts and pre-B17 insights too (a fact quoted the overtime
--     evidence). `findings_before_write` and `ai_analyses_stamp` (which forbid changing an AI finding's facts and require a
--     reserved run) and `set_updated_at` are switched off for those statements, then back on. Findings added by hand are
--     human-typed text and are not touched.
--   * Three helper functions are created in `private` and dropped again inside this migration.
--
-- ACCEPTED LIMITS:
--   * In rows written before this migration, a person named only by first name, a nickname or a misspelling keeps it (first
--     names in old rows mostly come from source quotes, which every member already reads; matching them would also catch
--     words like "May" or "Will"). Names under 3 characters, and names with a double quote or a backslash, are skipped.
--     Two people with the same name both match the lower-numbered label.
--   * Old AI text may QUOTE a pay-dependent cost the model was given ("overtime here costs about £1.2k a month"). Free text
--     can't be recognised reliably. Production has no members or viewers yet, so nobody can read it today. After applying,
--     re-run Analyse on each analysed process and the whole company (every stored analysis reads as out of date anyway, from
--     the prompt-version bump), and dismiss or edit any accepted AI finding that quotes overtime money.
--   * Analyses run between apply and deploy (old app) keep real names. Deploy straight after apply, then re-run post-apply
--     check 4.
--
-- Apply BEFORE deploying the app: the app selects `person_labels`.
--
-- PREFLIGHT (read-only, run with `bash packages/db/scripts/prod-sql.sh -c "..."`; with prod-sql.sh a `like` against a
-- function body needs `can''''t`, and `tgenabled` needs `::text`):
--   0. Row 55 the latest. Expect exactly 20261207000000 and 20261207500000 (nothing >= 20261207700000):
--        select version from supabase_migrations.schema_migrations where version >= '20261207000000' order by 1;
--   1. The columns don't exist yet. Expect 0:
--        select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name in ('ai_analyses', 'findings') and column_name = 'person_labels';
--   2. The six triggers this disables and re-enables exist and are enabled. Expect 6 rows, each O:
--        select tgrelid::regclass, tgname, tgenabled::text from pg_trigger
--        where not tgisinternal and (tgrelid, tgname) in (
--          ('public.issues'::regclass, 'issue_log'), ('public.issues'::regclass, 'set_updated_at'),
--          ('public.ai_analyses'::regclass, 'ai_analyses_stamp'), ('public.ai_analyses'::regclass, 'set_updated_at'),
--          ('public.findings'::regclass, 'findings_before_write'), ('public.findings'::regclass, 'set_updated_at'))
--        order by 1, 2;
--   3. The regex features work here (lookbehind, classes, shortest match). Expect 'x T y.' and 'a.':
--        select regexp_replace('x Ann Lee y.', '(?<![[:alnum:]_])Ann Lee(?![[:alnum:]_])', 'T', 'g'),
--               regexp_replace('a, costing about £1,234 at cost rates over the 26-week run.', ', costing about .+? at cost rates over the [0-9,]+-week run\.', '.', 'g');
--   4. For the log, and to compare after: what will change, the history size and the latest timestamps.
--        select count(*) filter (where evidence_metrics ? 'overtime_cost') as with_metric,
--               count(*) filter (where evidence ~ ', costing about .+ at cost rates over the [0-9,]+-week run\.') as with_sentence
--        from public.issues where detected_key like 'overtime:%';
--        select (select count(*) from public.issue_events) as issue_events,
--               (select count(*) from public.ai_analyses) as analyses, (select max(updated_at) from public.ai_analyses) as analyses_latest,
--               (select count(*) from public.findings where origin = 'ai') as ai_findings, (select max(updated_at) from public.findings) as findings_latest;
--   5. No saved AI text already holds a label (it would stay unmapped). Expect 0, 0:
--        select (select count(*) from public.ai_analyses where (summary::text || insights::text || review::text || coalesce(reason, '')) ~ 'Team member [A-Z0-9]'),
--               (select count(*) from public.findings where (title || evidence || why || facts::text) ~ 'Team member [A-Z0-9]');
--   6. Room for longer text. Expect each well under its limit (262144, 131072, 32768):
--        select max(octet_length(insights::text)), max(octet_length(review::text)) from public.ai_analyses;
--        select max(octet_length(facts::text)) from public.findings;
--   7. For the log: names the clean-up skips (under 3 characters, or a quote or backslash) and names two people share (both
--      get the lower-numbered label). Expect no rows from either:
--        select workspace_id, name from public.people where char_length(btrim(name)) < 3 or name ~ '["\\]';
--        select workspace_id, btrim(name), count(*) from public.people group by 1, 2 having count(*) > 1;
--
-- POST-APPLY CHECKS:
--   1. Re-run preflight 1: `2`. Re-run preflight 2: still 6 rows, all `O`.
--   2. select to_regprocedure('private.b1_2b_relabel(text, uuid)'), to_regprocedure('private.b1_2b_labels(text, uuid)'),
--             to_regprocedure('private.b1_2b_people(uuid)');   -- null, null, null
--   3. Re-run the first query of preflight 4: `0, 0`. The second: `issue_events` and both `max(updated_at)` unchanged.
--   4. No AI text still holds a full name of its workspace. Expect 0, 0:
--        select (select count(*) from public.ai_analyses a join public.people p on p.workspace_id = a.workspace_id
--                where char_length(btrim(p.name)) >= 3 and (a.summary::text || a.insights::text || a.review::text || coalesce(a.reason, ''))
--                      ~ ('(?<![[:alnum:]_])' || regexp_replace(btrim(p.name), '([.^$*+?(){}|\[\]\\-])', '\\\1', 'g') || '(?![[:alnum:]_])')),
--               (select count(*) from public.findings f join public.people p on p.workspace_id = f.workspace_id
--                where f.origin = 'ai' and char_length(btrim(p.name)) >= 3 and (f.title || f.evidence || f.why || f.facts::text)
--                      ~ ('(?<![[:alnum:]_])' || regexp_replace(btrim(p.name), '([.^$*+?(){}|\[\]\\-])', '\\\1', 'g') || '(?![[:alnum:]_])'));
--   5. For the log: select count(*) from public.ai_analyses where person_labels <> '{}';  and the same for public.findings.
--   6. The schema_migrations row is present.
--
-- ROLLBACK (one transaction; redeploy the app from before 2b first, since 2b's app selects the column). The overtime clause
-- and `overtime_cost` are NOT put back: the money is still shown live to editors, so nothing is lost.
--   begin;
--     -- Put names back where labels were written: each label in a row's person_labels becomes that person's current name,
--     -- or "A team member" if they were deleted. Inside jsonb the name is JSON-escaped.
--     create function private.b1_2b_unlabel(t text, labels jsonb, as_json boolean) returns text
--     language plpgsql stable set search_path = ''
--     as $f$
--     declare l record; nm text;
--     begin
--       if t is null then return null; end if;
--       for l in select k.label, k.pid from jsonb_each_text(labels) as k(label, pid) order by char_length(k.label) desc, k.label loop
--         select p.name into nm from public.people p where p.id = l.pid::uuid;
--         nm := coalesce(nm, 'A team member');
--         if as_json then nm := substr(to_jsonb(nm)::text, 2, char_length(to_jsonb(nm)::text) - 2); end if;
--         t := regexp_replace(t, l.label || '(?![[:alnum:]])', replace(replace(nm, '\', '\\'), '&', '\&'), 'g');
--       end loop;
--       return t;
--     end;
--     $f$;
--     alter table public.ai_analyses disable trigger ai_analyses_stamp;
--     alter table public.ai_analyses disable trigger set_updated_at;
--     update public.ai_analyses
--     set summary  = private.b1_2b_unlabel(summary::text, person_labels, true)::jsonb,
--         insights = private.b1_2b_unlabel(insights::text, person_labels, true)::jsonb,
--         review   = private.b1_2b_unlabel(review::text, person_labels, true)::jsonb,
--         reason   = left(private.b1_2b_unlabel(reason, person_labels, false), 2000)
--     where person_labels <> '{}';
--     alter table public.ai_analyses enable trigger set_updated_at;
--     alter table public.ai_analyses enable trigger ai_analyses_stamp;
--     alter table public.findings disable trigger findings_before_write;
--     alter table public.findings disable trigger set_updated_at;
--     update public.findings
--     set title    = left(private.b1_2b_unlabel(title, person_labels, false), 200),
--         evidence = left(private.b1_2b_unlabel(evidence, person_labels, false), 2000),
--         why      = left(private.b1_2b_unlabel(why, person_labels, false), 2000),
--         facts    = private.b1_2b_unlabel(facts::text, person_labels, true)::jsonb
--     where person_labels <> '{}';
--     alter table public.findings enable trigger set_updated_at;
--     alter table public.findings enable trigger findings_before_write;
--     drop function private.b1_2b_unlabel(text, jsonb, boolean);
--     alter table public.findings drop column person_labels;
--     alter table public.ai_analyses drop column person_labels;
--     delete from supabase_migrations.schema_migrations where version = '20261207700000';
--   commit;

-- 1. Columns

alter table public.ai_analyses add column person_labels jsonb not null default '{}'
  constraint ai_analyses_person_labels_shape check (jsonb_typeof(person_labels) = 'object' and octet_length(person_labels::text) <= 32768);
alter table public.findings add column person_labels jsonb not null default '{}'
  constraint findings_person_labels_shape check (jsonb_typeof(person_labels) = 'object' and octet_length(person_labels::text) <= 32768);

-- 2. Saved overtime issues: no money.

-- History and updated_at stay as they were: this is a clean-up, not an edit.
alter table public.issues disable trigger issue_log;
alter table public.issues disable trigger set_updated_at;
update public.issues
set evidence = regexp_replace(evidence, ', costing about .+? at cost rates over the [0-9,]+-week run\.', '.', 'g'),
    evidence_metrics = evidence_metrics - 'overtime_cost'
where detected_key like 'overtime:%'
  and (evidence_metrics ? 'overtime_cost'
       or evidence ~ ', costing about .+ at cost rates over the [0-9,]+-week run\.');
alter table public.issues enable trigger set_updated_at;
alter table public.issues enable trigger issue_log;

-- 3. Saved AI text: full names to labels, best effort.

-- Temporary helpers, dropped below. Longest names first, so "Ann Lee" goes before "Ann". Names under 3 characters, and
-- names with a double quote or a backslash (they would break the jsonb text), are skipped.
create function private.b1_2b_people(ws uuid) returns table (id uuid, name text, pattern text, label text)
language sql stable set search_path = ''
as $$
  select n.id, n.name,
    '(?<![[:alnum:]_])' || regexp_replace(n.name, '([.^$*+?(){}|\[\]\\-])', '\\\1', 'g') || '(?![[:alnum:]_])',
    n.label
  from (
    select pe.id, btrim(pe.name) as name, 'Team member ' || row_number() over (order by pe.created_at, pe.id) as label
    from public.people pe where pe.workspace_id = ws
  ) n
  where char_length(n.name) >= 3 and n.name !~ '["\\]'
  order by char_length(n.name) desc, n.label;
$$;

create function private.b1_2b_relabel(t text, ws uuid) returns text
language plpgsql stable set search_path = ''
as $$
declare p record;
begin
  if t is null then return null; end if;
  for p in select * from private.b1_2b_people(ws) loop
    t := regexp_replace(t, p.pattern, p.label, 'g');
  end loop;
  return t;
end;
$$;

-- The labels relabel would use in `t`: { label: person id }.
create function private.b1_2b_labels(t text, ws uuid) returns jsonb
language plpgsql stable set search_path = ''
as $$
declare p record; found jsonb := '{}';
begin
  if t is null then return found; end if;
  for p in select * from private.b1_2b_people(ws) loop
    if t ~ p.pattern then
      found := found || jsonb_build_object(p.label, p.id);
      t := regexp_replace(t, p.pattern, p.label, 'g');  -- so a shorter name inside a longer one isn't counted again
    end if;
  end loop;
  return found;
end;
$$;

alter table public.ai_analyses disable trigger ai_analyses_stamp;  -- it requires a run the caller reserved in the last 15 minutes
alter table public.ai_analyses disable trigger set_updated_at;     -- "latest analysis" is ordered by updated_at
-- Pre-B17 analyses keep facts inside `insights`: the money clause goes from there too.
update public.ai_analyses a
set summary  = private.b1_2b_relabel(a.summary::text, a.workspace_id)::jsonb,
    insights = private.b1_2b_relabel(
                 regexp_replace(a.insights::text, ', costing about .+? at cost rates over the [0-9,]+-week run\.', '.', 'g'),
                 a.workspace_id)::jsonb,
    review   = private.b1_2b_relabel(a.review::text, a.workspace_id)::jsonb,
    reason   = left(private.b1_2b_relabel(a.reason, a.workspace_id), 2000),
    person_labels = private.b1_2b_labels(a.summary::text || a.insights::text || a.review::text || coalesce(a.reason, ''), a.workspace_id)
where private.b1_2b_labels(a.summary::text || a.insights::text || a.review::text || coalesce(a.reason, ''), a.workspace_id) <> '{}'
   or a.insights::text ~ ', costing about .+ at cost rates over the [0-9,]+-week run\.';
alter table public.ai_analyses enable trigger set_updated_at;
alter table public.ai_analyses enable trigger ai_analyses_stamp;

alter table public.findings disable trigger findings_before_write;  -- it forbids changing an AI finding's facts, and would mark it edited
alter table public.findings disable trigger set_updated_at;
update public.findings f
set title    = left(private.b1_2b_relabel(f.title, f.workspace_id), 200),
    evidence = left(private.b1_2b_relabel(f.evidence, f.workspace_id), 2000),
    why      = left(private.b1_2b_relabel(f.why, f.workspace_id), 2000),
    facts    = private.b1_2b_relabel(
                 regexp_replace(f.facts::text, ', costing about .+? at cost rates over the [0-9,]+-week run\.', '.', 'g'),
                 f.workspace_id)::jsonb,
    person_labels = private.b1_2b_labels(f.title || ' ' || f.evidence || ' ' || f.why || ' ' || f.facts::text, f.workspace_id)
where f.origin = 'ai'
  and (private.b1_2b_labels(f.title || ' ' || f.evidence || ' ' || f.why || ' ' || f.facts::text, f.workspace_id) <> '{}'
       or f.facts::text ~ ', costing about .+ at cost rates over the [0-9,]+-week run\.');
alter table public.findings enable trigger set_updated_at;
alter table public.findings enable trigger findings_before_write;

drop function private.b1_2b_labels(text, uuid);
drop function private.b1_2b_relabel(text, uuid);
drop function private.b1_2b_people(uuid);
$mig$]);

commit;

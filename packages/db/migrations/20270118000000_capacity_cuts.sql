-- Capacity cuts (P0, docs/plans/capacity/p0-cuts-brief.md; decisions D12 and D21): first principles and every share link go.
--
-- What it does:
--   1. `private.may_sign_in` no longer lets an outsider listed on a share link sign in as a guest: it has no share links to read. An
--      address with no deployment role may not sign in. (A full copy of the 20270105000000 body with that clause cut.)
--   2. `public.import_process_bundle` no longer takes `first_principles` in its extras (a key that is still sent is ignored), and
--      returns `{processes, sources}`. `public.import_workspace_bundle` no longer restores a process's `first_principles` (a plan that
--      still has one is accepted, and the row is skipped), so an older backup still restores. Both are full copies of the latest
--      bodies (20270102000000 and 20270114000000) with the first-principles parts cut.
--   3. Drops the share links: table `public.share_links` (with its triggers, policies and indexes), `public.open_share_link`,
--      `public.share_team_capacity`, and the private helpers only they used (`share_snapshot_problem`, `share_links_before_write`,
--      `share_links_no_speeds`, `share_emails_ok`, `share_unpct`, `share_norm`, `share_strings`, `share_name_tokens`, `lever_kind_ids`).
--   4. Drops table `public.first_principles` (with its triggers, policies and indexes).
--
-- Left in place on purpose:
--   * the unique index `process_revisions_id_process_workspace_key` (made by 20261119000000 for first principles): `solutions` has a
--     foreign key onto it (`solutions_base_revision_id_process_id_workspace_id_fkey`);
--   * `public.lever_settings` and its data (the Settings, Levers page is gone and nothing reads the table; a later clean-up may drop it),
--     and every other table.
--
-- Rows lost: every share link (their pages are gone with this release) and every first-principles row. Nothing else holds a foreign
-- key to either table, so the drops cannot fail on real rows (checked: no constraint, view or policy of another table names them).
--
-- Preflight: `select count(*) from public.schema_migrations where version >= '20270118000000';` expect 0.
--     Record: select count(*) from public.share_links; select count(*) from public.first_principles;
-- Post-apply checks: `select to_regclass('public.share_links'), to_regclass('public.first_principles');` both null;
--     `select proname from pg_proc where proname in ('open_share_link', 'share_team_capacity', 'share_snapshot_problem');` no rows;
--     a Viewer's workspace bundle still exports, and the export restores.
--
-- Rollback (as the table owner, in one transaction; the data is not restored):
--
-- 1. The check function the share table uses, as it stands now:
--   CREATE OR REPLACE FUNCTION private.share_emails_ok(emails text[])
--    RETURNS boolean
--    LANGUAGE sql
--    IMMUTABLE
--    SET search_path TO ''
--   AS $function$
--     select emails is not null
--       and coalesce(cardinality(emails), 0) <= 50
--       and not exists (
--         select 1 from unnest(emails) as e
--         where e is null or e <> lower(btrim(e)) or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
--       and (select count(distinct e) from unnest(emails) as e) = coalesce(cardinality(emails), 0);
--   $function$;
-- 2. The two tables (columns, checks, keys, indexes, row-level security, policies and column grants), as they stand now:
--   CREATE TABLE public.first_principles (
--       id uuid DEFAULT gen_random_uuid() NOT NULL,
--       workspace_id uuid NOT NULL,
--       process_id uuid NOT NULL,
--       revision_id uuid NOT NULL,
--       job_who text DEFAULT ''::text NOT NULL,
--       job_progress text DEFAULT ''::text NOT NULL,
--       job_situation text DEFAULT ''::text NOT NULL,
--       job_done text DEFAULT ''::text NOT NULL,
--       statements jsonb DEFAULT '[]'::jsonb NOT NULL,
--       requirements jsonb DEFAULT '[]'::jsonb NOT NULL,
--       deletes jsonb DEFAULT '[]'::jsonb NOT NULL,
--       improvements jsonb DEFAULT '[]'::jsonb NOT NULL,
--       why_problem text DEFAULT ''::text NOT NULL,
--       why_chain jsonb DEFAULT '[]'::jsonb NOT NULL,
--       root_cause text DEFAULT ''::text NOT NULL,
--       measures jsonb DEFAULT '[]'::jsonb NOT NULL,
--       created_at timestamp with time zone DEFAULT now() NOT NULL,
--       updated_at timestamp with time zone DEFAULT now() NOT NULL,
--       created_by uuid DEFAULT auth.uid(),
--       CONSTRAINT first_principles_deletes_check CHECK (((jsonb_typeof(deletes) = 'array'::text) AND (jsonb_array_length(deletes) <= 50) AND (octet_length((deletes)::text) <= 524288))),
--       CONSTRAINT first_principles_improvements_check CHECK (((jsonb_typeof(improvements) = 'array'::text) AND (jsonb_array_length(improvements) <= 50) AND (octet_length((improvements)::text) <= 524288))),
--       CONSTRAINT first_principles_job_done_check CHECK ((char_length(job_done) <= 2000)),
--       CONSTRAINT first_principles_job_progress_check CHECK ((char_length(job_progress) <= 2000)),
--       CONSTRAINT first_principles_job_situation_check CHECK ((char_length(job_situation) <= 2000)),
--       CONSTRAINT first_principles_job_who_check CHECK ((char_length(job_who) <= 2000)),
--       CONSTRAINT first_principles_measures_check CHECK (((jsonb_typeof(measures) = 'array'::text) AND (jsonb_array_length(measures) <= 50) AND (octet_length((measures)::text) <= 524288))),
--       CONSTRAINT first_principles_requirements_check CHECK (((jsonb_typeof(requirements) = 'array'::text) AND (jsonb_array_length(requirements) <= 50) AND (octet_length((requirements)::text) <= 524288))),
--       CONSTRAINT first_principles_root_cause_check CHECK ((char_length(root_cause) <= 2000)),
--       CONSTRAINT first_principles_statements_check CHECK (((jsonb_typeof(statements) = 'array'::text) AND (jsonb_array_length(statements) <= 50) AND (octet_length((statements)::text) <= 524288))),
--       CONSTRAINT first_principles_why_chain_check CHECK (((jsonb_typeof(why_chain) = 'array'::text) AND (jsonb_array_length(why_chain) <= 10) AND (octet_length((why_chain)::text) <= 524288))),
--       CONSTRAINT first_principles_why_problem_check CHECK ((char_length(why_problem) <= 2000))
--   );
--
--   CREATE TABLE public.share_links (
--       id uuid DEFAULT gen_random_uuid() NOT NULL,
--       workspace_id uuid NOT NULL,
--       token_hash text NOT NULL,
--       kind text NOT NULL,
--       target_id uuid,
--       mode text DEFAULT 'view'::text NOT NULL,
--       show_people boolean DEFAULT false NOT NULL,
--       show_financials boolean DEFAULT false NOT NULL,
--       allowed_emails text[] DEFAULT '{}'::text[] NOT NULL,
--       expires_at timestamp with time zone,
--       label text,
--       snapshot jsonb NOT NULL,
--       snapshot_at timestamp with time zone DEFAULT now() NOT NULL,
--       engine_version text NOT NULL,
--       created_by uuid DEFAULT auth.uid(),
--       created_at timestamp with time zone DEFAULT now() NOT NULL,
--       revoked_at timestamp with time zone,
--       revoked_by uuid,
--       opens integer DEFAULT 0 NOT NULL,
--       last_opened_at timestamp with time zone,
--       CONSTRAINT share_links_emails CHECK (private.share_emails_ok(allowed_emails)),
--       CONSTRAINT share_links_engine_version CHECK (((char_length(engine_version) >= 1) AND (char_length(engine_version) <= 32))),
--       CONSTRAINT share_links_kind CHECK ((kind = ANY (ARRAY['overview'::text, 'process'::text, 'issue'::text, 'solution'::text, 'scenario'::text]))),
--       CONSTRAINT share_links_label CHECK (((label IS NULL) OR ((char_length(btrim(label)) >= 1) AND (char_length(btrim(label)) <= 120)))),
--       CONSTRAINT share_links_mode CHECK ((mode = ANY (ARRAY['view'::text, 'play'::text]))),
--       CONSTRAINT share_links_restricted CHECK ((((NOT show_people) AND (NOT show_financials)) OR ((cardinality(allowed_emails) > 0) AND (expires_at IS NOT NULL)))),
--       CONSTRAINT share_links_snapshot_size CHECK ((octet_length((snapshot)::text) <= 5242880)),
--       CONSTRAINT share_links_target CHECK (((kind = 'overview'::text) = (target_id IS NULL))),
--       CONSTRAINT share_links_token_hash CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
--   );
--
--   ALTER TABLE ONLY public.first_principles
--       ADD CONSTRAINT first_principles_pkey PRIMARY KEY (id);
--
--   ALTER TABLE ONLY public.first_principles
--       ADD CONSTRAINT first_principles_revision_id_key UNIQUE (revision_id);
--
--   ALTER TABLE ONLY public.share_links
--       ADD CONSTRAINT share_links_pkey PRIMARY KEY (id);
--
--   CREATE INDEX first_principles_process_id_idx ON public.first_principles USING btree (process_id);
--
--   CREATE INDEX first_principles_workspace_id_idx ON public.first_principles USING btree (workspace_id);
--
--   CREATE UNIQUE INDEX share_links_token_hash_key ON public.share_links USING btree (token_hash);
--
--   CREATE INDEX share_links_workspace_idx ON public.share_links USING btree (workspace_id, created_at DESC);
--
--
--
--
--
--
--   ALTER TABLE ONLY public.first_principles
--       ADD CONSTRAINT first_principles_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
--
--   ALTER TABLE ONLY public.first_principles
--       ADD CONSTRAINT first_principles_revision_id_process_id_workspace_id_fkey FOREIGN KEY (revision_id, process_id, workspace_id) REFERENCES public.process_revisions(id, process_id, workspace_id) ON DELETE CASCADE;
--
--   ALTER TABLE ONLY public.first_principles
--       ADD CONSTRAINT first_principles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--
--   ALTER TABLE ONLY public.share_links
--       ADD CONSTRAINT share_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
--
--   ALTER TABLE ONLY public.share_links
--       ADD CONSTRAINT share_links_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON DELETE SET NULL;
--
--   ALTER TABLE ONLY public.share_links
--       ADD CONSTRAINT share_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
--
--   CREATE POLICY "create share links" ON public.share_links FOR INSERT TO authenticated WITH CHECK (public.can_edit_workspace(workspace_id));
--
--   CREATE POLICY "delete first_principles" ON public.first_principles FOR DELETE TO authenticated USING (public.can_edit_workspace(workspace_id));
--
--   ALTER TABLE public.first_principles ENABLE ROW LEVEL SECURITY;
--
--   CREATE POLICY "insert first_principles" ON public.first_principles FOR INSERT TO authenticated WITH CHECK (public.can_edit_workspace(workspace_id));
--
--   CREATE POLICY "read first_principles" ON public.first_principles FOR SELECT TO authenticated USING (public.can_read_workspace(workspace_id));
--
--   CREATE POLICY "read share links" ON public.share_links FOR SELECT TO authenticated USING (public.can_edit_workspace(workspace_id));
--
--   ALTER TABLE public.share_links ENABLE ROW LEVEL SECURITY;
--
--   CREATE POLICY "update first_principles" ON public.first_principles FOR UPDATE TO authenticated USING (public.can_edit_workspace(workspace_id)) WITH CHECK (public.can_edit_workspace(workspace_id));
--
--   CREATE POLICY "update share links" ON public.share_links FOR UPDATE TO authenticated USING (public.can_edit_workspace(workspace_id)) WITH CHECK (public.can_edit_workspace(workspace_id));
--
--   GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.first_principles TO authenticated;
--
--   GRANT SELECT(id) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(workspace_id),INSERT(workspace_id) ON TABLE public.share_links TO authenticated;
--
--   GRANT INSERT(token_hash) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(kind),INSERT(kind) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(target_id),INSERT(target_id) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(mode),INSERT(mode) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(show_people),INSERT(show_people) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(show_financials),INSERT(show_financials) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(allowed_emails),INSERT(allowed_emails) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(expires_at),INSERT(expires_at) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(label),INSERT(label),UPDATE(label) ON TABLE public.share_links TO authenticated;
--
--   GRANT INSERT(snapshot),UPDATE(snapshot) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(snapshot_at) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(engine_version),INSERT(engine_version),UPDATE(engine_version) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(created_by) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(created_at) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(revoked_at),UPDATE(revoked_at) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(revoked_by) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(opens) ON TABLE public.share_links TO authenticated;
--
--   GRANT SELECT(last_opened_at) ON TABLE public.share_links TO authenticated;
-- 3. The other functions, as they stand now (the trigger function reads the share table's row type, so the table comes first):
--   CREATE OR REPLACE FUNCTION private.share_unpct(t text)
--    RETURNS text
--    LANGUAGE plpgsql
--    IMMUTABLE
--    SET search_path TO ''
--   AS $function$
--   declare
--     rest text := coalesce(t, '');
--     res text := '';
--     run text;
--     p integer;
--   begin
--     if strpos(rest, '%') = 0 then
--       return rest;
--     end if;
--     loop
--       run := substring(rest from '((?:%[0-9A-Fa-f]{2})+)');
--       exit when run is null;
--       p := strpos(rest, run);
--       res := res || left(rest, p - 1);
--       begin
--         res := res || convert_from(decode(replace(run, '%', ''), 'hex'), 'UTF8');
--       exception when others then
--         res := res || run;
--       end;
--       rest := substr(rest, p + char_length(run));
--     end loop;
--     return res || rest;
--   end;
--   $function$;
--
--   CREATE OR REPLACE FUNCTION private.share_norm(t text)
--    RETURNS text
--    LANGUAGE plpgsql
--    IMMUTABLE
--    SET search_path TO ''
--   AS $function$
--   declare
--     d text := private.share_unpct(t);
--     x text;
--   begin
--     -- Plain ASCII (most text): nothing to decompose, strip or fold; only case, ids and white space, each behind one cheap test.
--     if d !~ '[^\x09\x0A\x0D\x20-\x7E]' then
--       x := pg_catalog.translate(pg_catalog.lower(d), '`', '''');
--       if x !~ '[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-|[\x09-\x0D]|  |\\[nrtbf]|\\u[0-9a-fA-F]{4}' then
--         return pg_catalog.btrim(x);
--       end if;
--       if x ~ '[0-9a-f]{8}-[0-9a-f]{4}-' then
--         x := pg_catalog.regexp_replace(x, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', E'\x01', 'g');
--       end if;
--       if x ~ '[0-9a-f]{16}' then
--         x := pg_catalog.regexp_replace(x, '(?<![0-9a-z@])(?=[0-9a-f]*[a-f])[0-9a-f]{16,}(?![0-9a-z@])', E'\x01', 'g');
--       end if;
--       if x ~ '[\x09-\x0D]|  |\\[nrtbf]|\\u[0-9a-fA-F]{4}' then
--         x := pg_catalog.regexp_replace(x, '([[:space:]]|\\[nrtbf]|\\u[0-9a-fA-F]{4})+', ' ', 'g');
--       end if;
--       return pg_catalog.btrim(x);
--     end if;
--     return pg_catalog.btrim(pg_catalog.regexp_replace(
--       pg_catalog.regexp_replace(
--         pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
--           pg_catalog.translate(
--             pg_catalog.lower(pg_catalog.translate(
--               normalize(pg_catalog.regexp_replace(
--                 normalize(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(d,
--                   U&'\00E4', 'ae'), U&'\00F6', 'oe'), U&'\00FC', 'ue'), U&'\00C4', 'Ae'), U&'\00D6', 'Oe'), U&'\00DC', 'Ue'), nfkd),
--                 U&'[\00AD\034F\061C\115F\1160\17B4\17B5\180B-\180F\200B-\200F\202A-\202E\2060-\206F\3164\FE00-\FE0F\FEFF\FFA0\FFF0-\FFF8\+0E0000-\+0E0FFF\+01BCA0-\+01BCA3\+01D173-\+01D17A\0300-\036F\0483-\0489\0591-\05BD\05BF\05C1\05C2\05C4\05C5\05C7\0610-\061A\064B-\065F\0670\06D6-\06DC\06DF-\06E4\06E7\06E8\06EA-\06ED\0711\0730-\074A\0900-\0903\093A-\093C\093E-\094F\0951-\0957\0962\0963\0E31\0E34-\0E3A\0E47-\0E4E\1AB0-\1AFF\1DC0-\1DFF\20D0-\20FF\302A-\302F\3099\309A\FE20-\FE2F]',
--                 '', 'g'), nfc),
--               U&'\2019\2018\02BC\2032\0060\00B4\201C\201D\2010\2011\2012\2013\2014\2212',
--               pg_catalog.repeat('''', 6) || '""' || '------')),
--             U&'\0142\00F8\0111\00F0\0131\03C2', 'lodd' || 'i' || U&'\03C3'),
--           U&'\00DF', 'ss'), U&'\00E6', 'ae'), U&'\0153', 'oe'), U&'\00FE', 'th'),
--         '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<![0-9a-z@])(?=[0-9a-f]*[a-f])[0-9a-f]{16,}(?![0-9a-z@])', E'\x01', 'g'),
--       '([[:space:]]|\\[nrtbf]|\\u[0-9a-fA-F]{4})+', ' ', 'g'));
--   end;
--   $function$;
--
--   CREATE OR REPLACE FUNCTION private.share_strings(snap jsonb)
--    RETURNS TABLE(k text, v text)
--    LANGUAGE sql
--    IMMUTABLE
--    SET search_path TO ''
--   AS $function$
--     with recursive w (k, v) as (
--       select null::text, snap
--       union all
--       select coalesce(e.key, w.k), e.value
--       from w
--       cross join lateral (
--         select o.key, o.value from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) as o
--         union all
--         select null::text, a.value from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) as a
--       ) as e
--     )
--     select w.k, w.v #>> '{}' from w where pg_catalog.jsonb_typeof(w.v) = 'string';
--   $function$;
--
--   CREATE OR REPLACE FUNCTION private.share_name_tokens(ws uuid, kind text)
--    RETURNS SETOF text
--    LANGUAGE plpgsql
--    STABLE
--    SET search_path TO ''
--   AS $function$
--   declare
--     nm record;
--     parts text[];
--     a integer;
--     b integer;
--     tok text;
--     latin constant text := U&'[a-z\00C0-\024F\1E00-\1EFF]';
--     script constant text := U&'^[\1100-\11FF\AC00-\D7AF\3040-\30FF\3400-\4DBF\4E00-\9FFF\F900-\FAFF]{2,}$';
--   begin
--     if kind not in ('person', 'script') then
--       return;
--     end if;
--     -- A name as typed and without its umlauts (Müller is "mueller" once normalised, and also "muller").
--     for nm in select private.share_norm(v.name) as name
--               from (select p.name from public.people p where p.workspace_id = ws
--                     union
--                     select pg_catalog.translate(p.name, U&'\00E4\00F6\00FC\00C4\00D6\00DC', 'aouAOU') from public.people p where p.workspace_id = ws) as v loop
--       parts := array(select x from unnest(regexp_split_to_array(nm.name, '[^[:alpha:]]+')) as x
--                      where x <> '' and x not in ('the', 'and', 'for', 'ltd', 'inc', 'llc', 'plc'));
--       if kind = 'script' then
--         foreach tok in array parts loop
--           if tok ~ script then
--             return next tok;
--             -- An unspaced name is its surname and its given name too (田中太郎: 田中 and 太郎).
--             if char_length(tok) >= 3 then
--               return next left(tok, 2);
--               return next right(tok, 2);
--             end if;
--           end if;
--         end loop;
--         continue;
--       end if;
--       -- A name of one short word ("Li") is no name.
--       tok := array_to_string(parts, '');
--       continue when char_length(tok) < (case when tok ~ latin then 3 else 2 end);
--       for a in 1 .. cardinality(parts) loop
--         for b in a .. cardinality(parts) loop
--           tok := array_to_string(parts[a:b], '');
--           if char_length(tok) >= (case when tok ~ latin then 3 else 2 end)
--              and tok not in ('team', 'member', 'client', 'hidden', 'email', 'amount') then
--             return next tok;
--           end if;
--         end loop;
--       end loop;
--     end loop;
--     return;
--   end;
--   $function$;
--
--   CREATE OR REPLACE FUNCTION private.lever_kind_ids()
--    RETURNS text[]
--    LANGUAGE sql
--    IMMUTABLE
--    SET search_path TO ''
--   AS $function$
--     select array['demand.enquiries', 'demand.conversion', 'demand.seasonal', 'demand.growth', 'people.headcount', 'people.hours',
--       'people.starters', 'people.leave', 'process.time', 'process.wait', 'process.rework', 'process.routing', 'clients.count',
--       'clients.fee', 'clients.churn', 'clients.causes', 'finances.prices', 'finances.roleCost', 'finances.fixed',
--       'market.conditions', 'market.schedule']
--   $function$;
--
--   CREATE OR REPLACE FUNCTION private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
--    RETURNS text
--    LANGUAGE plpgsql
--    STABLE
--    SET search_path TO ''
--   AS $function$
--   declare
--     -- The keys whose strings are NOT free text: ids, dates, enums and selectors the engine reads (keep equal to SHARE_NON_TEXT_KEYS in
--     -- packages/db/src/share.ts). Any other string is free text, so a key nobody classified is checked, not skipped (default deny).
--     non_text_keys constant text[] := array['agreed_by', 'kpi', 'archived_at', 'archived_by', 'at', 'auto_verdict',
--       'base_revision_id', 'by', 'child_process_id', 'client_id', 'comparator', 'condition_id', 'created_at', 'created_by',
--       'currency', 'dataset_id', 'detected_key', 'dismissed_revision_id', 'draft_revision_id', 'driver', 'end_date',
--       'entry_process_id', 'entry_step_id', 'every', 'file_url', 'from_step_id', 'id', 'import_source', 'insight_key', 'issueId',
--       'issue_id', 'kind', 'linked_parameter', 'live_revision_id', 'op', 'outcome', 'owner_ids', 'owner_person_id',
--       'parent_process_id', 'parent_scenario_id', 'parent_step_id', 'path', 'person_id', 'preset', 'pricing_model', 'process_id',
--       'published_at', 'published_by', 'purpose', 'recorded_at', 'replaced_by', 'replaces_step_ids', 'resolution', 'resolved_at',
--       'resolved_how', 'resolved_solution_id', 'reviewed_at', 'reviewed_by', 'revision_id', 'rework_to_step_id', 'role_id',
--       'scenario_id', 'service_id', 'severity', 'slug', 'solutionId', 'solution_id', 'source_id', 'source_ids', 'stage',
--       'start_date', 'status', 'step_id', 'suggestion_id', 'timestamp', 'to_step_id', 'type', 'hiddenLevers', 'updated_at',
--       'user_verdict', 'verdict', 'wait_dist', 'work_dist', 'workspace_id',
--       -- Scenario links (sandbox phase 5b): each is checked by FORMAT at every depth in step 1, so free text cannot hide under one.
--       'from', 'lever', 'parent_id', 'scenarioId', 'startDate', 'target'];
--     everything text;
--     free text;
--     ft text[];
--     nm record;
--     parts text[];
--     joined text;
--     latin constant text := U&'[a-z\00C0-\024F\1E00-\1EFF]';
--     script constant text := U&'^[\1100-\11FF\AC00-\D7AF\3040-\30FF\3400-\4DBF\4E00-\9FFF\F900-\FAFF]{2,}$';
--   begin
--     -- 1. The snapshot is the link's.
--     if snap is null or jsonb_typeof(snap) <> 'object'
--        or snap -> 'v' is distinct from '1'::jsonb
--        or snap -> 'kind' is distinct from to_jsonb(kind)
--        or jsonb_typeof(snap -> 'toggles') is distinct from 'object'
--        or snap -> 'toggles' -> 'people' is distinct from to_jsonb(show_people)
--        or snap -> 'toggles' -> 'financials' is distinct from to_jsonb(show_financials)  -- B4
--        -- B4 begin
--        -- The kinds a play link hides. Not free text: only known kind ids (so the key can't smuggle a name).
--        -- (CASE, not OR: Postgres doesn't promise to stop before jsonb_array_length on a non-array)
--        -- The key is a non-text key at ANY depth, so it may appear only once, at the top: a copy nested elsewhere would skip the name checks.
--        or jsonb_array_length(jsonb_path_query_array(snap, 'strict $.**.hiddenLevers')) > (case when snap ? 'hiddenLevers' then 1 else 0 end)
--        or (snap ? 'hiddenLevers' and case when jsonb_typeof(snap -> 'hiddenLevers') <> 'array' then true else (
--            jsonb_array_length(snap -> 'hiddenLevers') > 30
--            or exists (select 1 from jsonb_array_elements(snap -> 'hiddenLevers') h
--                       where jsonb_typeof(h) <> 'string' or not (h #>> '{}' = any (private.lever_kind_ids())))
--            or (select count(distinct h) from jsonb_array_elements(snap -> 'hiddenLevers') h) <> jsonb_array_length(snap -> 'hiddenLevers')) end)
--        -- B4 end
--        -- 5b begin: a scenario link's keys are non-text keys at ANY depth, so each is checked by format wherever it sits: an object or an
--        -- array under it, or a string that is not the key's shape, is refused (a number, a boolean and null hold no words). STRICT, so an
--        -- array is itself the item tested (lax mode would unwrap it and let an array of legal strings pass).
--        or jsonb_path_exists(snap, 'strict $.**.lever ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^[A-EX][0-9]$")))')
--        or jsonb_path_exists(snap, 'strict $.**.target ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@busiest|@heaviest|initial|recover|late_penalty|missed_penalty|late|resp|onb|rework|load|handoff|results|tenure|price|market|custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")))')
--        or jsonb_path_exists(snap, 'strict $.**.from ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])(-[0-9]{2})?$")))')
--        or jsonb_path_exists(snap, 'strict $.**.parent_id ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")))')
--        or jsonb_path_exists(snap, 'strict $.**.scenarioId ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")))')
--        or jsonb_path_exists(snap, 'strict $.**.startDate ? (@.type() == "object" || @.type() == "array" || (@.type() == "string" && !(@ like_regex "^[0-9]{4}-[0-9]{2}-[0-9]{2}$")))')
--        -- 5b end
--        then  -- B4
--       return 'The snapshot doesn''t match the link.';
--     end if;
--
--     -- 1b. A scenario link's own shape (sandbox phase 5b): the scenario and the chain it builds on (1 to 6, root first, each the parent of
--     -- the next, the last the shared one), their changes as the database stores them, the frozen start and horizon, the hidden count.
--     -- CASE, so nothing reads a value that is not the type it expects.
--     if kind = 'scenario' and (
--          case
--            when jsonb_typeof(snap -> 'scenarios') is distinct from 'array' or jsonb_array_length(snap -> 'scenarios') not between 1 and 6 then true
--            when exists (
--              select 1 from jsonb_array_elements(snap -> 'scenarios') s
--              where jsonb_typeof(s) <> 'object'
--                 or jsonb_typeof(s -> 'id') is distinct from 'string' or (s ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
--                 or jsonb_typeof(s -> 'name') is distinct from 'string'
--                 or jsonb_typeof(s -> 'changes') is distinct from 'array'
--                 or not private.is_sandbox_changes(s -> 'changes')) then true
--            when exists (
--              select 1 from jsonb_array_elements(snap -> 'scenarios') with ordinality as s (v, n)
--              where (n = 1 and jsonb_typeof(s.v -> 'parent_id') not in ('null') and s.v -> 'parent_id' is not null)
--                 or (n > 1 and (s.v ->> 'parent_id') is distinct from (snap -> 'scenarios' -> (n::int - 2) ->> 'id'))) then true
--            when (select count(distinct s ->> 'id') from jsonb_array_elements(snap -> 'scenarios') s) <> jsonb_array_length(snap -> 'scenarios') then true
--            when (snap ->> 'scenarioId') is distinct from (snap -> 'scenarios' -> (jsonb_array_length(snap -> 'scenarios') - 1) ->> 'id') then true
--            when jsonb_typeof(snap -> 'bundle') is distinct from 'object' or jsonb_typeof(snap -> 'solutions') is distinct from 'array' then true
--            when jsonb_typeof(snap -> 'startDate') is distinct from 'string' or (snap ->> 'startDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then true
--            when jsonb_typeof(snap -> 'months') is distinct from 'number' or (snap ->> 'months') !~ '^([1-9]|1[0-9]|2[0-4])$' then true
--            when jsonb_typeof(snap -> 'hiddenCostChanges') is distinct from 'number' or (snap ->> 'hiddenCostChanges') !~ '^[0-9]{1,4}$' then true
--            else false
--          end) then
--       return 'The snapshot doesn''t match the link.';
--     end if;
--     -- Every string value, normalised ONCE (the \x01 between them is no space and no letter, so nothing matches across two values),
--     -- and the free-text ones on their own. A bare uuid is skipped before it costs a normalisation.
--     select string_agg(n.v, E'\x01'), string_agg(n.v, E'\x01') filter (where (n.k is null or n.k <> all (non_text_keys))  -- B3 follow-up
--         and not (n.k is not distinct from 'color' and n.raw ~ '^#[0-9a-fA-F]{3,8}$'))  -- B3 follow-up: a whole hex colour is no text
--       into everything, free
--       from (select s.k, s.v as raw, private.share_norm(s.v) as v from private.share_strings(snap) as s  -- B3 follow-up
--             where s.v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') as n;
--     everything := coalesce(everything, '');
--     free := coalesce(free, '');
--
--     -- 2. No email address, in any string value. The part before the @ ends in a letter, digit or one of _ % + - (so
--     -- `roles.@busiest.headcount`, a scenario's selector, is not one).
--     if everything ~* '[a-z0-9._%+-]*[a-z0-9_%+-]@[a-z0-9.-]+\.[a-z]{2,}' then
--       return 'The snapshot contains an email address.';
--     end if;
--
--     -- 3. No pay, for anyone, whatever the toggles (Austin, 6 Oct: no pay data). A string counts as a value.
--     if jsonb_path_exists(snap, 'lax $.**.cost_rate ? (@ != null)') then
--       return 'The snapshot contains a person''s pay.';
--     end if;
--
--     -- 4. No evidence notes: provenance of any JSON type (an empty object or null is fine), and quotes from sources cited as facts.
--     if jsonb_path_exists(snap, 'lax $.**.provenance.*')
--        or jsonb_path_exists(snap, 'strict $.**.provenance ? (@.type() != "object" && @.type() != "null")')
--        or jsonb_path_exists(snap, 'lax $.**.facts ? (@.kind == "quote")') then
--       return 'The snapshot contains evidence notes.';
--     end if;
--
--     -- 5. Clients are always anonymised, by the whole of the name: its words (stop words left out) one after another in free text
--     -- with at most three non-letters between, or run together; never by one word of it ("Group review" is no client).
--     select array_agg(distinct t) into ft from regexp_split_to_table(free, '[^[:alpha:]]+') as t where t <> '';
--     ft := coalesce(ft, '{}');
--     for nm in select private.share_norm(v.name) as name
--               from (select c.name from public.clients c where c.workspace_id = ws
--                     union
--                     select pg_catalog.translate(c.name, U&'\00E4\00F6\00FC\00C4\00D6\00DC', 'aouAOU') from public.clients c where c.workspace_id = ws) as v loop
--       parts := array(select x from unnest(regexp_split_to_array(nm.name, '[^[:alpha:]]+')) as x
--                      where x <> '' and x not in ('the', 'and', 'for', 'ltd', 'inc', 'llc', 'plc'));
--       joined := array_to_string(parts, '');
--       continue when cardinality(parts) = 0 or char_length(joined) < (case when joined ~ latin then 3 else 2 end)
--                  or joined in ('team', 'member', 'client', 'hidden', 'email', 'amount');
--       if joined = any (ft) or (joined ~ script and strpos(free, joined) > 0) then
--         return 'The snapshot names a client.';
--       end if;
--       if cardinality(parts) > 1 and parts <@ ft
--          and free ~ ('(^|[^[:alpha:]])' || array_to_string(parts, '(([^[:alpha:]]{1,3}(and|the|for|ltd|inc|llc|plc)){0,2}[^[:alpha:]]{1,3})') || '($|[^[:alpha:]])') then
--         return 'The snapshot names a client.';
--       end if;
--     end loop;
--
--     -- 6. People are labels unless People is on: no token of a person's name (first name, surname, any part) in free text, so a name
--     -- token can't survive next to a "Team member N" label either; and no Han, Kana or Hangul part of a name anywhere in it.
--     if not show_people and (
--          exists (select 1 from regexp_split_to_table(free, '[^[:alpha:]]+') as w (tok)
--                   where w.tok in (select private.share_name_tokens(ws, 'person')))
--       or exists (select 1 from private.share_name_tokens(ws, 'script') as s (part) where strpos(free, s.part) > 0)
--       -- A scenario link's hire: a D1 change keeps no `params.name` (a candidate's name; the visitor reads "New <role>").
--       or (kind = 'scenario' and exists (
--             select 1 from jsonb_array_elements(snap -> 'scenarios') s, jsonb_array_elements(s -> 'changes') c
--             where c ->> 'lever' = 'D1' and c ? 'params' and (c -> 'params') ? 'name'))) then
--       return 'The snapshot names a person.';
--     end if;
--
--     -- 7. Financials off: no costs, margins or overhead. A number stored as a string counts; so does a role-rate change inside a
--     -- scenario or a solution's lever changes (the visitor's browser would price work at the real rate), and an overheads change; so does money in text.
--     if not show_financials and (
--          jsonb_path_exists(snap, 'lax $.**.default_cost_rate ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
--       or jsonb_path_exists(snap, 'lax $.**.margin ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
--       or jsonb_path_exists(snap, 'lax $.**.cost_override ? (@ != null)')
--       or jsonb_path_exists(snap, 'lax $.**.overhead_monthly')
--       or jsonb_path_exists(snap, 'lax $.**.target_margin')
--       -- 5b review: an overheads change too (a Sandbox scenario's whole-run C2 change is the patch `finances.overhead_monthly`).
--       or jsonb_path_exists(snap, 'lax $.**.path ? (@ like_regex "(cost_rate|overhead_monthly)$")')
--       -- A scenario link's role-cost and overheads changes (lever C1, C2): an amount of cost. They are dropped, and counted in hiddenCostChanges.
--       or (kind = 'scenario' and exists (
--             select 1 from jsonb_array_elements(snap -> 'scenarios') s, jsonb_array_elements(s -> 'changes') c
--             where c ->> 'lever' in ('C1', 'C2')))
--       or everything ~* ('[£$€¥₹][[:space:]]*[0-9]|[0-9][[:space:]]*[£€¥₹]'
--         || '|(^|[^a-z0-9])(gbp|usd|eur|aud|nzd|cad|rs\.?)[[:space:]/-]*[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?([^a-z0-9]|$)'
--         || '|(^|[^a-z0-9])[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?[[:space:]]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'  -- B3 follow-up
--         -- A hyphen or a slash before the code: not the end of a date, a version or a standard's, product's or document's number  -- B3 follow-up
--         -- (`shareMoneyRegex` in packages/db/src/money.ts has the same rule and words; a test keeps them equal). An amount or a range  -- B3 follow-up
--         -- not glued to a letter, a digit, or a digit and . , - or /; a plain number not after a standard's word (iso 4217), and  -- B3 follow-up
--         -- with 1 or 2 digits not after a version word (windows 10, v 1.2), nor, when whole, after a place word (page 3):  -- B3 follow-up
--         || '|(?<![a-z0-9])(?<![0-9][.,])(?<![0-9][/-])'  -- B3 follow-up
--         || '(([0-9]+(\.[0-9]+)?e[+-]?[0-9]+|[0-9]{1,3}( [0-9]{3})+([.,][0-9]+)?|[0-9]{1,3}([.,][0-9]{3})+([.,][0-9]+)?|[0-9]+([.,][0-9]+)?)([[:space:]]*(k|m|bn))?[[:space:]]*[/-][[:space:]]*)?'  -- B3 follow-up
--         || '([0-9]+(\.[0-9]+)?e[+-]?[0-9]+|[0-9]{1,3}( [0-9]{3})+([.,][0-9]+)?|([0-9]{1,3}([.,][0-9]{3})+([.,][0-9]+)?)[.,]?|(?<!(^|[^a-z])(iso|rfc)[[:space:]]+)[0-9]{3,}([.,][0-9]+)?[.,]?'  -- B3 follow-up
--         || '|(?<!(^|[^a-z])(iso|rfc)[[:space:]]+)(?<!(^|[^a-z])(windows|win|ios|android|macos|office|version|ver|v|build|release|rev|revision)[[:space:]]+)(?<!(^|[^a-z])(page|pages|p|pp|chapter|ch|section|sec|clause|para|paragraph|article|appendix|annex|row|column|col|table|figure|fig|vol|volume|part|phase|sprint|ticket|slide)[[:space:]]+)[0-9]{1,2}[.,]?'  -- B3 follow-up
--         || '|(?<!(^|[^a-z])(iso|rfc)[[:space:]]+)(?<!(^|[^a-z])(windows|win|ios|android|macos|office|version|ver|v|build|release|rev|revision)[[:space:]]+)[0-9]{1,2}[.,][0-9]+[.,]?)'  -- B3 follow-up
--         || '([[:space:]]*(k|m|bn))?[[:space:]]*[/-][[:space:]]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'  -- B3 follow-up
--         -- ... or glued to a digit and a hyphen or slash when it can't be a date's last part (a range's second amount):  -- B3 follow-up
--         || '|(?<=[0-9][/-])([0-9]+(\.[0-9]+)?e[+-]?[0-9]+|[0-9]{1,3}( [0-9]{3})+([.,][0-9]+)?|([0-9]{1,3}([.,][0-9]{3})+([.,][0-9]+)?)[.,]?|[0-9]{3,}([.,][0-9]+)?[.,]?)([[:space:]]*(k|m|bn))?[[:space:]]*[/-][[:space:]]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'  -- B3 follow-up
--         || '|[0-9]([[:space:]]*(k|m|bn))?[[:space:]]*(pounds?|dollars?|euros?|quid|sterling)([^a-z]|$)')) then
--       return 'The snapshot contains costs or margins.';
--     end if;
--
--     return null;
--   end;
--   $function$;
--
--   CREATE OR REPLACE FUNCTION private.share_links_before_write()
--    RETURNS trigger
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO ''
--   AS $function$
--   declare
--     ok boolean;
--     problem text;
--   begin
--     -- A foreign-key action (a deleted user nulls created_by / revoked_by) runs one trigger level deeper than a direct write.
--     -- It may change those two columns to null and nothing else.
--     if tg_op = 'UPDATE' and pg_catalog.pg_trigger_depth() > 1
--        and (to_jsonb(new) - 'created_by' - 'revoked_by') = (to_jsonb(old) - 'created_by' - 'revoked_by')
--        and (new.created_by is null or new.created_by = old.created_by)
--        and (new.revoked_by is null or new.revoked_by = old.revoked_by) then
--       return new;
--     end if;
--
--     -- 1. No API tokens (the MCP server): share links are made in the app. `open_share_link` only counts opens on a row, and
--     -- an API-token caller may open a link like anyone, so a counter-only update is not refused.
--     if coalesce(auth.jwt(), '{}') ? 'api_token_id'
--        and (tg_op = 'INSERT' or new.snapshot is distinct from old.snapshot or new.label is distinct from old.label
--             or new.revoked_at is distinct from old.revoked_at or new.engine_version is distinct from old.engine_version) then
--       raise exception 'Share links are made in the app.' using errcode = '42501';
--     end if;
--
--     if tg_op = 'INSERT' then
--       -- 2. Stamp the caller; nothing the caller sends for these counts.
--       new.created_by := auth.uid();
--       new.created_at := now();
--       new.snapshot_at := now();
--       new.opens := 0;
--       new.last_opened_at := null;
--       new.revoked_at := null;
--       new.revoked_by := null;
--       -- B4 begin
--       -- A play link shares a process, and its snapshot says which levers the workspace hides (the kinds are checked by
--       -- share_snapshot_problem, below).
--       if new.mode = 'play' and (new.kind <> 'process' or jsonb_typeof(new.snapshot -> 'hiddenLevers') is distinct from 'array') then
--         raise exception 'Only a process can be shared for trying changes.' using errcode = '22023';
--       end if;
--       -- B4 end
--       if new.expires_at is not null and new.expires_at <= now() then
--         raise exception 'The end date must be in the future.' using errcode = '22023';
--       end if;
--       ok := case new.kind
--         when 'overview' then true
--         when 'process' then exists (
--           select 1 from public.processes p
--           where p.id = new.target_id and p.workspace_id = new.workspace_id and p.live_revision_id is not null
--             and p.archived_at is null and not p.is_company)
--         when 'issue' then exists (
--           select 1 from public.issues i where i.id = new.target_id and i.workspace_id = new.workspace_id)
--         when 'solution' then exists (
--           select 1 from public.solutions s where s.id = new.target_id and s.workspace_id = new.workspace_id)
--         -- 5b: a saved Sandbox scenario of this workspace.
--         when 'scenario' then exists (
--           select 1 from public.sandbox_scenarios s where s.id = new.target_id and s.workspace_id = new.workspace_id)
--         else false end;
--       if not ok then
--         raise exception 'That isn''t in this workspace.' using errcode = '22023';
--       end if;
--       -- An issue or a solution of an archived process shows that process (every process an issue is on, its own or linked): refused
--       -- like the process itself, with its own message.
--       if new.kind in ('issue', 'solution') and (
--            (new.kind = 'issue' and exists (
--               select 1 from public.processes p
--               where p.workspace_id = new.workspace_id and p.archived_at is not null
--                 and (p.id = (select i.process_id from public.issues i where i.id = new.target_id)
--                   or p.id in (select l.process_id from public.issue_links l where l.issue_id = new.target_id and l.process_id is not null))))
--         or (new.kind = 'solution' and exists (
--               select 1 from public.solutions s join public.processes p on p.id = s.process_id
--               where s.id = new.target_id and p.archived_at is not null))) then
--         raise exception 'An archived process can''t be shared. Restore it first.' using errcode = '22023';
--       end if;
--     else
--       -- 3. Update. A revoked link stays revoked: no change at all.
--       if old.revoked_at is not null then
--         raise exception 'This link was turned off.' using errcode = '22023';
--       end if;
--       if new.workspace_id is distinct from old.workspace_id or new.token_hash is distinct from old.token_hash
--          or new.kind is distinct from old.kind or new.target_id is distinct from old.target_id
--          or new.mode is distinct from old.mode or new.show_people is distinct from old.show_people
--          or new.show_financials is distinct from old.show_financials or new.allowed_emails is distinct from old.allowed_emails
--          or new.expires_at is distinct from old.expires_at or new.created_by is distinct from old.created_by
--          or new.created_at is distinct from old.created_at then
--         raise exception 'A link''s settings can''t be changed. Make a new link.' using errcode = '22023';
--       end if;
--       -- B4 begin
--       -- A play link's new snapshot must still carry the list (Update copy rebuilds it through loadShareData, which always adds it).
--       if new.mode = 'play' and new.snapshot is distinct from old.snapshot
--          and jsonb_typeof(new.snapshot -> 'hiddenLevers') is distinct from 'array' then
--         raise exception 'Only a process can be shared for trying changes.' using errcode = '22023';
--       end if;
--       -- B4 end
--       if new.revoked_at is not null then
--         new.revoked_at := now();
--         new.revoked_by := auth.uid();
--       else
--         new.revoked_by := old.revoked_by;
--       end if;
--       if new.snapshot is distinct from old.snapshot then
--         new.snapshot_at := now();
--       else
--         new.snapshot_at := old.snapshot_at;
--       end if;
--     end if;
--
--     -- 4. The leak check: on insert and whenever the snapshot changes.
--     if tg_op = 'INSERT' or new.snapshot is distinct from old.snapshot then
--       problem := private.share_snapshot_problem(new.workspace_id, new.kind, new.snapshot, new.show_people, new.show_financials);
--       if problem is not null then
--         raise exception '%', problem using errcode = '23514';
--       end if;
--     end if;
--     return new;
--   end;
--   $function$;
--
--   CREATE OR REPLACE FUNCTION private.share_links_no_speeds()
--    RETURNS trigger
--    LANGUAGE plpgsql
--    SET search_path TO ''
--   AS $function$
--   begin
--     -- C6: no link carries anyone's per-person times, whatever its toggles (D20: only the person and owners and editors see them).
--     if new.snapshot is not null and (
--          jsonb_path_exists(new.snapshot, 'lax $.**.personCapacityFactors[*]')
--       or jsonb_path_exists(new.snapshot, 'lax $.**.person_capacity_factors[*]')
--       or jsonb_path_exists(new.snapshot, 'lax $.**.capacityFactor')) then
--       raise exception 'The snapshot contains per-person times.' using errcode = '23514';
--     end if;
--     return new;
--   end;
--   $function$;
--
--   CREATE OR REPLACE FUNCTION public.share_team_capacity(ws uuid, show_people boolean)
--    RETURNS jsonb
--    LANGUAGE plpgsql
--    STABLE SECURITY DEFINER
--    SET search_path TO ''
--   AS $function$
--   declare
--     everyone boolean;
--     result jsonb;
--   begin
--     -- `can_edit_workspace` is null (not false) for someone with no membership, and `not null` is null: coalesce it.
--     if ws is null or show_people is null or not coalesce(public.can_edit_workspace(ws), false) then
--       raise exception 'share_team_capacity: you cannot make share links in this workspace' using errcode = '42501';
--     end if;
--     everyone := show_people;
--
--     with p as (
--       select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.active, pe.start_date, pe.end_date,
--              row_number() over (order by pe.created_at, pe.id) as n
--       from public.people pe where pe.workspace_id = ws
--     ),
--     shown as (
--       select p.*, case when everyone then p.name else 'Team member ' || p.n end as shown_name
--       from p
--     )
--     select jsonb_build_object(
--       'sees_everyone', everyone,
--       'own_person_id', null,
--       'people', coalesce((select jsonb_agg(jsonb_build_object(
--           'id', s.id, 'workspace_id', s.workspace_id, 'name', s.shown_name, 'fte', s.fte,
--           'capacity_hours_week', s.capacity_hours_week, 'cost_rate', null, 'active', s.active,
--           'start_date', s.start_date, 'end_date', s.end_date, 'provenance', '{}'::jsonb)
--         order by case when everyone then s.name end, s.n) from shown s), '[]'::jsonb),
--       'person_roles', coalesce((select jsonb_agg(jsonb_build_object('person_id', r.person_id, 'role_id', r.role_id,
--           'workspace_id', r.workspace_id) order by r.person_id, r.role_id)
--         from public.person_roles r where r.workspace_id = ws), '[]'::jsonb),
--       'person_skills', coalesce((select jsonb_agg(jsonb_build_object('person_id', k.person_id, 'step_id', k.step_id,
--           'workspace_id', k.workspace_id) order by k.person_id, k.step_id)
--         from public.person_skills k where k.workspace_id = ws), '[]'::jsonb),
--       'person_leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id,
--           'workspace_id', l.workspace_id, 'start_date', l.start_date, 'end_date', l.end_date)
--           order by l.person_id, l.start_date, l.id)
--         from public.person_leave l where l.workspace_id = ws), '[]'::jsonb),
--       'client_assignments', coalesce((select jsonb_agg(jsonb_build_object('client_id', a.client_id, 'role_id', a.role_id,
--           'person_id', a.person_id, 'workspace_id', a.workspace_id) order by a.client_id, a.role_id)
--         from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb)
--     ) into result;
--     return result;
--   end;
--   $function$;
--
--   CREATE OR REPLACE FUNCTION public.open_share_link(token text)
--    RETURNS jsonb
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO ''
--   AS $function$
--   declare
--     l public.share_links;
--     e text;
--   begin
--     if token is null or token !~ '^[A-Za-z0-9_-]{43}$' then
--       return null;
--     end if;
--     select * into l from public.share_links s
--       where s.token_hash = encode(pg_catalog.sha256(pg_catalog.convert_to(token, 'UTF8')), 'hex')
--         and s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and s.mode in ('view', 'play');  -- B4
--     if not found then
--       return null;
--     end if;
--     if l.show_people or l.show_financials then
--       if auth.uid() is null then
--         return jsonb_build_object('status', 'sign_in');
--       end if;
--       -- A confirmed address AND a Google identity whose own email is that address (any case): a password sign-up with a listed
--       -- address is not the person it names, and neither is an account that links an unrelated Google identity to it.
--       select lower(u.email) into e from auth.users u
--         where u.id = auth.uid() and u.email_confirmed_at is not null
--           and exists (select 1 from auth.identities i
--                        where i.user_id = u.id and i.provider = 'google'
--                          and lower(i.identity_data ->> 'email') = lower(u.email));
--       if e is null or not (e = any (l.allowed_emails)) then
--         return jsonb_build_object('status', 'not_allowed');
--       end if;
--     end if;
--     update public.share_links set opens = opens + 1, last_opened_at = now() where id = l.id;
--     return jsonb_build_object('status', 'ok', 'kind', l.kind, 'mode', l.mode, 'show_people', l.show_people,
--       'show_financials', l.show_financials, 'snapshot_at', l.snapshot_at, 'expires_at', l.expires_at, 'snapshot', l.snapshot);
--   end;
--   $function$;
--   revoke all on function private.share_unpct(text), private.share_norm(text), private.share_strings(jsonb), private.share_name_tokens(uuid,text), private.lever_kind_ids(), private.share_snapshot_problem(uuid,text,jsonb,boolean,boolean), private.share_links_no_speeds() from public;
--   grant execute on function public.share_team_capacity(uuid, boolean) to authenticated;
--   grant execute on function public.open_share_link(text) to anon, authenticated;
-- 4. The triggers:
--   CREATE TRIGGER audit_mcp AFTER INSERT OR DELETE OR UPDATE ON public.first_principles FOR EACH ROW EXECUTE FUNCTION private.audit_mcp_write();
--   CREATE TRIGGER edit_drafts_only BEFORE INSERT OR DELETE OR UPDATE ON public.first_principles FOR EACH ROW EXECUTE FUNCTION public.edit_drafts_only();
--   CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.first_principles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
--   CREATE TRIGGER share_links_before_write BEFORE INSERT OR UPDATE ON public.share_links FOR EACH ROW EXECUTE FUNCTION private.share_links_before_write();
--   CREATE TRIGGER share_links_no_speeds BEFORE INSERT OR UPDATE OF snapshot ON public.share_links FOR EACH ROW EXECUTE FUNCTION private.share_links_no_speeds();
-- 5. The three functions this migration replaces, as they stood before it:
--   CREATE OR REPLACE FUNCTION private.may_sign_in(p_email text, p_email_verified boolean, p_bootstrap_admins text[] DEFAULT '{}'::text[])
--    RETURNS text
--    LANGUAGE plpgsql
--    STABLE SECURITY DEFINER
--    SET search_path TO ''
--   AS $function$
--   declare
--     e text := lower(btrim(coalesce(p_email, '')));
--     r text := private.deployment_role(p_email, p_email_verified, p_bootstrap_admins);
--   begin
--     if r is not null then
--       return r;
--     end if;
--     if not coalesce(p_email_verified, false) or e = '' then
--       return null;
--     end if;
--     -- Live and restricted, exactly as open_share_link reads it (allowed_emails are stored lower-case). Both modes: a restricted
--     -- play link asks for the same sign-in.
--     if exists (
--       select 1 from public.share_links s
--       where (s.show_people or s.show_financials)
--         and s.revoked_at is null
--         and (s.expires_at is null or s.expires_at > now())
--         and e = any (s.allowed_emails)
--     ) then
--       return 'guest';
--     end if;
--     return null;
--   end;
--   $function$;
--
--   CREATE OR REPLACE FUNCTION public.import_process_bundle(p_workspace uuid, p_nodes jsonb, p_adopt jsonb DEFAULT '[]'::jsonb, p_extras jsonb DEFAULT '{}'::jsonb)
--    RETURNS jsonb
--    LANGUAGE plpgsql
--    SET search_path TO ''
--   AS $function$
--   declare
--     extras jsonb := coalesce(nullif(p_extras, 'null'::jsonb), '{}');
--     srcs jsonb;
--     fp jsonb;
--     s jsonb;
--     top uuid;
--     made jsonb;
--     rev uuid;
--     fresh uuid;
--     ref uuid;
--     fresh_ids uuid[] := '{}';
--     nodes_txt text;
--     n_sources integer;
--     body_chars bigint;
--     wrote_fp boolean := false;
--   begin
--     if p_workspace is null or jsonb_typeof(p_nodes) is distinct from 'array' or jsonb_array_length(p_nodes) < 1 then
--       raise exception 'import_process_bundle: p_nodes must be an array of processes' using errcode = '22023';
--     end if;
--     if jsonb_typeof(extras) is distinct from 'object' then
--       raise exception 'import_process_bundle: p_extras must be an object' using errcode = '22023';
--     end if;
--     -- A section that is JSON null is a section that is left out.
--     srcs := coalesce(nullif(extras -> 'sources', 'null'::jsonb), '[]');
--     fp := nullif(extras -> 'first_principles', 'null'::jsonb);
--     if jsonb_typeof(srcs) is distinct from 'array' or (fp is not null and jsonb_typeof(fp) is distinct from 'object') then
--       raise exception 'import_process_bundle: sources must be an array and first_principles an object' using errcode = '22023';
--     end if;
--     n_sources := jsonb_array_length(srcs);
--     if n_sources > 50 then
--       raise exception 'import_process_bundle: at most 50 sources in one import' using errcode = '22023';
--     end if;
--     select coalesce(sum(char_length(coalesce(x ->> 'body', ''))), 0) into body_chars from jsonb_array_elements(srcs) x;
--     if body_chars > 2000000 then
--       raise exception 'The sources'' text is too long: % characters in all, and one upload takes at most 2,000,000. Leave the text out of the longest sources.', body_chars using errcode = '22023';
--     end if;
--     top := (p_nodes -> 0 ->> 'id')::uuid;
--     nodes_txt := p_nodes::text;
--
--     -- Sources first: the steps that cite them are linked to them as they are written. Each gets an id made here; the file's
--     -- placeholder (`ref`) is replaced by it wherever the file cites the source.
--     for s in select value from jsonb_array_elements(srcs) loop
--       ref := (s ->> 'ref')::uuid;
--       fresh := gen_random_uuid();
--       insert into public.sources (id, workspace_id, kind, title, speakers, recorded_at, body)
--       values (fresh, p_workspace, coalesce(s ->> 'kind', 'transcript'), s ->> 'title',
--         coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(s -> 'speakers') = 'array' then s -> 'speakers' else '[]'::jsonb end)), '{}'),
--         nullif(s ->> 'recorded_at', '')::date, nullif(s ->> 'body', ''));
--       fresh_ids := fresh_ids || fresh;
--       nodes_txt := replace(nodes_txt, ref::text, fresh::text);
--     end loop;
--
--     -- The process, its draft, its steps and edges (and any child processes), as the atomic import writes them.
--     made := public.import_new_process(p_workspace, nodes_txt::jsonb, p_adopt);
--     rev := (made -> 0 ->> 'revision_id')::uuid;
--
--     -- Every source of the file is evidence for the process it came with.
--     insert into public.source_links (workspace_id, source_id, kind, process_id)
--     select p_workspace, f, 'process', top from unnest(fresh_ids) f
--     on conflict do nothing;
--
--     if fp is not null then
--       -- A key the caller leaves out is the column's default (jsonb_populate_record gives null, which the columns refuse).
--       insert into public.first_principles (workspace_id, process_id, revision_id, job_who, job_progress, job_situation, job_done, statements, requirements, deletes, improvements, why_problem, why_chain, root_cause, measures)
--       select p_workspace, top, rev, coalesce(r.job_who, ''), coalesce(r.job_progress, ''), coalesce(r.job_situation, ''), coalesce(r.job_done, ''),
--         coalesce(r.statements, '[]'::jsonb), coalesce(r.requirements, '[]'::jsonb), coalesce(r.deletes, '[]'::jsonb), coalesce(r.improvements, '[]'::jsonb),
--         coalesce(r.why_problem, ''), coalesce(r.why_chain, '[]'::jsonb), coalesce(r.root_cause, ''), coalesce(r.measures, '[]'::jsonb)
--       from jsonb_populate_record(null::public.first_principles, fp) r;
--       wrote_fp := true;
--     end if;
--
--     return jsonb_build_object('processes', made, 'sources', n_sources, 'first_principles', wrote_fp);
--   end;
--   $function$;
--
--   CREATE OR REPLACE FUNCTION public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text DEFAULT NULL::text)
--    RETURNS jsonb
--    LANGUAGE plpgsql
--    SET search_path TO ''
--    SET statement_timeout TO '40s'
--   AS $function$
--   declare
--     -- The columns the restore accepts for each plan section: the same lists as IMPORT_COLUMNS (packages/db/src/workspace-import.ts).
--     -- Everything else in a row is ignored; `workspace_id`, `created_by`, `updated_at` and every `*_by` are never read from the plan.
--     -- #228: person_capacity_factors is in this list, in ref_cols, in sections and in list_sections.
--     allow constant jsonb := '{"roles":["id","name","color","default_cost_rate","headcount","ongoing_hours_per_client_week","active","provenance","created_at"],"people":["id","name","active","capacity_hours_week","cost_rate","end_date","fte","notes","start_date","provenance","created_at"],"person_roles":["person_id","role_id","created_at"],"person_leave":["id","person_id","start_date","end_date","note","created_at"],"lead_sources":["id","name","conversion_to_qualified","volume_week","provenance","created_at"],"seasonality":["id","month","multiplier","provenance","created_at"],"demand_settings":["growth_monthly","provenance","created_at"],"churn_drivers":["id","name","description","driver","enabled","example","month","value","weight","chance","effect","effect_months","provenance","created_at"],"market_conditions":["id","name","churn","conv","cycle","hire","leads","pay","price","created_at"],"market_schedule":["id","condition_id","from_month","to_month","created_at"],"lever_settings":["hidden","created_at"],"analysis_rules":["settings","created_at"],"clients":["id","name","active","health","mrr","notes","start_date","provenance","created_at"],"sources":["id","kind","title","body","recorded_at","speakers","created_at"],"processes":["id","parent_process_id","name","kind","entity_name","description"],"steps":["id","assumption","child_process_id","conflict","cost_override","current_wip","dropoff_benchmark","expected_wait_hours","entry_step_id","kind","lost_per_day_waiting","name","notes","outcome","parent_step_id","person_id","provenance","purpose","replaced_by","rework_rate","rework_to_step_id","role_id","sla_hours","target_cycle_hours","tool","wait_dist","wait_hours","wait_params","work_dist","work_hours","work_params","x","y"],"edges":["id","condition_tag","from_step_id","label","probability","to_step_id"],"first_principles":["deletes","improvements","job_done","job_progress","job_situation","job_who","measures","requirements","root_cause","statements","why_chain","why_problem"],"sandbox_scenarios":["id","parent_id","name","description","changes","horizon_months","start_date","created_at"],"blocks":["id","name","description","type","steps","created_at"],"issues":["id","client_id","created_at","detected_key","evidence","evidence_metrics","evidence_sources","owner_person_id","person_id","process_id","resolution","resolution_note","resolved_how","role_id","scenario_id","severity","source","status","step_id","target_goal","target_measure","target_now","title","type"],"services":["id","name","active","churn_health_sensitivity","churn_monthly_base","entry_process_id","fallback_ongoing_load","margin","mix_share","path_tags","price","price_high","price_low","pricing_model","tenure_months","provenance","created_at"],"service_servicing":["id","process_id","service_id","recurrence","sla_hours","provenance","created_at"],"client_groups":["id","service_id","client_count","churn_monthly","fee","starting_health","stay_months","provenance","created_at"],"client_services":["client_id","service_id","start_date","created_at"],"client_assignments":["client_id","role_id","person_id","created_at"],"person_skills":["person_id","step_id","efficiency","provenance","created_at"],"person_capacity_factors":["person_id","step_id","factor","provenance"],"source_links":["id","insight_key","issue_id","kind","process_id","source_id","step_id"]}'::jsonb;
--     -- The reference columns of the flat sections (IMPORT_REFS) and of steps (IMPORT_STEP_REFS). Every section that has an `id`
--     -- column in `allow` is checked on `id` too.
--     -- #228
--     ref_cols constant text[] := array['person_roles.person_id','person_roles.role_id','person_leave.person_id','services.entry_process_id','service_servicing.service_id','service_servicing.process_id','client_groups.service_id','client_services.client_id','client_services.service_id','client_assignments.client_id','client_assignments.role_id','client_assignments.person_id','person_skills.person_id','person_skills.step_id','sandbox_scenarios.parent_id','issues.client_id','issues.owner_person_id','issues.person_id','issues.process_id','issues.role_id','issues.scenario_id','issues.step_id','source_links.source_id','source_links.issue_id','source_links.process_id','source_links.step_id','market_schedule.condition_id','person_capacity_factors.person_id','person_capacity_factors.step_id'];
--     step_ref_cols constant text[] := array['parent_step_id','entry_step_id','rework_to_step_id','person_id','role_id','child_process_id'];
--     -- The order the sections are written in.
--     -- #228
--     sections constant text[] := array['settings','roles','people','person_roles','person_leave','lead_sources','seasonality','demand_settings','churn_drivers','market_conditions','market_schedule','lever_settings','analysis_rules','clients','sources','processes','sandbox_scenarios','blocks','issues','steps','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','source_links','archive','log'];
--     -- #228
--     list_sections constant text[] := array['roles','people','person_roles','person_leave','lead_sources','seasonality','churn_drivers','market_conditions','market_schedule','clients','sources','processes','sandbox_scenarios','blocks','issues','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','source_links'];
--     one_sections constant text[] := array['settings','demand_settings','lever_settings','analysis_rules'];
--     placeholder constant text := '00000000-0000-4000-8000-';
--     placeholder_re constant text := '^00000000-0000-4000-8000-[0-9a-f]{12}$';
--     max_plan_chars constant integer := 19660800;
--
--     pl jsonb;
--     txt text;
--     prefix text;
--     label text := left(nullif(btrim(coalesce(p_label, '')), ''), 300);
--     sec text;
--     col text;
--     tbl text;
--     rows jsonb;
--     node jsonb;
--     sc jsonb;
--     cols text;
--     sets text;
--     n integer;
--     total integer;
--     existing uuid;
--     skip_ids uuid[] := '{}';
--     skipped jsonb := '{}';
--     counts jsonb := '{}';
--     proc uuid;
--     rev uuid;
--     draft jsonb;
--     revs jsonb := '{}';
--     made jsonb := '[]';
--     arch uuid[] := '{}';
--     step_total integer := 0;
--     edge_total integer := 0;
--     settings_result text := 'none';
--     what text;
--     has_rows boolean;
--     bad integer;
--     chars bigint;
--   begin
--     -- 1. Who. Before the plan is read, so a refusal says nothing about it.
--     if coalesce(auth.jwt(), '{}'::jsonb) ? 'api_token_id' then
--       raise exception 'Backups are restored in the app.' using errcode = '42501';
--     end if;
--     if p_workspace is null or not coalesce(public.can_edit_workspace(p_workspace), false) then
--       raise exception 'Only Agency admins and the Owner can restore a backup.' using errcode = '42501';
--     end if;
--
--     -- 2. Shape and limits.
--     if p_plan is null or jsonb_typeof(p_plan) is distinct from 'object' or p_plan ->> 'format' is distinct from 'transpera-workspace-import/1' then
--       raise exception 'import_workspace_bundle: p_plan is not a transpera-workspace-import/1 plan' using errcode = '22023';
--     end if;
--     -- #228: a plan made before per-person times were restored (an app deployed before this migration) has no such section:
--     -- it restores as an empty one.
--     if not p_plan ? 'person_capacity_factors' then
--       p_plan := p_plan || '{"person_capacity_factors": []}'::jsonb;
--     end if;
--     if char_length(p_plan::text) > max_plan_chars then
--       raise exception 'import_workspace_bundle: the plan is too big (at most 15 MB)' using errcode = '22023';
--     end if;
--     foreach sec in array list_sections loop
--       if jsonb_typeof(p_plan -> sec) is distinct from 'array' then
--         raise exception 'import_workspace_bundle: % must be a list', sec using errcode = '22023';
--       end if;
--       if exists (select 1 from jsonb_array_elements(p_plan -> sec) e where jsonb_typeof(e.value) is distinct from 'object') then
--         raise exception 'import_workspace_bundle: every row of % must be an object', sec using errcode = '22023';
--       end if;
--     end loop;
--     foreach sec in array one_sections loop
--       if p_plan -> sec is not null and jsonb_typeof(p_plan -> sec) not in ('object', 'null') then
--         raise exception 'import_workspace_bundle: % must be an object or null', sec using errcode = '22023';
--       end if;
--     end loop;
--     if exists (
--       select 1 from jsonb_array_elements(p_plan -> 'processes') p
--       where jsonb_typeof(p.value -> 'steps') is distinct from 'array' or jsonb_typeof(p.value -> 'edges') is distinct from 'array'
--         or exists (select 1 from jsonb_array_elements(p.value -> 'steps') e where jsonb_typeof(e.value) is distinct from 'object')
--         or exists (select 1 from jsonb_array_elements(p.value -> 'edges') e where jsonb_typeof(e.value) is distinct from 'object')
--         or (p.value -> 'first_principles' is not null and jsonb_typeof(p.value -> 'first_principles') not in ('object', 'null'))
--         or (p.value -> 'layout' is not null and jsonb_typeof(p.value -> 'layout') not in ('object', 'null'))
--     ) then
--       raise exception 'import_workspace_bundle: every process needs lists of steps and edges' using errcode = '22023';
--     end if;
--     select coalesce(sum(jsonb_array_length(p.value -> 'steps')), 0), coalesce(sum(jsonb_array_length(p.value -> 'edges')), 0)
--       into step_total, edge_total from jsonb_array_elements(p_plan -> 'processes') p;
--     select coalesce(sum(char_length(coalesce(s.value ->> 'body', ''))), 0) into chars from jsonb_array_elements(p_plan -> 'sources') s;
--     if jsonb_array_length(p_plan -> 'processes') > 150 or step_total > 1500 or edge_total > 3000
--       or jsonb_array_length(p_plan -> 'sources') > 600 or chars > 4500000
--       or jsonb_array_length(p_plan -> 'issues') > 900 or jsonb_array_length(p_plan -> 'people') > 1500
--       or jsonb_array_length(p_plan -> 'clients') > 3000 or jsonb_array_length(p_plan -> 'sandbox_scenarios') > 900
--       or jsonb_array_length(p_plan -> 'blocks') > 900
--       or jsonb_array_length(p_plan -> 'person_roles') > 1200 or jsonb_array_length(p_plan -> 'person_skills') > 3000
--       or jsonb_array_length(p_plan -> 'client_assignments') > 1200 or jsonb_array_length(p_plan -> 'source_links') > 3000
--       or jsonb_array_length(p_plan -> 'client_services') > 3000 or jsonb_array_length(p_plan -> 'person_leave') > 1500
--       -- #228
--       or jsonb_array_length(p_plan -> 'person_capacity_factors') > 3000
--       or jsonb_array_length(p_plan -> 'lead_sources') + jsonb_array_length(p_plan -> 'seasonality') + jsonb_array_length(p_plan -> 'churn_drivers')
--         + jsonb_array_length(p_plan -> 'market_conditions') + jsonb_array_length(p_plan -> 'market_schedule') + jsonb_array_length(p_plan -> 'services')
--         + jsonb_array_length(p_plan -> 'service_servicing') + jsonb_array_length(p_plan -> 'client_groups') > 1500 then
--       -- #228
--       raise exception 'import_workspace_bundle: the plan is over a limit (150 processes, 1500 steps, 3000 edges, 600 sources of 4,500,000 characters, 900 issues, 1500 people, 3000 clients, 900 scenarios, 900 blocks, 1200 role assignments, 3000 skills, 1200 client assignments, 3000 source links, 3000 client services, 1500 leave entries, 1500 other company settings rows, 3000 per-person times)' using errcode = '22023';
--     end if;
--     -- A scenario without an id would make the replacement of a skipped one (below) return null, and the restore would write nothing and say it worked.
--     if exists (select 1 from jsonb_array_elements(p_plan -> 'sandbox_scenarios') s where jsonb_typeof(s.value -> 'id') is distinct from 'string') then
--       raise exception 'import_workspace_bundle: every scenario needs an id' using errcode = '22023';
--     end if;
--
--     -- 3. Lock: one restore (or upload) at a time per workspace.
--     if not pg_try_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || p_workspace::text, 0)) then
--       raise exception 'A restore into this workspace is already running.' using errcode = '55P03', hint = 'busy';
--     end if;
--     perform pg_advisory_xact_lock(hashtextextended('import_new_process:' || p_workspace::text, 0));
--
--     -- 4. Empty.
--     for tbl, col in
--       select t.a, t.b from (values
--         ('processes', 'not is_company'), ('roles', 'true'), ('people', 'true'), ('services', 'true'), ('client_groups', 'true'),
--         ('clients', 'true'), ('lead_sources', 'true'), ('churn_drivers', 'true'), ('market_schedule', 'true'), ('issues', 'true'),
--         ('sources', 'true'), ('blocks', 'true'), ('solutions', 'true'),
--         ('market_conditions', 'preset is null')
--       ) as t(a, b)
--     loop
--       execute format('select exists (select 1 from public.%I where workspace_id = $1 and %s)', tbl, col) into has_rows using p_workspace;
--       if has_rows then
--         what := replace(tbl, '_', ' ');
--         exit;
--       end if;
--     end loop;
--     if what is null and exists (
--       select 1 from public.sandbox_scenarios s where s.workspace_id = p_workspace
--         and not exists (select 1 from private.sandbox_library() l where l.name = s.name and private.sandbox_changes_shape(l.changes) = private.sandbox_changes_shape(s.changes))
--     ) then
--       what := 'scenarios of its own';
--     end if;
--     if what is not null then
--       raise exception 'This workspace isn''t empty: it already has %. Backups restore only into a new, empty workspace.', what
--         using errcode = '23514', hint = 'not_empty';
--     end if;
--
--     -- 5. Ids: every id and reference column of the plan holds a placeholder (or null) before anything is replaced.
--     foreach sec in array list_sections loop
--       if sec = 'processes' then continue; end if;
--       for col in
--         select c from (
--           select 'id' as c where allow -> sec ? 'id'
--           union all select split_part(r, '.', 2) from unnest(ref_cols) r where split_part(r, '.', 1) = sec
--         ) q
--       loop
--         select count(*) into bad from jsonb_array_elements(p_plan -> sec) r
--         where r.value -> col is not null and jsonb_typeof(r.value -> col) <> 'null'
--           and (jsonb_typeof(r.value -> col) <> 'string' or (r.value ->> col) !~ placeholder_re);
--         if bad > 0 then
--           raise exception 'import_workspace_bundle: % holds an id that is not a placeholder in %', col, sec using errcode = '22023';
--         end if;
--       end loop;
--     end loop;
--     select count(*) into bad from jsonb_array_elements(p_plan -> 'issues') i
--     where exists (
--         select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'owner_ids') = 'array' then i.value -> 'owner_ids' else '[]'::jsonb end) x
--         where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ placeholder_re)
--       or exists (
--         select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'source_ids') = 'array' then i.value -> 'source_ids' else '[]'::jsonb end) x
--         where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ placeholder_re)
--       or exists (
--         select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'links') = 'array' then i.value -> 'links' else '[]'::jsonb end) l
--         where jsonb_typeof(l.value) <> 'object'
--           or (l.value ->> 'process_id') !~ placeholder_re
--           or (jsonb_typeof(l.value -> 'step_id') <> 'null' and l.value ->> 'step_id' is not null and (l.value ->> 'step_id') !~ placeholder_re));
--     if bad > 0 then
--       raise exception 'import_workspace_bundle: an issue link, owner or source holds an id that is not a placeholder' using errcode = '22023';
--     end if;
--     select count(*) into bad from jsonb_array_elements(p_plan -> 'processes') p
--     where (p.value ->> 'id') is null or (p.value ->> 'id') !~ placeholder_re
--       or (jsonb_typeof(p.value -> 'parent_process_id') <> 'null' and p.value ->> 'parent_process_id' is not null and (p.value ->> 'parent_process_id') !~ placeholder_re)
--       or exists (
--         select 1 from jsonb_array_elements(p.value -> 'steps') s, unnest(array['id'] || step_ref_cols) c
--         where s.value -> c is not null and jsonb_typeof(s.value -> c) <> 'null' and (jsonb_typeof(s.value -> c) <> 'string' or (s.value ->> c) !~ placeholder_re))
--       or exists (
--         select 1 from jsonb_array_elements(p.value -> 'edges') e, unnest(array['id', 'from_step_id', 'to_step_id']) c
--         where e.value -> c is not null and jsonb_typeof(e.value -> c) <> 'null' and (jsonb_typeof(e.value -> c) <> 'string' or (e.value ->> c) !~ placeholder_re));
--     if bad > 0 then
--       raise exception 'import_workspace_bundle: a process, step or edge holds an id that is not a placeholder' using errcode = '22023';
--     end if;
--
--     -- The real ids: one random prefix per restore replaces the placeholder prefix.
--     loop
--       prefix := substr(md5(gen_random_uuid()::text), 1, 20);
--       exit when prefix <> '00000000000000000000';
--     end loop;
--     prefix := substr(prefix, 1, 8) || '-' || substr(prefix, 9, 4) || '-' || substr(prefix, 13, 4) || '-' || substr(prefix, 17, 4) || '-';
--     -- Two plain replacements (a regular expression took 13 times as long on a big plan): every placeholder gets the fresh
--     -- prefix, then rank 0 (the old workspace), now `<prefix>000000000000`, becomes the real workspace. The prefix is never
--     -- all zeros (the loop above), so no other id can take rank 0's place.
--     txt := replace(p_plan::text, placeholder, prefix);
--     txt := replace(txt, prefix || '000000000000', p_workspace::text);
--
--     -- A scenario equal (name and changes) to one the workspace already has (the seeded library) is skipped: its children and the
--     -- issues that use it are re-pointed at the existing row.
--     for sc in select value from jsonb_array_elements((txt::jsonb) -> 'sandbox_scenarios') loop
--       select s.id into existing from public.sandbox_scenarios s
--       where s.workspace_id = p_workspace and s.name = sc ->> 'name' and private.sandbox_changes_shape(s.changes) = private.sandbox_changes_shape(sc -> 'changes')
--       order by s.id limit 1;
--       if found then
--         txt := replace(txt, sc ->> 'id', existing::text);
--         skip_ids := skip_ids || existing;
--       end if;
--     end loop;
--     pl := txt::jsonb;
--     txt := null;
--     skipped := jsonb_build_object('scenarios', cardinality(skip_ids));
--
--     -- 6. Write.
--     foreach sec in array sections loop
--       begin
--         n := 0;
--         if sec = 'settings' then
--           if jsonb_typeof(pl -> 'settings') = 'object' and pl -> 'settings' <> '{}'::jsonb then
--             -- Whoever may restore (can_edit_workspace, checked first) manages the workspace too, so the settings are applied.
--             update public.workspaces set settings = settings || (pl -> 'settings') where id = p_workspace;
--             settings_result := 'applied';
--           end if;
--           continue;
--         end if;
--
--         if sec in ('demand_settings', 'lever_settings', 'analysis_rules') then
--           -- One row per workspace: written over any row the workspace already has.
--           if jsonb_typeof(pl -> sec) = 'object' then
--             select string_agg(quote_ident(c), ', '), string_agg(format('%1$I = excluded.%1$I', c), ', ') into cols, sets
--             from jsonb_array_elements_text(allow -> sec) c where (pl -> sec) ? c;
--             if cols is not null then
--               execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_record(null::public.%1$I, $1) on conflict (workspace_id) do update set %3$s', sec, cols, sets)
--                 using pl -> sec, p_workspace;
--               n := 1;
--             end if;
--           end if;
--
--         elsif sec = 'market_schedule' then
--           -- A row that points at one of the backup's presets points at this workspace's preset with the same key.
--           insert into public.market_schedule (workspace_id, id, condition_id, from_month, to_month, created_at)
--           select p_workspace, coalesce(x.id, gen_random_uuid()),
--             coalesce(x.condition_id, (select m.id from public.market_conditions m where m.workspace_id = p_workspace and m.preset = r.value ->> 'condition_preset')),
--             x.from_month, x.to_month, coalesce(x.created_at, now())
--           from jsonb_array_elements(pl -> 'market_schedule') with ordinality r(value, ord)
--           cross join lateral jsonb_populate_record(null::public.market_schedule, r.value) x
--           order by r.ord;
--           get diagnostics n = row_count;
--
--         elsif sec = 'processes' then
--           -- Every process first (parents first, as the plan is ordered), each opened as a draft, so a holder step can point at any of them.
--           for node in select value from jsonb_array_elements(pl -> 'processes') loop
--             proc := (node ->> 'id')::uuid;
--             insert into public.processes (id, workspace_id, name, kind, entity_name, description, source, parent_process_id)
--             values (proc, p_workspace, node ->> 'name', node ->> 'kind', node ->> 'entity_name', node ->> 'description', 'import', (node ->> 'parent_process_id')::uuid);
--             draft := public.open_draft(proc);
--             if draft ->> 'status' is distinct from 'ok' then
--               raise exception 'could not open a draft of %', node ->> 'name' using errcode = '42501';
--             end if;
--             rev := (draft ->> 'revision_id')::uuid;
--             revs := revs || jsonb_build_object(proc::text, rev);
--             if jsonb_typeof(node -> 'layout') = 'object' then
--               update public.process_revisions set layout = node -> 'layout' where id = rev;
--             end if;
--             if coalesce((node ->> 'archived')::boolean, false) then
--               arch := arch || proc;
--             end if;
--             made := made || jsonb_build_object('id', proc, 'name', node ->> 'name', 'revision_id', rev, 'archived', coalesce((node ->> 'archived')::boolean, false));
--             n := n + 1;
--           end loop;
--
--         elsif sec = 'sandbox_scenarios' then
--           select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
--           from jsonb_array_elements(pl -> 'sandbox_scenarios') with ordinality r(value, ord)
--           where not ((r.value ->> 'id')::uuid = any (skip_ids));
--           n := jsonb_array_length(rows);
--           if n > 0 then
--             -- A row without a horizon gets the default (populating a record from json would give it null, not the column default).
--             select jsonb_agg(case when r.value ? 'horizon_months' and jsonb_typeof(r.value -> 'horizon_months') = 'number' then r.value else r.value || '{"horizon_months": 12}'::jsonb end order by r.ord)
--               into rows from jsonb_array_elements(rows) with ordinality r(value, ord);
--             select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
--             where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
--             -- One statement, so the parent foreign key (no action) is checked at its end, whatever the order of the rows.
--             execute format('insert into public.sandbox_scenarios (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.sandbox_scenarios, $1)', cols) using rows, p_workspace;
--           end if;
--
--         elsif sec = 'issues' then
--           rows := pl -> 'issues';
--           n := jsonb_array_length(rows);
--           if n > 0 then
--             select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
--             where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
--             -- In plan order: the trigger numbers them 1, 2, 3 ... in the old order.
--             execute format('insert into public.issues (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.issues, $1)', cols) using rows, p_workspace;
--             -- `issue_seed_links` and `link_issue_source` may have added some already.
--             insert into public.issue_links (issue_id, workspace_id, process_id, step_id)
--             select (i.value ->> 'id')::uuid, p_workspace, (l.value ->> 'process_id')::uuid, (l.value ->> 'step_id')::uuid
--             from jsonb_array_elements(rows) i
--             cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'links') = 'array' then i.value -> 'links' else '[]'::jsonb end) l
--             on conflict do nothing;
--             insert into public.issue_owners (issue_id, person_id, workspace_id)
--             select (i.value ->> 'id')::uuid, (o.value #>> '{}')::uuid, p_workspace
--             from jsonb_array_elements(rows) i
--             cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'owner_ids') = 'array' then i.value -> 'owner_ids' else '[]'::jsonb end) o
--             on conflict do nothing;
--             insert into public.issue_sources (issue_id, source_id, workspace_id)
--             select (i.value ->> 'id')::uuid, (o.value #>> '{}')::uuid, p_workspace
--             from jsonb_array_elements(rows) i
--             cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'source_ids') = 'array' then i.value -> 'source_ids' else '[]'::jsonb end) o
--             on conflict do nothing;
--           end if;
--
--         elsif sec = 'steps' then
--           -- The steps and edges of each draft (an entry step is set once all the steps are in), then its first principles.
--           for node in select value from jsonb_array_elements(pl -> 'processes') loop
--             proc := (node ->> 'id')::uuid;
--             rev := (revs ->> proc::text)::uuid;
--             select coalesce(jsonb_agg(s.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'entry_step_id', null, 'created_by', auth.uid())), '[]'::jsonb)
--               into rows from jsonb_array_elements(node -> 'steps') s;
--             if jsonb_array_length(rows) > 0 then
--               select string_agg(quote_ident(k), ', ') into cols from (
--                 select distinct k from jsonb_array_elements(rows) r, jsonb_object_keys(r.value) k
--                 where k in ('revision_id', 'workspace_id', 'process_id', 'created_by') or (allow -> 'steps') ? k
--               ) q;
--               execute format('insert into public.steps (%1$s) select %1$s from jsonb_populate_recordset(null::public.steps, $1)', cols) using rows;
--               update public.steps st set entry_step_id = (s.value ->> 'entry_step_id')::uuid
--               from jsonb_array_elements(node -> 'steps') s
--               where st.revision_id = rev and st.id = (s.value ->> 'id')::uuid and s.value ->> 'entry_step_id' is not null;
--               n := n + jsonb_array_length(rows);
--             end if;
--             select coalesce(jsonb_agg(e.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'created_by', auth.uid())), '[]'::jsonb)
--               into rows from jsonb_array_elements(node -> 'edges') e;
--             if jsonb_array_length(rows) > 0 then
--               select string_agg(quote_ident(k), ', ') into cols from (
--                 select distinct k from jsonb_array_elements(rows) r, jsonb_object_keys(r.value) k
--                 where k in ('revision_id', 'workspace_id', 'process_id', 'created_by') or (allow -> 'edges') ? k
--               ) q;
--               execute format('insert into public.edges (%1$s) select %1$s from jsonb_populate_recordset(null::public.edges, $1)', cols) using rows;
--             end if;
--             if jsonb_typeof(node -> 'first_principles') = 'object' then
--               select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> 'first_principles') c where (node -> 'first_principles') ? c;
--               if cols is not null then
--                 execute format('insert into public.first_principles (workspace_id, process_id, revision_id, %1$s) select $2, $3, $4, %1$s from jsonb_populate_record(null::public.first_principles, $1)', cols)
--                   using node -> 'first_principles', p_workspace, proc, rev;
--               end if;
--             end if;
--           end loop;
--           counts := counts || jsonb_build_object('edges', edge_total);
--
--         elsif sec = 'archive' then
--           if cardinality(arch) > 0 then
--             update public.processes set archived_at = now() where id = any (arch);
--             get diagnostics n = row_count;
--           end if;
--
--         elsif sec = 'log' then
--           for node in select value from jsonb_array_elements(made) loop
--             perform public.log_process_import((node ->> 'id')::uuid, 'Restored from a workspace backup' || coalesce(' (' || label || ')', ''));
--             n := n + 1;
--           end loop;
--
--         else
--           -- A flat section: one insert, the plan's order, only the columns of the allow-list that the rows carry.
--           tbl := sec;
--           rows := pl -> sec;
--           if sec = 'market_conditions' then
--             -- The presets are read-only and the workspace has them already: the plan carries custom conditions only, and no `preset`.
--             null;
--           elsif sec = 'source_links' then
--             -- A step link needs its step in the process's restored draft (the trigger refuses it otherwise).
--             select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
--             from jsonb_array_elements(rows) with ordinality r(value, ord)
--             where r.value ->> 'kind' is distinct from 'step' or exists (
--               select 1 from public.steps s where s.workspace_id = p_workspace and s.process_id = (r.value ->> 'process_id')::uuid and s.id = (r.value ->> 'step_id')::uuid);
--             skipped := skipped || jsonb_build_object('step_links', jsonb_array_length(pl -> sec) - jsonb_array_length(rows));
--           end if;
--           n := jsonb_array_length(rows);
--           if n > 0 then
--             -- A source link's id can't be given by a signed-in caller (the insert grant on the table is by column, and leaves `id`
--             -- and `created_at` out): the database makes it.
--             select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
--             where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c) and not (sec = 'source_links' and c = 'id');
--             if cols is null then
--               raise exception 'the rows have none of the columns a restore accepts' using errcode = '22023';
--             end if;
--             execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_recordset(null::public.%1$I, $1)%3$s', tbl, cols,
--               case when sec = 'source_links' then ' on conflict do nothing' else '' end)
--               using rows, p_workspace;
--           end if;
--         end if;
--         counts := counts || jsonb_build_object(sec, n);
--       exception when others then
--         raise exception 'import_workspace_bundle: % could not be restored: %', sec, sqlerrm using errcode = sqlstate, hint = 'section:' || sec;
--       end;
--     end loop;
--
--     return jsonb_build_object('id_prefix', prefix, 'processes', made, 'counts', counts, 'skipped', skipped, 'settings', settings_result);
--   end;
--   $function$;
-- 6. Then: delete from public.schema_migrations where version = '20270118000000';
-- (The tables come back empty: the rows are not kept. Take a Neon branch just before `migrate`, as the cutover runbook does, if the rows may be wanted.)

-- Marks any write as the system's, as the migrations since 20270103000000_three_roles.sql do.
select set_config('transpera.actor_kind', 'system', true);

-- 1. No guests: the share-link clause of the sign-in check is gone.
create or replace function private.may_sign_in(p_email text, p_email_verified boolean, p_bootstrap_admins text[] DEFAULT '{}'::text[])
 returns text
 language plpgsql
 stable security definer
 set search_path = ''
as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  r text := private.deployment_role(p_email, p_email_verified, p_bootstrap_admins);
begin
  if r is not null then
    return r;
  end if;
  if not coalesce(p_email_verified, false) or e = '' then
    return null;
  end if;
  -- No share links any more, so no guests: an address with no deployment role may not sign in.
  return null;
end;
$$;

-- 2. The imports no longer write first principles.
create or replace function public.import_process_bundle(p_workspace uuid, p_nodes jsonb, p_adopt jsonb DEFAULT '[]'::jsonb, p_extras jsonb DEFAULT '{}'::jsonb)
 returns jsonb
 language plpgsql
 set search_path = ''
as $$
declare
  extras jsonb := coalesce(nullif(p_extras, 'null'::jsonb), '{}');
  srcs jsonb;
  s jsonb;
  top uuid;
  made jsonb;
  fresh uuid;
  ref uuid;
  fresh_ids uuid[] := '{}';
  nodes_txt text;
  n_sources integer;
  body_chars bigint;
begin
  if p_workspace is null or jsonb_typeof(p_nodes) is distinct from 'array' or jsonb_array_length(p_nodes) < 1 then
    raise exception 'import_process_bundle: p_nodes must be an array of processes' using errcode = '22023';
  end if;
  if jsonb_typeof(extras) is distinct from 'object' then
    raise exception 'import_process_bundle: p_extras must be an object' using errcode = '22023';
  end if;
  -- A section that is JSON null is a section that is left out.
  srcs := coalesce(nullif(extras -> 'sources', 'null'::jsonb), '[]');
  if jsonb_typeof(srcs) is distinct from 'array' then
    raise exception 'import_process_bundle: sources must be an array' using errcode = '22023';
  end if;
  n_sources := jsonb_array_length(srcs);
  if n_sources > 50 then
    raise exception 'import_process_bundle: at most 50 sources in one import' using errcode = '22023';
  end if;
  select coalesce(sum(char_length(coalesce(x ->> 'body', ''))), 0) into body_chars from jsonb_array_elements(srcs) x;
  if body_chars > 2000000 then
    raise exception 'The sources'' text is too long: % characters in all, and one upload takes at most 2,000,000. Leave the text out of the longest sources.', body_chars using errcode = '22023';
  end if;
  top := (p_nodes -> 0 ->> 'id')::uuid;
  nodes_txt := p_nodes::text;

  -- Sources first: the steps that cite them are linked to them as they are written. Each gets an id made here; the file's
  -- placeholder (`ref`) is replaced by it wherever the file cites the source.
  for s in select value from jsonb_array_elements(srcs) loop
    ref := (s ->> 'ref')::uuid;
    fresh := gen_random_uuid();
    insert into public.sources (id, workspace_id, kind, title, speakers, recorded_at, body)
    values (fresh, p_workspace, coalesce(s ->> 'kind', 'transcript'), s ->> 'title',
      coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(s -> 'speakers') = 'array' then s -> 'speakers' else '[]'::jsonb end)), '{}'),
      nullif(s ->> 'recorded_at', '')::date, nullif(s ->> 'body', ''));
    fresh_ids := fresh_ids || fresh;
    nodes_txt := replace(nodes_txt, ref::text, fresh::text);
  end loop;

  -- The process, its draft, its steps and edges (and any child processes), as the atomic import writes them.
  made := public.import_new_process(p_workspace, nodes_txt::jsonb, p_adopt);

  -- Every source of the file is evidence for the process it came with.
  insert into public.source_links (workspace_id, source_id, kind, process_id)
  select p_workspace, f, 'process', top from unnest(fresh_ids) f
  on conflict do nothing;

  return jsonb_build_object('processes', made, 'sources', n_sources);
end;
$$;

create or replace function public.import_workspace_bundle(p_workspace uuid, p_plan jsonb, p_label text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 set search_path = ''
 SET statement_timeout TO '40s'
as $$
declare
  -- The columns the restore accepts for each plan section: the same lists as IMPORT_COLUMNS (packages/db/src/workspace-import.ts).
  -- Everything else in a row is ignored; `workspace_id`, `created_by`, `updated_at` and every `*_by` are never read from the plan.
  -- #228: person_capacity_factors is in this list, in ref_cols, in sections and in list_sections.
  allow constant jsonb := '{"roles":["id","name","color","default_cost_rate","headcount","ongoing_hours_per_client_week","active","provenance","created_at"],"people":["id","name","active","capacity_hours_week","cost_rate","end_date","fte","notes","start_date","provenance","created_at"],"person_roles":["person_id","role_id","created_at"],"person_leave":["id","person_id","start_date","end_date","note","created_at"],"lead_sources":["id","name","conversion_to_qualified","volume_week","provenance","created_at"],"seasonality":["id","month","multiplier","provenance","created_at"],"demand_settings":["growth_monthly","provenance","created_at"],"churn_drivers":["id","name","description","driver","enabled","example","month","value","weight","chance","effect","effect_months","provenance","created_at"],"market_conditions":["id","name","churn","conv","cycle","hire","leads","pay","price","created_at"],"market_schedule":["id","condition_id","from_month","to_month","created_at"],"lever_settings":["hidden","created_at"],"analysis_rules":["settings","created_at"],"clients":["id","name","active","health","mrr","notes","start_date","provenance","created_at"],"sources":["id","kind","title","body","recorded_at","speakers","created_at"],"processes":["id","parent_process_id","name","kind","entity_name","description"],"steps":["id","assumption","child_process_id","conflict","cost_override","current_wip","dropoff_benchmark","expected_wait_hours","entry_step_id","kind","lost_per_day_waiting","name","notes","outcome","parent_step_id","person_id","provenance","purpose","replaced_by","rework_rate","rework_to_step_id","role_id","sla_hours","target_cycle_hours","tool","wait_dist","wait_hours","wait_params","work_dist","work_hours","work_params","x","y"],"edges":["id","condition_tag","from_step_id","label","probability","to_step_id"],"sandbox_scenarios":["id","parent_id","name","description","changes","horizon_months","start_date","created_at"],"blocks":["id","name","description","type","steps","created_at"],"issues":["id","client_id","created_at","detected_key","evidence","evidence_metrics","evidence_sources","owner_person_id","person_id","process_id","resolution","resolution_note","resolved_how","role_id","scenario_id","severity","source","status","step_id","target_goal","target_measure","target_now","title","type"],"services":["id","name","active","churn_health_sensitivity","churn_monthly_base","entry_process_id","fallback_ongoing_load","margin","mix_share","path_tags","price","price_high","price_low","pricing_model","tenure_months","provenance","created_at"],"service_servicing":["id","process_id","service_id","recurrence","sla_hours","provenance","created_at"],"client_groups":["id","service_id","client_count","churn_monthly","fee","starting_health","stay_months","provenance","created_at"],"client_services":["client_id","service_id","start_date","created_at"],"client_assignments":["client_id","role_id","person_id","created_at"],"person_skills":["person_id","step_id","efficiency","provenance","created_at"],"person_capacity_factors":["person_id","step_id","factor","provenance"],"source_links":["id","insight_key","issue_id","kind","process_id","source_id","step_id"]}'::jsonb;
  -- The reference columns of the flat sections (IMPORT_REFS) and of steps (IMPORT_STEP_REFS). Every section that has an `id`
  -- column in `allow` is checked on `id` too.
  -- #228
  ref_cols constant text[] := array['person_roles.person_id','person_roles.role_id','person_leave.person_id','services.entry_process_id','service_servicing.service_id','service_servicing.process_id','client_groups.service_id','client_services.client_id','client_services.service_id','client_assignments.client_id','client_assignments.role_id','client_assignments.person_id','person_skills.person_id','person_skills.step_id','sandbox_scenarios.parent_id','issues.client_id','issues.owner_person_id','issues.person_id','issues.process_id','issues.role_id','issues.scenario_id','issues.step_id','source_links.source_id','source_links.issue_id','source_links.process_id','source_links.step_id','market_schedule.condition_id','person_capacity_factors.person_id','person_capacity_factors.step_id'];
  step_ref_cols constant text[] := array['parent_step_id','entry_step_id','rework_to_step_id','person_id','role_id','child_process_id'];
  -- The order the sections are written in.
  -- #228
  sections constant text[] := array['settings','roles','people','person_roles','person_leave','lead_sources','seasonality','demand_settings','churn_drivers','market_conditions','market_schedule','lever_settings','analysis_rules','clients','sources','processes','sandbox_scenarios','blocks','issues','steps','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','source_links','archive','log'];
  -- #228
  list_sections constant text[] := array['roles','people','person_roles','person_leave','lead_sources','seasonality','churn_drivers','market_conditions','market_schedule','clients','sources','processes','sandbox_scenarios','blocks','issues','services','service_servicing','client_groups','client_services','client_assignments','person_skills','person_capacity_factors','source_links'];
  one_sections constant text[] := array['settings','demand_settings','lever_settings','analysis_rules'];
  placeholder constant text := '00000000-0000-4000-8000-';
  placeholder_re constant text := '^00000000-0000-4000-8000-[0-9a-f]{12}$';
  max_plan_chars constant integer := 19660800;

  pl jsonb;
  txt text;
  prefix text;
  label text := left(nullif(btrim(coalesce(p_label, '')), ''), 300);
  sec text;
  col text;
  tbl text;
  rows jsonb;
  node jsonb;
  sc jsonb;
  cols text;
  sets text;
  n integer;
  total integer;
  existing uuid;
  skip_ids uuid[] := '{}';
  skipped jsonb := '{}';
  counts jsonb := '{}';
  proc uuid;
  rev uuid;
  draft jsonb;
  revs jsonb := '{}';
  made jsonb := '[]';
  arch uuid[] := '{}';
  step_total integer := 0;
  edge_total integer := 0;
  settings_result text := 'none';
  what text;
  has_rows boolean;
  bad integer;
  chars bigint;
begin
  -- 1. Who. Before the plan is read, so a refusal says nothing about it.
  if coalesce(auth.jwt(), '{}'::jsonb) ? 'api_token_id' then
    raise exception 'Backups are restored in the app.' using errcode = '42501';
  end if;
  if p_workspace is null or not coalesce(public.can_edit_workspace(p_workspace), false) then
    raise exception 'Only Agency admins and the Owner can restore a backup.' using errcode = '42501';
  end if;

  -- 2. Shape and limits.
  if p_plan is null or jsonb_typeof(p_plan) is distinct from 'object' or p_plan ->> 'format' is distinct from 'transpera-workspace-import/1' then
    raise exception 'import_workspace_bundle: p_plan is not a transpera-workspace-import/1 plan' using errcode = '22023';
  end if;
  -- #228: a plan made before per-person times were restored (an app deployed before this migration) has no such section:
  -- it restores as an empty one.
  if not p_plan ? 'person_capacity_factors' then
    p_plan := p_plan || '{"person_capacity_factors": []}'::jsonb;
  end if;
  if char_length(p_plan::text) > max_plan_chars then
    raise exception 'import_workspace_bundle: the plan is too big (at most 15 MB)' using errcode = '22023';
  end if;
  foreach sec in array list_sections loop
    if jsonb_typeof(p_plan -> sec) is distinct from 'array' then
      raise exception 'import_workspace_bundle: % must be a list', sec using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_plan -> sec) e where jsonb_typeof(e.value) is distinct from 'object') then
      raise exception 'import_workspace_bundle: every row of % must be an object', sec using errcode = '22023';
    end if;
  end loop;
  foreach sec in array one_sections loop
    if p_plan -> sec is not null and jsonb_typeof(p_plan -> sec) not in ('object', 'null') then
      raise exception 'import_workspace_bundle: % must be an object or null', sec using errcode = '22023';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(p_plan -> 'processes') p
    where jsonb_typeof(p.value -> 'steps') is distinct from 'array' or jsonb_typeof(p.value -> 'edges') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(p.value -> 'steps') e where jsonb_typeof(e.value) is distinct from 'object')
      or exists (select 1 from jsonb_array_elements(p.value -> 'edges') e where jsonb_typeof(e.value) is distinct from 'object')
      or (p.value -> 'layout' is not null and jsonb_typeof(p.value -> 'layout') not in ('object', 'null'))
  ) then
    raise exception 'import_workspace_bundle: every process needs lists of steps and edges' using errcode = '22023';
  end if;
  select coalesce(sum(jsonb_array_length(p.value -> 'steps')), 0), coalesce(sum(jsonb_array_length(p.value -> 'edges')), 0)
    into step_total, edge_total from jsonb_array_elements(p_plan -> 'processes') p;
  select coalesce(sum(char_length(coalesce(s.value ->> 'body', ''))), 0) into chars from jsonb_array_elements(p_plan -> 'sources') s;
  if jsonb_array_length(p_plan -> 'processes') > 150 or step_total > 1500 or edge_total > 3000
    or jsonb_array_length(p_plan -> 'sources') > 600 or chars > 4500000
    or jsonb_array_length(p_plan -> 'issues') > 900 or jsonb_array_length(p_plan -> 'people') > 1500
    or jsonb_array_length(p_plan -> 'clients') > 3000 or jsonb_array_length(p_plan -> 'sandbox_scenarios') > 900
    or jsonb_array_length(p_plan -> 'blocks') > 900
    or jsonb_array_length(p_plan -> 'person_roles') > 1200 or jsonb_array_length(p_plan -> 'person_skills') > 3000
    or jsonb_array_length(p_plan -> 'client_assignments') > 1200 or jsonb_array_length(p_plan -> 'source_links') > 3000
    or jsonb_array_length(p_plan -> 'client_services') > 3000 or jsonb_array_length(p_plan -> 'person_leave') > 1500
    -- #228
    or jsonb_array_length(p_plan -> 'person_capacity_factors') > 3000
    or jsonb_array_length(p_plan -> 'lead_sources') + jsonb_array_length(p_plan -> 'seasonality') + jsonb_array_length(p_plan -> 'churn_drivers')
      + jsonb_array_length(p_plan -> 'market_conditions') + jsonb_array_length(p_plan -> 'market_schedule') + jsonb_array_length(p_plan -> 'services')
      + jsonb_array_length(p_plan -> 'service_servicing') + jsonb_array_length(p_plan -> 'client_groups') > 1500 then
    -- #228
    raise exception 'import_workspace_bundle: the plan is over a limit (150 processes, 1500 steps, 3000 edges, 600 sources of 4,500,000 characters, 900 issues, 1500 people, 3000 clients, 900 scenarios, 900 blocks, 1200 role assignments, 3000 skills, 1200 client assignments, 3000 source links, 3000 client services, 1500 leave entries, 1500 other company settings rows, 3000 per-person times)' using errcode = '22023';
  end if;
  -- A scenario without an id would make the replacement of a skipped one (below) return null, and the restore would write nothing and say it worked.
  if exists (select 1 from jsonb_array_elements(p_plan -> 'sandbox_scenarios') s where jsonb_typeof(s.value -> 'id') is distinct from 'string') then
    raise exception 'import_workspace_bundle: every scenario needs an id' using errcode = '22023';
  end if;

  -- 3. Lock: one restore (or upload) at a time per workspace.
  if not pg_try_advisory_xact_lock(hashtextextended('import_workspace_bundle:' || p_workspace::text, 0)) then
    raise exception 'A restore into this workspace is already running.' using errcode = '55P03', hint = 'busy';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('import_new_process:' || p_workspace::text, 0));

  -- 4. Empty.
  for tbl, col in
    select t.a, t.b from (values
      ('processes', 'not is_company'), ('roles', 'true'), ('people', 'true'), ('services', 'true'), ('client_groups', 'true'),
      ('clients', 'true'), ('lead_sources', 'true'), ('churn_drivers', 'true'), ('market_schedule', 'true'), ('issues', 'true'),
      ('sources', 'true'), ('blocks', 'true'), ('solutions', 'true'),
      ('market_conditions', 'preset is null')
    ) as t(a, b)
  loop
    execute format('select exists (select 1 from public.%I where workspace_id = $1 and %s)', tbl, col) into has_rows using p_workspace;
    if has_rows then
      what := replace(tbl, '_', ' ');
      exit;
    end if;
  end loop;
  if what is null and exists (
    select 1 from public.sandbox_scenarios s where s.workspace_id = p_workspace
      and not exists (select 1 from private.sandbox_library() l where l.name = s.name and private.sandbox_changes_shape(l.changes) = private.sandbox_changes_shape(s.changes))
  ) then
    what := 'scenarios of its own';
  end if;
  if what is not null then
    raise exception 'This workspace isn''t empty: it already has %. Backups restore only into a new, empty workspace.', what
      using errcode = '23514', hint = 'not_empty';
  end if;

  -- 5. Ids: every id and reference column of the plan holds a placeholder (or null) before anything is replaced.
  foreach sec in array list_sections loop
    if sec = 'processes' then continue; end if;
    for col in
      select c from (
        select 'id' as c where allow -> sec ? 'id'
        union all select split_part(r, '.', 2) from unnest(ref_cols) r where split_part(r, '.', 1) = sec
      ) q
    loop
      select count(*) into bad from jsonb_array_elements(p_plan -> sec) r
      where r.value -> col is not null and jsonb_typeof(r.value -> col) <> 'null'
        and (jsonb_typeof(r.value -> col) <> 'string' or (r.value ->> col) !~ placeholder_re);
      if bad > 0 then
        raise exception 'import_workspace_bundle: % holds an id that is not a placeholder in %', col, sec using errcode = '22023';
      end if;
    end loop;
  end loop;
  select count(*) into bad from jsonb_array_elements(p_plan -> 'issues') i
  where exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'owner_ids') = 'array' then i.value -> 'owner_ids' else '[]'::jsonb end) x
      where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ placeholder_re)
    or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'source_ids') = 'array' then i.value -> 'source_ids' else '[]'::jsonb end) x
      where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ placeholder_re)
    or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(i.value -> 'links') = 'array' then i.value -> 'links' else '[]'::jsonb end) l
      where jsonb_typeof(l.value) <> 'object'
        or (l.value ->> 'process_id') !~ placeholder_re
        or (jsonb_typeof(l.value -> 'step_id') <> 'null' and l.value ->> 'step_id' is not null and (l.value ->> 'step_id') !~ placeholder_re));
  if bad > 0 then
    raise exception 'import_workspace_bundle: an issue link, owner or source holds an id that is not a placeholder' using errcode = '22023';
  end if;
  select count(*) into bad from jsonb_array_elements(p_plan -> 'processes') p
  where (p.value ->> 'id') is null or (p.value ->> 'id') !~ placeholder_re
    or (jsonb_typeof(p.value -> 'parent_process_id') <> 'null' and p.value ->> 'parent_process_id' is not null and (p.value ->> 'parent_process_id') !~ placeholder_re)
    or exists (
      select 1 from jsonb_array_elements(p.value -> 'steps') s, unnest(array['id'] || step_ref_cols) c
      where s.value -> c is not null and jsonb_typeof(s.value -> c) <> 'null' and (jsonb_typeof(s.value -> c) <> 'string' or (s.value ->> c) !~ placeholder_re))
    or exists (
      select 1 from jsonb_array_elements(p.value -> 'edges') e, unnest(array['id', 'from_step_id', 'to_step_id']) c
      where e.value -> c is not null and jsonb_typeof(e.value -> c) <> 'null' and (jsonb_typeof(e.value -> c) <> 'string' or (e.value ->> c) !~ placeholder_re));
  if bad > 0 then
    raise exception 'import_workspace_bundle: a process, step or edge holds an id that is not a placeholder' using errcode = '22023';
  end if;

  -- The real ids: one random prefix per restore replaces the placeholder prefix.
  loop
    prefix := substr(md5(gen_random_uuid()::text), 1, 20);
    exit when prefix <> '00000000000000000000';
  end loop;
  prefix := substr(prefix, 1, 8) || '-' || substr(prefix, 9, 4) || '-' || substr(prefix, 13, 4) || '-' || substr(prefix, 17, 4) || '-';
  -- Two plain replacements (a regular expression took 13 times as long on a big plan): every placeholder gets the fresh
  -- prefix, then rank 0 (the old workspace), now `<prefix>000000000000`, becomes the real workspace. The prefix is never
  -- all zeros (the loop above), so no other id can take rank 0's place.
  txt := replace(p_plan::text, placeholder, prefix);
  txt := replace(txt, prefix || '000000000000', p_workspace::text);

  -- A scenario equal (name and changes) to one the workspace already has (the seeded library) is skipped: its children and the
  -- issues that use it are re-pointed at the existing row.
  for sc in select value from jsonb_array_elements((txt::jsonb) -> 'sandbox_scenarios') loop
    select s.id into existing from public.sandbox_scenarios s
    where s.workspace_id = p_workspace and s.name = sc ->> 'name' and private.sandbox_changes_shape(s.changes) = private.sandbox_changes_shape(sc -> 'changes')
    order by s.id limit 1;
    if found then
      txt := replace(txt, sc ->> 'id', existing::text);
      skip_ids := skip_ids || existing;
    end if;
  end loop;
  pl := txt::jsonb;
  txt := null;
  skipped := jsonb_build_object('scenarios', cardinality(skip_ids));

  -- 6. Write.
  foreach sec in array sections loop
    begin
      n := 0;
      if sec = 'settings' then
        if jsonb_typeof(pl -> 'settings') = 'object' and pl -> 'settings' <> '{}'::jsonb then
          -- Whoever may restore (can_edit_workspace, checked first) manages the workspace too, so the settings are applied.
          update public.workspaces set settings = settings || (pl -> 'settings') where id = p_workspace;
          settings_result := 'applied';
        end if;
        continue;
      end if;

      if sec in ('demand_settings', 'lever_settings', 'analysis_rules') then
        -- One row per workspace: written over any row the workspace already has.
        if jsonb_typeof(pl -> sec) = 'object' then
          select string_agg(quote_ident(c), ', '), string_agg(format('%1$I = excluded.%1$I', c), ', ') into cols, sets
          from jsonb_array_elements_text(allow -> sec) c where (pl -> sec) ? c;
          if cols is not null then
            execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_record(null::public.%1$I, $1) on conflict (workspace_id) do update set %3$s', sec, cols, sets)
              using pl -> sec, p_workspace;
            n := 1;
          end if;
        end if;

      elsif sec = 'market_schedule' then
        -- A row that points at one of the backup's presets points at this workspace's preset with the same key.
        insert into public.market_schedule (workspace_id, id, condition_id, from_month, to_month, created_at)
        select p_workspace, coalesce(x.id, gen_random_uuid()),
          coalesce(x.condition_id, (select m.id from public.market_conditions m where m.workspace_id = p_workspace and m.preset = r.value ->> 'condition_preset')),
          x.from_month, x.to_month, coalesce(x.created_at, now())
        from jsonb_array_elements(pl -> 'market_schedule') with ordinality r(value, ord)
        cross join lateral jsonb_populate_record(null::public.market_schedule, r.value) x
        order by r.ord;
        get diagnostics n = row_count;

      elsif sec = 'processes' then
        -- Every process first (parents first, as the plan is ordered), each opened as a draft, so a holder step can point at any of them.
        for node in select value from jsonb_array_elements(pl -> 'processes') loop
          proc := (node ->> 'id')::uuid;
          insert into public.processes (id, workspace_id, name, kind, entity_name, description, source, parent_process_id)
          values (proc, p_workspace, node ->> 'name', node ->> 'kind', node ->> 'entity_name', node ->> 'description', 'import', (node ->> 'parent_process_id')::uuid);
          draft := public.open_draft(proc);
          if draft ->> 'status' is distinct from 'ok' then
            raise exception 'could not open a draft of %', node ->> 'name' using errcode = '42501';
          end if;
          rev := (draft ->> 'revision_id')::uuid;
          revs := revs || jsonb_build_object(proc::text, rev);
          if jsonb_typeof(node -> 'layout') = 'object' then
            update public.process_revisions set layout = node -> 'layout' where id = rev;
          end if;
          if coalesce((node ->> 'archived')::boolean, false) then
            arch := arch || proc;
          end if;
          made := made || jsonb_build_object('id', proc, 'name', node ->> 'name', 'revision_id', rev, 'archived', coalesce((node ->> 'archived')::boolean, false));
          n := n + 1;
        end loop;

      elsif sec = 'sandbox_scenarios' then
        select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
        from jsonb_array_elements(pl -> 'sandbox_scenarios') with ordinality r(value, ord)
        where not ((r.value ->> 'id')::uuid = any (skip_ids));
        n := jsonb_array_length(rows);
        if n > 0 then
          -- A row without a horizon gets the default (populating a record from json would give it null, not the column default).
          select jsonb_agg(case when r.value ? 'horizon_months' and jsonb_typeof(r.value -> 'horizon_months') = 'number' then r.value else r.value || '{"horizon_months": 12}'::jsonb end order by r.ord)
            into rows from jsonb_array_elements(rows) with ordinality r(value, ord);
          select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
          where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
          -- One statement, so the parent foreign key (no action) is checked at its end, whatever the order of the rows.
          execute format('insert into public.sandbox_scenarios (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.sandbox_scenarios, $1)', cols) using rows, p_workspace;
        end if;

      elsif sec = 'issues' then
        rows := pl -> 'issues';
        n := jsonb_array_length(rows);
        if n > 0 then
          select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
          where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c);
          -- In plan order: the trigger numbers them 1, 2, 3 ... in the old order.
          execute format('insert into public.issues (workspace_id, %1$s) select $2, %1$s from jsonb_populate_recordset(null::public.issues, $1)', cols) using rows, p_workspace;
          -- `issue_seed_links` and `link_issue_source` may have added some already.
          insert into public.issue_links (issue_id, workspace_id, process_id, step_id)
          select (i.value ->> 'id')::uuid, p_workspace, (l.value ->> 'process_id')::uuid, (l.value ->> 'step_id')::uuid
          from jsonb_array_elements(rows) i
          cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'links') = 'array' then i.value -> 'links' else '[]'::jsonb end) l
          on conflict do nothing;
          insert into public.issue_owners (issue_id, person_id, workspace_id)
          select (i.value ->> 'id')::uuid, (o.value #>> '{}')::uuid, p_workspace
          from jsonb_array_elements(rows) i
          cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'owner_ids') = 'array' then i.value -> 'owner_ids' else '[]'::jsonb end) o
          on conflict do nothing;
          insert into public.issue_sources (issue_id, source_id, workspace_id)
          select (i.value ->> 'id')::uuid, (o.value #>> '{}')::uuid, p_workspace
          from jsonb_array_elements(rows) i
          cross join lateral jsonb_array_elements(case when jsonb_typeof(i.value -> 'source_ids') = 'array' then i.value -> 'source_ids' else '[]'::jsonb end) o
          on conflict do nothing;
        end if;

      elsif sec = 'steps' then
        -- The steps and edges of each draft (an entry step is set once all the steps are in), then its first principles.
        for node in select value from jsonb_array_elements(pl -> 'processes') loop
          proc := (node ->> 'id')::uuid;
          rev := (revs ->> proc::text)::uuid;
          select coalesce(jsonb_agg(s.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'entry_step_id', null, 'created_by', auth.uid())), '[]'::jsonb)
            into rows from jsonb_array_elements(node -> 'steps') s;
          if jsonb_array_length(rows) > 0 then
            select string_agg(quote_ident(k), ', ') into cols from (
              select distinct k from jsonb_array_elements(rows) r, jsonb_object_keys(r.value) k
              where k in ('revision_id', 'workspace_id', 'process_id', 'created_by') or (allow -> 'steps') ? k
            ) q;
            execute format('insert into public.steps (%1$s) select %1$s from jsonb_populate_recordset(null::public.steps, $1)', cols) using rows;
            update public.steps st set entry_step_id = (s.value ->> 'entry_step_id')::uuid
            from jsonb_array_elements(node -> 'steps') s
            where st.revision_id = rev and st.id = (s.value ->> 'id')::uuid and s.value ->> 'entry_step_id' is not null;
            n := n + jsonb_array_length(rows);
          end if;
          select coalesce(jsonb_agg(e.value || jsonb_build_object('revision_id', rev, 'workspace_id', p_workspace, 'process_id', proc, 'created_by', auth.uid())), '[]'::jsonb)
            into rows from jsonb_array_elements(node -> 'edges') e;
          if jsonb_array_length(rows) > 0 then
            select string_agg(quote_ident(k), ', ') into cols from (
              select distinct k from jsonb_array_elements(rows) r, jsonb_object_keys(r.value) k
              where k in ('revision_id', 'workspace_id', 'process_id', 'created_by') or (allow -> 'edges') ? k
            ) q;
            execute format('insert into public.edges (%1$s) select %1$s from jsonb_populate_recordset(null::public.edges, $1)', cols) using rows;
          end if;
        end loop;
        counts := counts || jsonb_build_object('edges', edge_total);

      elsif sec = 'archive' then
        if cardinality(arch) > 0 then
          update public.processes set archived_at = now() where id = any (arch);
          get diagnostics n = row_count;
        end if;

      elsif sec = 'log' then
        for node in select value from jsonb_array_elements(made) loop
          perform public.log_process_import((node ->> 'id')::uuid, 'Restored from a workspace backup' || coalesce(' (' || label || ')', ''));
          n := n + 1;
        end loop;

      else
        -- A flat section: one insert, the plan's order, only the columns of the allow-list that the rows carry.
        tbl := sec;
        rows := pl -> sec;
        if sec = 'market_conditions' then
          -- The presets are read-only and the workspace has them already: the plan carries custom conditions only, and no `preset`.
          null;
        elsif sec = 'source_links' then
          -- A step link needs its step in the process's restored draft (the trigger refuses it otherwise).
          select coalesce(jsonb_agg(r.value order by r.ord), '[]'::jsonb) into rows
          from jsonb_array_elements(rows) with ordinality r(value, ord)
          where r.value ->> 'kind' is distinct from 'step' or exists (
            select 1 from public.steps s where s.workspace_id = p_workspace and s.process_id = (r.value ->> 'process_id')::uuid and s.id = (r.value ->> 'step_id')::uuid);
          skipped := skipped || jsonb_build_object('step_links', jsonb_array_length(pl -> sec) - jsonb_array_length(rows));
        end if;
        n := jsonb_array_length(rows);
        if n > 0 then
          -- A source link's id can't be given by a signed-in caller (the insert grant on the table is by column, and leaves `id`
          -- and `created_at` out): the database makes it.
          select string_agg(quote_ident(c), ', ') into cols from jsonb_array_elements_text(allow -> sec) c
          where exists (select 1 from jsonb_array_elements(rows) r where r.value ? c) and not (sec = 'source_links' and c = 'id');
          if cols is null then
            raise exception 'the rows have none of the columns a restore accepts' using errcode = '22023';
          end if;
          execute format('insert into public.%1$I (workspace_id, %2$s) select $2, %2$s from jsonb_populate_recordset(null::public.%1$I, $1)%3$s', tbl, cols,
            case when sec = 'source_links' then ' on conflict do nothing' else '' end)
            using rows, p_workspace;
        end if;
      end if;
      counts := counts || jsonb_build_object(sec, n);
    exception when others then
      raise exception 'import_workspace_bundle: % could not be restored: %', sec, sqlerrm using errcode = sqlstate, hint = 'section:' || sec;
    end;
  end loop;

  return jsonb_build_object('id_prefix', prefix, 'processes', made, 'counts', counts, 'skipped', skipped, 'settings', settings_result);
end;
$$;

-- 3. Share links.
drop table public.share_links;
drop function public.open_share_link(text);
drop function public.share_team_capacity(uuid, boolean);
drop function private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean);
drop function private.share_links_before_write();
drop function private.share_links_no_speeds();
drop function private.share_emails_ok(text[]);
drop function private.share_name_tokens(uuid, text);
drop function private.share_strings(jsonb);
drop function private.share_norm(text);
drop function private.share_unpct(text);
drop function private.lever_kind_ids();

-- 4. First principles.
drop table public.first_principles;

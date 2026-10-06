-- Play links: a visitor tries levers on a shared process and sends the idea to Suggestions (issue #33, B4; docs/plans/b4-brief.md,
-- docs/adr/0016-share-links.md "Play links (B4, D48)").
--
-- A share link made in `play` mode shows the same redacted snapshot as a view link, plus the list of lever kinds the workspace
-- hides. The visitor moves the shown levers in the browser (nothing is saved) and can SEND what they tried. The only write a play
-- link can make is `public.submit_play_proposal`: it stores one pending `solution_idea` in `suggestion_proposals` (created_via
-- `play_link`, the visitor's name, note and the lever changes). Nothing is ever applied by it: only an owner's or editor's Build it
-- or Dismiss acts on the idea.
--
-- What this adds:
--   * `suggestion_proposals.share_link_id` (the link an idea came from; no foreign key: links are never deleted, and a set-null
--     action would trip the guard trigger) and `visitor_text` (jsonb: what a visitor typed that members and viewers must not read;
--     NOT granted to authenticated, like `proposer_email`), with a partial index on `share_link_id`.
--   * `suggestion_proposals_issue` widened: a visitor's idea may be for no issue (not valid + validate, as 20261129000000 did).
--   * `private.lever_kind_ids()`, `private.play_patch_problem(uuid, share_links, jsonb)` (is this set of lever changes allowed from
--     this link?), `public.submit_play_proposal(...)` (anon and authenticated) and `public.play_proposal_contacts(uuid)` (owners,
--     editors and agency admins: a visitor's email and held text).
--   * `grant insert (mode) on share_links to authenticated` (B3 left `mode` out on purpose: 'view' only until B4).
-- What this REPLACES, each with `create or replace`, the same signature, language, volatility, security flag and
-- `set search_path = ''`, as a full copy of the body named, changing only the lines marked `-- B4` (a test checks it):
--   * private.share_links_before_write()                  from 20261220000000_share_links.sql (B3, final): a play link must be for a process and carry `hiddenLevers`
--   * private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)   from 20261220000000_share_links.sql: `hiddenLevers` is a non-text key, and must be known kind ids
--   * public.open_share_link(text)                        from 20261220000000_share_links.sql: serves play links too
--   * private.suggestion_proposals_before_write()         from 20261129000000_import_bundle.sql: a play submission may say `play_link`; the new columns are frozen
--   * private.suggestions_before_write()                  from 20261129000000_import_bundle.sql: deleting a user who created or reviewed a suggestion no longer fails (HANDOVER follow-up)
--   * public.build_proposal(uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb)   from 20261125500000_build_proposal.sql: a visitor's idea may have no issue
-- No row is changed. No policy changes. `save_fields` is untouched. No engine change.
--
-- SECURITY MODEL
--   * One write. `anon` gains exactly one EXECUTE, `submit_play_proposal`, and still holds no table privilege. The function writes one
--     `suggestion_proposals` row (pending: the trigger forces it) and nothing else.
--   * Who can send: only through a live, unexpired, unrevoked `play` link found by the SHA-256 of its 256-bit token. A restricted link
--     (any toggle on) needs a signed-in visitor whose CONFIRMED email is listed AND who has a Google identity with that same email
--     (open_share_link's rule, copied); the email recorded is that verified one. API tokens are refused (42501).
--   * Rate limits per link, serialised by `for update` on the link row: 5 per 10 minutes, 50 per 24 hours; 10 per email per link per
--     24 hours; 200 pending visitor ideas per workspace. They run after the format checks and BEFORE the patch and leak checks.
--   * Ids: every id in a change must be in the link's frozen snapshot (checked first) and in the workspace; every miss gives one message
--     that names nothing, so the answer reveals nothing the page didn't. A hidden lever kind, a person's FTE without People on, and any
--     path no shared slider produces are refused.
--   * What a visitor types is read by members and viewers, so it is checked with `share_snapshot_problem` AS FOR A People-off,
--     Financials-off link, whatever the link's toggles. A field that fails is HELD, never refused (a refusal would tell an outsider
--     which words are the team's or a client's names): members and viewers read a stand-in ("A visitor's idea", no note, "A visitor"),
--     owners and editors the original (`play_proposal_contacts`). The visitor is told only {"status": "ok"}.
--   * Only `submit_play_proposal` can make a `play_link` row: it turns on `transpera.play_submitting` for its own statement (as
--     `import_process_bundle` does with `transpera.importing`), and the trigger honours it. Any other insert is `mcp` with no visitor
--     details and no link.
--
-- ORDER: after 20261220500000 (the workspace-delete fix, row 65), 20261220000000 (B3, row 64) and every earlier row; this is row 66. Renumber if anything later merges first.
--
-- PREFLIGHT (read-only; `prod-sql.sh -c`, one query at a time):
--   0. B3 and the workspace-delete fix applied, nothing at or past this one. Expect 20261219000000, 20261220000000, 20261220500000 and nothing >= '20261221000000':
--        select version from supabase_migrations.schema_migrations where version >= '20261219000000' order by 1;
--   1. Nothing created yet. Expect null x4 and 0, 0:
--        select to_regprocedure('public.submit_play_proposal(text, text, text, text, text, uuid, jsonb)'), to_regprocedure('public.play_proposal_contacts(uuid)'), to_regprocedure('private.play_patch_problem(uuid, public.share_links, jsonb)'), to_regprocedure('private.lever_kind_ids()'), (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'suggestion_proposals' and column_name in ('share_link_id', 'visitor_text')), (select count(*) from pg_indexes where indexname = 'suggestion_proposals_share_link_idx');
--   2. The six replaced functions are as reviewed. Expect exactly these six rows:
--        select n.nspname, p.proname, md5(p.prosrc), p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname, p.proname) in (('private','share_links_before_write'), ('private','share_snapshot_problem'), ('private','suggestion_proposals_before_write'), ('private','suggestions_before_write'), ('public','build_proposal'), ('public','open_share_link')) order by 1, 2;
--        private | share_links_before_write          | d62acd6761b553263ab52f6f2c5df312 | t
--        private | share_snapshot_problem            | 0bf3c675bdb2a030543a3151f1075178 | f
--        private | suggestion_proposals_before_write | c7e2a34a4f48034bbc132497eaa877db | f
--        private | suggestions_before_write          | 85b012ee7c6f30f05236fe3ea5f19ada | f
--        public  | build_proposal                    | b911a2835fd900d87c511ea69a2fa1dc | f
--        public  | open_share_link                   | 1f58a06299923867c9ca4e19b9f8fce6 | t
--      Any other md5 means production isn't what this migration copies: stop and report.
--   3. The constraint is the old one. Expect CHECK (((kind = 'solution_idea'::text) = (issue_id IS NOT NULL))):
--        select pg_get_constraintdef(oid) from pg_constraint where conname = 'suggestion_proposals_issue';
--   4. No play links, no visitor ideas, no solution with lever changes (so no number moves), and no link whose snapshot has a
--      `hiddenLevers` key (so the widened check can't refuse an existing link's Update copy for a reason it didn't before).
--      Expect 0, 0, 0, 0:
--        select (select count(*) from public.share_links where mode = 'play'), (select count(*) from public.suggestion_proposals where created_via = 'play_link'), (select count(*) from public.solutions where jsonb_array_length(lever_changes) > 0), (select count(*) from public.share_links where snapshot ? 'hiddenLevers');
--   5. Helpers exist. Expect 4 non-null values:
--        select to_regprocedure('private.is_scenario_patch(jsonb)'), to_regprocedure('public.can_edit_workspace(uuid)'), to_regprocedure('public.save_solution(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, jsonb)'), to_regprocedure('private.share_name_tokens(uuid, text)');
--
-- POST-APPLY CHECK:
--   1. Function privileges. Expect t, t, f, t, f, f, f, f:
--        select has_function_privilege('anon', 'public.submit_play_proposal(text, text, text, text, text, uuid, jsonb)', 'execute'),
--               has_function_privilege('authenticated', 'public.submit_play_proposal(text, text, text, text, text, uuid, jsonb)', 'execute'),
--               has_function_privilege('anon', 'public.play_proposal_contacts(uuid)', 'execute'),
--               has_function_privilege('authenticated', 'public.play_proposal_contacts(uuid)', 'execute'),
--               has_function_privilege('anon', 'private.play_patch_problem(uuid, public.share_links, jsonb)', 'execute'),
--               has_function_privilege('authenticated', 'private.play_patch_problem(uuid, public.share_links, jsonb)', 'execute'),
--               has_function_privilege('anon', 'private.lever_kind_ids()', 'execute'),
--               has_function_privilege('authenticated', 'private.lever_kind_ids()', 'execute');
--      B3's `open_share_link(text)` is still t, t (anon, authenticated) and `share_snapshot_problem` f, f.
--   2. prosecdef and settings. prosecdef t for submit_play_proposal, play_proposal_contacts, share_links_before_write and
--      open_share_link, f for the rest; every new and replaced function has proconfig = array['search_path=""']; open_share_link and
--      submit_play_proposal are volatile (provolatile = 'v'):
--        select proname, prosecdef, proconfig = array['search_path=""'], provolatile from pg_proc
--        where proname in ('submit_play_proposal', 'play_proposal_contacts', 'play_patch_problem', 'lever_kind_ids', 'share_links_before_write', 'share_snapshot_problem', 'open_share_link', 'suggestion_proposals_before_write', 'suggestions_before_write', 'build_proposal') order by 1;
--   3. The new constraints, validated:
--        select conname, pg_get_constraintdef(oid), convalidated from pg_constraint where conname in ('suggestion_proposals_issue', 'suggestion_proposals_visitor_text');
--   4. Columns and grants. `share_link_id` has an authenticated SELECT column grant and `visitor_text` has none (like `proposer_email`);
--      the partial index exists; `share_links` column grants for authenticated are SELECT 18, INSERT 12 (now with `mode`), UPDATE 4;
--      anon still holds nothing on either table:
--        select table_name, privilege_type, count(*) from information_schema.column_privileges where table_schema = 'public' and table_name in ('share_links', 'suggestion_proposals') and grantee in ('anon', 'authenticated') group by 1, 2 order by 1, 2;
--        select column_name from information_schema.column_privileges where table_schema = 'public' and table_name = 'suggestion_proposals' and grantee = 'authenticated' and column_name in ('share_link_id', 'visitor_text', 'proposer_email');
--      The second query returns share_link_id only.
--   5. The six replaced functions' md5s are now the new reviewed ones (they must differ from preflight 2's). Expect exactly:
--        private | share_links_before_write          | dde01d596ab29cee5e0ebf22500c2e31 | t
--        private | share_snapshot_problem            | efe3876b96194e39f921d74fed0288c5 | f
--        private | suggestion_proposals_before_write | baeec857413c73b7ff8c0d6799bc84cf | f
--        private | suggestions_before_write          | 568a368859ffb77317a97deb6b8036a5 | f
--        public  | build_proposal                    | d0c1f4cc029835b8f98a9b0dd2e0e6f4 | f
--        public  | open_share_link                   | 86058caad2e9ffdee3b3cdfb9a7e397d | t
--      (the same query as preflight 2.)
--   6. Smoke test, ROLLED BACK, as an agency admin on Northbeam (production Northbeam has no owner):
--        begin; set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated","app_metadata":{"agency_admin":true}}', true);
--        insert a `play` link to a published Northbeam process with the token hash of a known 43-character token and a minimal clean snapshot
--        {"v":1,"kind":"process","toggles":{"people":false,"financials":false},"hiddenLevers":["process.rework"],"workspaceName":"Northbeam","bundle":{"revision":{"id":"<live revision>"},"steps":[],"roles":[],"people":[],"services":[]},"issues":[]}
--        (engine_version '1.8.0') -> succeeds; the same with "hiddenLevers":["Priya"] -> 23514 "The snapshot doesn't match the link.";
--        set local role anon; select set_config('request.jwt.claims', '{"role":"anon"}', true);
--        select public.submit_play_proposal('<token>', 'Smoke', null, 'Smoke test', 'smoke@example.com', null, '[{"path":"demand.leads_per_week","op":"set","value":9}]') ->> 'status'; -> ok;
--        reset role; the row has created_via = 'play_link', created_by null, status = 'pending', visitor_text null;
--        a second call (as anon again) with the title set to a real person's full name -> ok, and that row's title is "A visitor's idea"
--        with the name in visitor_text;  rollback;
--
-- ROLLBACK (one transaction; redeploy the app from before B4 first). The full previous bodies are pasted, so after it preflight 2's
-- md5s come back. A test runs this block on a test database. Rolling back DELETES visitor ideas with no issue (and the held originals of
-- the rest: members' stand-ins stay); play links stay in `share_links` but no longer open (B3's open_share_link serves view links only);
-- `hiddenLevers` stays in stored snapshots, unread (the rolled-back app's Update copy rebuilds a snapshot without it, so B3's check never
-- has to pass it as text); solutions' stored lever changes stay (and stop counting once the app is rolled back):
--   begin;
--   drop function if exists public.submit_play_proposal(text, text, text, text, text, uuid, jsonb);
--   drop function if exists public.play_proposal_contacts(uuid);
--   drop function if exists private.play_patch_problem(uuid, public.share_links, jsonb);
--   create or replace function private.share_links_before_write() returns trigger
--   language plpgsql security definer
--   set search_path = ''
--   as $$
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
--       if new.mode <> 'view' then
--         raise exception 'Play links come later.' using errcode = '22023';
--       end if;
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
--   $$;
--   create or replace function private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
--   returns text
--   language plpgsql stable
--   set search_path = ''
--   as $$
--   declare
--     -- The keys whose strings are NOT free text: ids, dates, enums and selectors the engine reads (keep equal to SHARE_NON_TEXT_KEYS in
--     -- packages/db/src/share.ts). Any other string is free text, so a key nobody classified is checked, not skipped (default deny).
--     non_text_keys constant text[] := array['agreed_by', 'kpi', 'ai_key', 'analysis_id', 'archived_at', 'archived_by', 'at', 'auto_verdict',
--       'base_revision_id', 'by', 'child_process_id', 'client_id', 'color', 'comparator', 'condition_id', 'created_at',
--       'created_by', 'currency', 'dataset_id', 'decided_at', 'decided_by', 'detected_key', 'dismissed_revision_id',
--       'draft_revision_id', 'driver', 'end_date', 'entry_process_id', 'entry_step_id', 'every', 'file_url',
--       'from_step_id', 'id', 'import_source', 'input_hash', 'insight_key', 'issueId', 'issue_id', 'key', 'kind',
--       'linked_parameter', 'live_revision_id', 'market_pending_at', 'model', 'model_hash', 'op', 'origin', 'outcome',
--       'owner_ids', 'owner_person_id', 'parent_process_id', 'parent_scenario_id', 'parent_step_id', 'path',
--       'person_id', 'plan', 'preset', 'pricing_model', 'process_id', 'proposed_via', 'published_at', 'published_by',
--       'rating', 'recorded_at', 'replaced_by', 'replaces_step_ids', 'resolution', 'resolved_at', 'resolved_how',
--       'resolved_solution_id', 'reviewed_at', 'reviewed_by', 'revision_id', 'rework_to_step_id', 'role_id', 'run_id',
--       'scenario_id', 'service_id', 'severity', 'slug', 'solutionId', 'solution_id', 'source_id', 'source_ids',
--       'stage', 'start_date', 'started_at', 'status', 'step_id', 'suggestion_id', 'timestamp', 'to_step_id', 'type',
--       'updated_at', 'updated_by', 'user_id', 'user_verdict', 'verdict', 'wait_dist', 'work_dist', 'workspace_id'];
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
--        or snap -> 'toggles' -> 'financials' is distinct from to_jsonb(show_financials) then
--       return 'The snapshot doesn''t match the link.';
--     end if;
--     -- Every string value, normalised ONCE (the \x01 between them is no space and no letter, so nothing matches across two values),
--     -- and the free-text ones on their own. A bare uuid is skipped before it costs a normalisation.
--     select string_agg(n.v, E'\x01'), string_agg(n.v, E'\x01') filter (where n.k is null or n.k <> all (non_text_keys))
--       into everything, free
--       from (select s.k, private.share_norm(s.v) as v from private.share_strings(snap) as s
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
--       or exists (select 1 from private.share_name_tokens(ws, 'script') as s (part) where strpos(free, s.part) > 0)) then
--       return 'The snapshot names a person.';
--     end if;
--   
--     -- 7. Financials off: no costs, margins or overhead. A number stored as a string counts; so does a role-rate change inside a
--     -- scenario or a solution's lever changes (the visitor's browser would price work at the real rate); so does money in text.
--     if not show_financials and (
--          jsonb_path_exists(snap, 'lax $.**.default_cost_rate ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
--       or jsonb_path_exists(snap, 'lax $.**.margin ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
--       or jsonb_path_exists(snap, 'lax $.**.cost_override ? (@ != null)')
--       or jsonb_path_exists(snap, 'lax $.**.overhead_monthly')
--       or jsonb_path_exists(snap, 'lax $.**.target_margin')
--       or jsonb_path_exists(snap, 'lax $.**.path ? (@ like_regex "cost_rate$")')
--       or everything ~* ('[£$€¥₹][[:space:]]*[0-9]|[0-9][[:space:]]*[£€¥₹]'
--         || '|(^|[^a-z0-9])(gbp|usd|eur|aud|nzd|cad|rs\.?)[[:space:]/-]*[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?([^a-z0-9]|$)'
--         || '|(^|[^a-z0-9])[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?[[:space:]/-]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'
--         || '|[0-9]([[:space:]]*(k|m|bn))?[[:space:]]*(pounds?|dollars?|euros?|quid|sterling)([^a-z]|$)')) then
--       return 'The snapshot contains costs or margins.';
--     end if;
--   
--     return null;
--   end;
--   $$;
--   drop function if exists private.lever_kind_ids();
--   create or replace function public.open_share_link(token text) returns jsonb
--   language plpgsql volatile security definer
--   set search_path = ''
--   as $$
--   declare
--     l public.share_links;
--     e text;
--   begin
--     if token is null or token !~ '^[A-Za-z0-9_-]{43}$' then
--       return null;
--     end if;
--     select * into l from public.share_links s
--       where s.token_hash = encode(pg_catalog.sha256(pg_catalog.convert_to(token, 'UTF8')), 'hex')
--         and s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and s.mode = 'view';
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
--   $$;
--   create or replace function private.suggestion_proposals_before_write() returns trigger
--   language plpgsql
--   set search_path = ''
--   as $$
--   begin
--     if tg_op = 'INSERT' then
--       new.status := 'pending';
--       new.applied := null;
--       new.review_note := null;
--       new.reviewed_by := null;
--       new.reviewed_at := null;
--       new.created_by := auth.uid();
--       -- A signed-in request (the app, or the MCP server with a token) can't pass as a visitor.
--       if auth.uid() is not null then
--         -- An upload (public.import_process_bundle) says so for the duration of its own statement; anything else is MCP.
--         new.created_via := case when coalesce(current_setting('transpera.importing', true), '') = 'on' then 'upload' else 'mcp' end;
--         new.proposer_name := null;
--         new.proposer_email := null;
--         if new.created_via <> 'upload' then new.import_source := null; end if;
--       end if;
--       return new;
--     end if;
--     -- Deleting a user sets `created_by` or `reviewed_by` to null through the foreign key's own trigger (depth 2 here).
--     -- That, and nothing else, is let through.
--     if pg_catalog.pg_trigger_depth() > 1
--       and (to_jsonb(new) - 'created_by' - 'reviewed_by' - 'updated_at') = (to_jsonb(old) - 'created_by' - 'reviewed_by' - 'updated_at')
--       and (new.created_by is null or new.created_by is not distinct from old.created_by)
--       and (new.reviewed_by is null or new.reviewed_by is not distinct from old.reviewed_by) then
--       return new;
--     end if;
--     if new.workspace_id is distinct from old.workspace_id or new.kind is distinct from old.kind
--       or new.title is distinct from old.title or new.detail is distinct from old.detail
--       or new.payload is distinct from old.payload or new.evidence is distinct from old.evidence
--       or new.note is distinct from old.note or new.issue_id is distinct from old.issue_id
--       or new.created_via is distinct from old.created_via or new.import_source is distinct from old.import_source or new.proposer_name is distinct from old.proposer_name
--       or new.proposer_email is distinct from old.proposer_email or new.created_by is distinct from old.created_by
--       or new.created_at is distinct from old.created_at then
--       raise exception 'A proposal can''t be changed, only accepted, rejected or dismissed' using errcode = '42501';
--     end if;
--     if new.status is distinct from old.status or new.applied is distinct from old.applied
--       or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
--       or new.review_note is distinct from old.review_note then
--       if old.status <> 'pending' or coalesce(current_setting('transpera.reviewing_proposals', true), '') <> 'on' then
--         raise exception 'Proposals are decided with review_proposals' using errcode = '42501';
--       end if;
--     end if;
--     return new;
--   end;
--   $$;
--   create or replace function private.suggestions_before_write() returns trigger
--   language plpgsql
--   set search_path = ''
--   as $$
--   begin
--     if tg_op = 'INSERT' then
--       new.status := 'pending';
--       new.applied := null;
--       new.review_note := null;
--       new.reviewed_by := null;
--       new.reviewed_at := null;
--       new.created_by := auth.uid();
--       -- Only an upload (public.import_process_bundle, which turns `transpera.importing` on for its own statement) can say so.
--       new.created_via := case when coalesce(current_setting('transpera.importing', true), '') = 'on' then 'upload' else 'mcp' end;
--       if new.created_via <> 'upload' then new.import_source := null; end if;
--       return new;
--     end if;
--     if new.workspace_id is distinct from old.workspace_id or new.target_table is distinct from old.target_table
--       or new.target_id is distinct from old.target_id or new.patch is distinct from old.patch
--       or new.evidence is distinct from old.evidence or new.note is distinct from old.note
--       or new.created_via is distinct from old.created_via or new.import_source is distinct from old.import_source or new.created_by is distinct from old.created_by
--       or new.created_at is distinct from old.created_at then
--       raise exception 'A suggestion can''t be changed, only accepted or rejected' using errcode = '42501';
--     end if;
--     if new.status is distinct from old.status or new.applied is distinct from old.applied
--       or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
--       or new.review_note is distinct from old.review_note then
--       if old.status <> 'pending' or coalesce(current_setting('transpera.reviewing', true), '') <> 'on' then
--         raise exception 'Suggestions are accepted or rejected with review_suggestions' using errcode = '42501';
--       end if;
--     end if;
--     return new;
--   end;
--   $$;
--   create or replace function public.build_proposal(
--     p_proposal uuid, p_workspace uuid, p_process uuid, p_base_revision uuid, p_name text, p_steps jsonb, p_changed jsonb,
--     p_levers jsonb, p_links jsonb)
--   returns jsonb
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--   declare
--     v_kind text;
--     v_status text;
--     v_issue uuid;
--     result jsonb;
--   begin
--     if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
--       raise exception 'Ideas are built by a person in the app, not over the API' using errcode = '42501';
--     end if;
--     select x.kind, x.status, x.issue_id into v_kind, v_status, v_issue
--       from public.suggestion_proposals x where x.id = p_proposal and x.workspace_id = p_workspace for update;
--     if not found then
--       raise exception 'build_proposal: no such idea' using errcode = '42501';
--     end if;
--     if v_kind <> 'solution_idea' then
--       raise exception 'build_proposal: only a solution idea can be built' using errcode = '22023';
--     end if;
--     if v_status <> 'pending' then
--       raise exception 'build_proposal: that idea has already been dealt with' using errcode = '22023';
--     end if;
--     -- The solution must be for the idea's own issue: otherwise any solution could be passed off as built from it.
--     if jsonb_typeof(p_links) is distinct from 'array' or not exists (
--       select 1 from jsonb_array_elements(p_links) l where l ->> 'issue_id' = v_issue::text) then
--       raise exception 'build_proposal: the solution must be linked to the idea''s issue' using errcode = '22023';
--     end if;
--   
--     -- The solution, as A49 saves it (its own checks and row-level security apply).
--     result := public.save_solution(p_workspace, p_process, p_base_revision, p_name, p_steps, p_changed, p_levers, p_links);
--   
--     perform set_config('transpera.reviewing_proposals', 'on', true);
--     update public.suggestion_proposals x
--       set status = 'built', applied = jsonb_build_object('solution_id', result ->> 'id'), reviewed_by = auth.uid(), reviewed_at = now()
--     where x.id = p_proposal;
--     perform set_config('transpera.reviewing_proposals', '', true);
--     return result;
--   end;
--   $$;
--   revoke insert (mode) on public.share_links from authenticated;
--   delete from public.suggestion_proposals where created_via = 'play_link' and issue_id is null;
--   alter table public.suggestion_proposals drop constraint suggestion_proposals_issue,
--     add constraint suggestion_proposals_issue check ((kind = 'solution_idea') = (issue_id is not null));
--   drop index if exists public.suggestion_proposals_share_link_idx;
--   alter table public.suggestion_proposals drop column if exists visitor_text;
--   alter table public.suggestion_proposals drop column if exists share_link_id;
--   delete from supabase_migrations.schema_migrations where version = '20261221000000';
--   commit;
--
-- Production data: none needed.

-- ---------------------------------------------------------------------------
-- 1. What a visitor's idea records, and the widened issue rule
-- ---------------------------------------------------------------------------

-- The play link a visitor's idea came from. Not a foreign key: links are never deleted (only revoked), and a set-null action
-- would trip this table's guard trigger when a workspace is deleted.
alter table public.suggestion_proposals add column share_link_id uuid;
create index suggestion_proposals_share_link_idx on public.suggestion_proposals (share_link_id, created_at desc)
  where share_link_id is not null;
grant select (share_link_id) on public.suggestion_proposals to authenticated;

-- What a visitor typed, when part of it can't be shown to members and viewers: {"title", "note", "name"}, only the held fields.
-- NOT granted to authenticated (like proposer_email): owners and editors read it through play_proposal_contacts.
alter table public.suggestion_proposals add column visitor_text jsonb
  constraint suggestion_proposals_visitor_text check (visitor_text is null or (jsonb_typeof(visitor_text) = 'object'
    and visitor_text <> '{}'::jsonb and (visitor_text - 'title' - 'note' - 'name') = '{}'::jsonb
    and octet_length(visitor_text::text) <= 8192));

-- A visitor's idea from a play link may be for no issue: they may not know which problem it fixes.
-- Every existing row satisfies the old rule `(kind = 'solution_idea') = (issue_id is not null)`, so it satisfies this one.
alter table public.suggestion_proposals drop constraint suggestion_proposals_issue,
  add constraint suggestion_proposals_issue check (
    (kind = 'issue' and issue_id is null)
    or (kind = 'solution_idea' and (issue_id is not null or created_via = 'play_link'))) not valid;
alter table public.suggestion_proposals validate constraint suggestion_proposals_issue;

-- B3 left `mode` out of the insert grant on purpose ('view' only until B4).
grant insert (mode) on public.share_links to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The lever kinds
-- ---------------------------------------------------------------------------

-- The lever kinds of apps/web/src/lib/scenarios/lever-catalogue.ts (LEVER_KINDS), in its order. A test keeps them equal.
create function private.lever_kind_ids() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['demand.enquiries', 'demand.conversion', 'demand.seasonal', 'demand.growth', 'people.headcount', 'people.hours',
    'people.starters', 'people.leave', 'process.time', 'process.wait', 'process.rework', 'process.routing', 'clients.count',
    'clients.fee', 'clients.churn', 'clients.causes', 'finances.prices', 'finances.roleCost', 'finances.fixed',
    'market.conditions', 'market.schedule']
$$;

revoke execute on function private.lever_kind_ids() from public;

-- ---------------------------------------------------------------------------
-- 4. Functions replaced (each a full copy of the body named in the header; only the `-- B4` lines differ)
-- ---------------------------------------------------------------------------

create or replace function private.suggestion_proposals_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.applied := null;
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.created_by := auth.uid();
    -- B4 begin
    -- A visitor's idea, inserted by public.submit_play_proposal for its own statement. Nobody else can say play_link.
    if coalesce(current_setting('transpera.play_submitting', true), '') = 'on' then
      new.created_via := 'play_link';
      new.created_by := null;            -- a visitor isn't a member, even when signed in for a restricted link
      new.import_source := null;
      return new;
    end if;
    new.share_link_id := null;           -- only a play submission names a link
    new.visitor_text := null;            -- and only it holds a visitor's text back
    -- B4 end
    -- A signed-in request (the app, or the MCP server with a token) can't pass as a visitor.
    if auth.uid() is not null then
      -- An upload (public.import_process_bundle) says so for the duration of its own statement; anything else is MCP.
      new.created_via := case when coalesce(current_setting('transpera.importing', true), '') = 'on' then 'upload' else 'mcp' end;
      new.proposer_name := null;
      new.proposer_email := null;
      if new.created_via <> 'upload' then new.import_source := null; end if;
    end if;
    return new;
  end if;
  -- Deleting a user sets `created_by` or `reviewed_by` to null through the foreign key's own trigger (depth 2 here).
  -- That, and nothing else, is let through.
  if pg_catalog.pg_trigger_depth() > 1
    and (to_jsonb(new) - 'created_by' - 'reviewed_by' - 'updated_at') = (to_jsonb(old) - 'created_by' - 'reviewed_by' - 'updated_at')
    and (new.created_by is null or new.created_by is not distinct from old.created_by)
    and (new.reviewed_by is null or new.reviewed_by is not distinct from old.reviewed_by) then
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id or new.kind is distinct from old.kind
    or new.title is distinct from old.title or new.detail is distinct from old.detail
    or new.payload is distinct from old.payload or new.evidence is distinct from old.evidence
    or new.note is distinct from old.note or new.issue_id is distinct from old.issue_id
    or new.created_via is distinct from old.created_via or new.import_source is distinct from old.import_source or new.proposer_name is distinct from old.proposer_name
    or new.proposer_email is distinct from old.proposer_email or new.created_by is distinct from old.created_by
    or new.share_link_id is distinct from old.share_link_id or new.visitor_text is distinct from old.visitor_text  -- B4
    or new.created_at is distinct from old.created_at then
    raise exception 'A proposal can''t be changed, only accepted, rejected or dismissed' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.applied is distinct from old.applied
    or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
    or new.review_note is distinct from old.review_note then
    if old.status <> 'pending' or coalesce(current_setting('transpera.reviewing_proposals', true), '') <> 'on' then
      raise exception 'Proposals are decided with review_proposals' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.suggestions_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.applied := null;
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.created_by := auth.uid();
    -- Only an upload (public.import_process_bundle, which turns `transpera.importing` on for its own statement) can say so.
    new.created_via := case when coalesce(current_setting('transpera.importing', true), '') = 'on' then 'upload' else 'mcp' end;
    if new.created_via <> 'upload' then new.import_source := null; end if;
    return new;
  end if;
  -- B4 begin
  -- Deleting a user sets `created_by` or `reviewed_by` to null through the foreign key's own trigger (depth 2 here).
  -- That, and nothing else, is let through (as private.suggestion_proposals_before_write does).
  if pg_catalog.pg_trigger_depth() > 1
    and (to_jsonb(new) - 'created_by' - 'reviewed_by' - 'updated_at') = (to_jsonb(old) - 'created_by' - 'reviewed_by' - 'updated_at')
    and (new.created_by is null or new.created_by is not distinct from old.created_by)
    and (new.reviewed_by is null or new.reviewed_by is not distinct from old.reviewed_by) then
    return new;
  end if;
  -- B4 end
  if new.workspace_id is distinct from old.workspace_id or new.target_table is distinct from old.target_table
    or new.target_id is distinct from old.target_id or new.patch is distinct from old.patch
    or new.evidence is distinct from old.evidence or new.note is distinct from old.note
    or new.created_via is distinct from old.created_via or new.import_source is distinct from old.import_source or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'A suggestion can''t be changed, only accepted or rejected' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.applied is distinct from old.applied
    or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
    or new.review_note is distinct from old.review_note then
    if old.status <> 'pending' or coalesce(current_setting('transpera.reviewing', true), '') <> 'on' then
      raise exception 'Suggestions are accepted or rejected with review_suggestions' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.build_proposal(
  p_proposal uuid, p_workspace uuid, p_process uuid, p_base_revision uuid, p_name text, p_steps jsonb, p_changed jsonb,
  p_levers jsonb, p_links jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kind text;
  v_status text;
  v_issue uuid;
  v_via text;  -- B4
  v_payload jsonb;  -- B4
  result jsonb;
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Ideas are built by a person in the app, not over the API' using errcode = '42501';
  end if;
  select x.kind, x.status, x.issue_id, x.created_via, x.payload into v_kind, v_status, v_issue, v_via, v_payload  -- B4
    from public.suggestion_proposals x where x.id = p_proposal and x.workspace_id = p_workspace for update;
  if not found then
    raise exception 'build_proposal: no such idea' using errcode = '42501';
  end if;
  if v_kind <> 'solution_idea' then
    raise exception 'build_proposal: only a solution idea can be built' using errcode = '22023';
  end if;
  if v_status <> 'pending' then
    raise exception 'build_proposal: that idea has already been dealt with' using errcode = '22023';
  end if;
  -- The solution must be for the idea's own issue: otherwise any solution could be passed off as built from it.
  if v_issue is not null then  -- B4
  if jsonb_typeof(p_links) is distinct from 'array' or not exists (
    select 1 from jsonb_array_elements(p_links) l where l ->> 'issue_id' = v_issue::text) then
    raise exception 'build_proposal: the solution must be linked to the idea''s issue' using errcode = '22023';
  end if;
  -- B4 begin
  elsif v_via is distinct from 'play_link' then
    raise exception 'build_proposal: the solution must be linked to the idea''s issue' using errcode = '22023';  -- can't happen (constraint)
  end if;
  -- A visitor's idea is built on the process its link shared.
  if v_via = 'play_link' and v_payload ->> 'process_id' is distinct from p_process::text then
    raise exception 'build_proposal: that idea is for another process' using errcode = '22023';
  end if;
  -- B4 end

  -- The solution, as A49 saves it (its own checks and row-level security apply).
  result := public.save_solution(p_workspace, p_process, p_base_revision, p_name, p_steps, p_changed, p_levers, p_links);

  perform set_config('transpera.reviewing_proposals', 'on', true);
  update public.suggestion_proposals x
    set status = 'built', applied = jsonb_build_object('solution_id', result ->> 'id'), reviewed_by = auth.uid(), reviewed_at = now()
  where x.id = p_proposal;
  perform set_config('transpera.reviewing_proposals', '', true);
  return result;
end;
$$;

create or replace function private.share_links_before_write() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  ok boolean;
  problem text;
begin
  -- A foreign-key action (a deleted user nulls created_by / revoked_by) runs one trigger level deeper than a direct write.
  -- It may change those two columns to null and nothing else.
  if tg_op = 'UPDATE' and pg_catalog.pg_trigger_depth() > 1
     and (to_jsonb(new) - 'created_by' - 'revoked_by') = (to_jsonb(old) - 'created_by' - 'revoked_by')
     and (new.created_by is null or new.created_by = old.created_by)
     and (new.revoked_by is null or new.revoked_by = old.revoked_by) then
    return new;
  end if;

  -- 1. No API tokens (the MCP server): share links are made in the app. `open_share_link` only counts opens on a row, and
  -- an API-token caller may open a link like anyone, so a counter-only update is not refused.
  if coalesce(auth.jwt(), '{}') ? 'api_token_id'
     and (tg_op = 'INSERT' or new.snapshot is distinct from old.snapshot or new.label is distinct from old.label
          or new.revoked_at is distinct from old.revoked_at or new.engine_version is distinct from old.engine_version) then
    raise exception 'Share links are made in the app.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    -- 2. Stamp the caller; nothing the caller sends for these counts.
    new.created_by := auth.uid();
    new.created_at := now();
    new.snapshot_at := now();
    new.opens := 0;
    new.last_opened_at := null;
    new.revoked_at := null;
    new.revoked_by := null;
    -- B4 begin
    -- A play link shares a process, and its snapshot says which levers the workspace hides (the kinds are checked by
    -- share_snapshot_problem, below).
    if new.mode = 'play' and (new.kind <> 'process' or jsonb_typeof(new.snapshot -> 'hiddenLevers') is distinct from 'array') then
      raise exception 'Only a process can be shared for trying changes.' using errcode = '22023';
    end if;
    -- B4 end
    if new.expires_at is not null and new.expires_at <= now() then
      raise exception 'The end date must be in the future.' using errcode = '22023';
    end if;
    ok := case new.kind
      when 'overview' then true
      when 'process' then exists (
        select 1 from public.processes p
        where p.id = new.target_id and p.workspace_id = new.workspace_id and p.live_revision_id is not null
          and p.archived_at is null and not p.is_company)
      when 'issue' then exists (
        select 1 from public.issues i where i.id = new.target_id and i.workspace_id = new.workspace_id)
      when 'solution' then exists (
        select 1 from public.solutions s where s.id = new.target_id and s.workspace_id = new.workspace_id)
      else false end;
    if not ok then
      raise exception 'That isn''t in this workspace.' using errcode = '22023';
    end if;
    -- An issue or a solution of an archived process shows that process (every process an issue is on, its own or linked): refused
    -- like the process itself, with its own message.
    if new.kind in ('issue', 'solution') and (
         (new.kind = 'issue' and exists (
            select 1 from public.processes p
            where p.workspace_id = new.workspace_id and p.archived_at is not null
              and (p.id = (select i.process_id from public.issues i where i.id = new.target_id)
                or p.id in (select l.process_id from public.issue_links l where l.issue_id = new.target_id and l.process_id is not null))))
      or (new.kind = 'solution' and exists (
            select 1 from public.solutions s join public.processes p on p.id = s.process_id
            where s.id = new.target_id and p.archived_at is not null))) then
      raise exception 'An archived process can''t be shared. Restore it first.' using errcode = '22023';
    end if;
  else
    -- 3. Update. A revoked link stays revoked: no change at all.
    if old.revoked_at is not null then
      raise exception 'This link was turned off.' using errcode = '22023';
    end if;
    if new.workspace_id is distinct from old.workspace_id or new.token_hash is distinct from old.token_hash
       or new.kind is distinct from old.kind or new.target_id is distinct from old.target_id
       or new.mode is distinct from old.mode or new.show_people is distinct from old.show_people
       or new.show_financials is distinct from old.show_financials or new.allowed_emails is distinct from old.allowed_emails
       or new.expires_at is distinct from old.expires_at or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'A link''s settings can''t be changed. Make a new link.' using errcode = '22023';
    end if;
    -- B4 begin
    -- A play link's new snapshot must still carry the list (Update copy rebuilds it through loadShareData, which always adds it).
    if new.mode = 'play' and new.snapshot is distinct from old.snapshot
       and jsonb_typeof(new.snapshot -> 'hiddenLevers') is distinct from 'array' then
      raise exception 'Only a process can be shared for trying changes.' using errcode = '22023';
    end if;
    -- B4 end
    if new.revoked_at is not null then
      new.revoked_at := now();
      new.revoked_by := auth.uid();
    else
      new.revoked_by := old.revoked_by;
    end if;
    if new.snapshot is distinct from old.snapshot then
      new.snapshot_at := now();
    else
      new.snapshot_at := old.snapshot_at;
    end if;
  end if;

  -- 4. The leak check: on insert and whenever the snapshot changes.
  if tg_op = 'INSERT' or new.snapshot is distinct from old.snapshot then
    problem := private.share_snapshot_problem(new.workspace_id, new.kind, new.snapshot, new.show_people, new.show_financials);
    if problem is not null then
      raise exception '%', problem using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  -- The keys whose strings are NOT free text: ids, dates, enums and selectors the engine reads (keep equal to SHARE_NON_TEXT_KEYS in
  -- packages/db/src/share.ts). Any other string is free text, so a key nobody classified is checked, not skipped (default deny).
  non_text_keys constant text[] := array['agreed_by', 'kpi', 'ai_key', 'analysis_id', 'archived_at', 'archived_by', 'at', 'auto_verdict',
    'base_revision_id', 'by', 'child_process_id', 'client_id', 'color', 'comparator', 'condition_id', 'created_at',
    'created_by', 'currency', 'dataset_id', 'decided_at', 'decided_by', 'detected_key', 'dismissed_revision_id',
    'draft_revision_id', 'driver', 'end_date', 'entry_process_id', 'entry_step_id', 'every', 'file_url',
    'from_step_id', 'id', 'import_source', 'input_hash', 'insight_key', 'issueId', 'issue_id', 'key', 'kind',
    'linked_parameter', 'live_revision_id', 'market_pending_at', 'model', 'model_hash', 'op', 'origin', 'outcome',
    'owner_ids', 'owner_person_id', 'parent_process_id', 'parent_scenario_id', 'parent_step_id', 'path',
    'person_id', 'plan', 'preset', 'pricing_model', 'process_id', 'proposed_via', 'published_at', 'published_by',
    'rating', 'recorded_at', 'replaced_by', 'replaces_step_ids', 'resolution', 'resolved_at', 'resolved_how',
    'resolved_solution_id', 'reviewed_at', 'reviewed_by', 'revision_id', 'rework_to_step_id', 'role_id', 'run_id',
    'scenario_id', 'service_id', 'severity', 'slug', 'solutionId', 'solution_id', 'source_id', 'source_ids',
    'stage', 'start_date', 'started_at', 'status', 'step_id', 'suggestion_id', 'timestamp', 'to_step_id', 'type',
    'hiddenLevers',  -- B4: the kinds a play link hides: known kind ids only, checked in step 1 below
    'updated_at', 'updated_by', 'user_id', 'user_verdict', 'verdict', 'wait_dist', 'work_dist', 'workspace_id'];
  everything text;
  free text;
  ft text[];
  nm record;
  parts text[];
  joined text;
  latin constant text := U&'[a-z\00C0-\024F\1E00-\1EFF]';
  script constant text := U&'^[\1100-\11FF\AC00-\D7AF\3040-\30FF\3400-\4DBF\4E00-\9FFF\F900-\FAFF]{2,}$';
begin
  -- 1. The snapshot is the link's.
  if snap is null or jsonb_typeof(snap) <> 'object'
     or snap -> 'v' is distinct from '1'::jsonb
     or snap -> 'kind' is distinct from to_jsonb(kind)
     or jsonb_typeof(snap -> 'toggles') is distinct from 'object'
     or snap -> 'toggles' -> 'people' is distinct from to_jsonb(show_people)
     or snap -> 'toggles' -> 'financials' is distinct from to_jsonb(show_financials)  -- B4
     -- B4 begin
     -- The kinds a play link hides. Not free text: only known kind ids (so the key can't smuggle a name).
     -- (CASE, not OR: Postgres doesn't promise to stop before jsonb_array_length on a non-array)
     or (snap ? 'hiddenLevers' and case when jsonb_typeof(snap -> 'hiddenLevers') <> 'array' then true else (
         jsonb_array_length(snap -> 'hiddenLevers') > 30
         or exists (select 1 from jsonb_array_elements(snap -> 'hiddenLevers') h
                    where jsonb_typeof(h) <> 'string' or not (h #>> '{}' = any (private.lever_kind_ids())))
         or (select count(distinct h) from jsonb_array_elements(snap -> 'hiddenLevers') h) <> jsonb_array_length(snap -> 'hiddenLevers')) end)
     -- B4 end
     then  -- B4
    return 'The snapshot doesn''t match the link.';
  end if;
  -- Every string value, normalised ONCE (the \x01 between them is no space and no letter, so nothing matches across two values),
  -- and the free-text ones on their own. A bare uuid is skipped before it costs a normalisation.
  select string_agg(n.v, E'\x01'), string_agg(n.v, E'\x01') filter (where n.k is null or n.k <> all (non_text_keys))
    into everything, free
    from (select s.k, private.share_norm(s.v) as v from private.share_strings(snap) as s
          where s.v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') as n;
  everything := coalesce(everything, '');
  free := coalesce(free, '');

  -- 2. No email address, in any string value. The part before the @ ends in a letter, digit or one of _ % + - (so
  -- `roles.@busiest.headcount`, a scenario's selector, is not one).
  if everything ~* '[a-z0-9._%+-]*[a-z0-9_%+-]@[a-z0-9.-]+\.[a-z]{2,}' then
    return 'The snapshot contains an email address.';
  end if;

  -- 3. No pay, for anyone, whatever the toggles (Austin, 6 Oct: no pay data). A string counts as a value.
  if jsonb_path_exists(snap, 'lax $.**.cost_rate ? (@ != null)') then
    return 'The snapshot contains a person''s pay.';
  end if;

  -- 4. No evidence notes: provenance of any JSON type (an empty object or null is fine), and quotes from sources cited as facts.
  if jsonb_path_exists(snap, 'lax $.**.provenance.*')
     or jsonb_path_exists(snap, 'strict $.**.provenance ? (@.type() != "object" && @.type() != "null")')
     or jsonb_path_exists(snap, 'lax $.**.facts ? (@.kind == "quote")') then
    return 'The snapshot contains evidence notes.';
  end if;

  -- 5. Clients are always anonymised, by the whole of the name: its words (stop words left out) one after another in free text
  -- with at most three non-letters between, or run together; never by one word of it ("Group review" is no client).
  select array_agg(distinct t) into ft from regexp_split_to_table(free, '[^[:alpha:]]+') as t where t <> '';
  ft := coalesce(ft, '{}');
  for nm in select private.share_norm(v.name) as name
            from (select c.name from public.clients c where c.workspace_id = ws
                  union
                  select pg_catalog.translate(c.name, U&'\00E4\00F6\00FC\00C4\00D6\00DC', 'aouAOU') from public.clients c where c.workspace_id = ws) as v loop
    parts := array(select x from unnest(regexp_split_to_array(nm.name, '[^[:alpha:]]+')) as x
                   where x <> '' and x not in ('the', 'and', 'for', 'ltd', 'inc', 'llc', 'plc'));
    joined := array_to_string(parts, '');
    continue when cardinality(parts) = 0 or char_length(joined) < (case when joined ~ latin then 3 else 2 end)
               or joined in ('team', 'member', 'client', 'hidden', 'email', 'amount');
    if joined = any (ft) or (joined ~ script and strpos(free, joined) > 0) then
      return 'The snapshot names a client.';
    end if;
    if cardinality(parts) > 1 and parts <@ ft
       and free ~ ('(^|[^[:alpha:]])' || array_to_string(parts, '(([^[:alpha:]]{1,3}(and|the|for|ltd|inc|llc|plc)){0,2}[^[:alpha:]]{1,3})') || '($|[^[:alpha:]])') then
      return 'The snapshot names a client.';
    end if;
  end loop;

  -- 6. People are labels unless People is on: no token of a person's name (first name, surname, any part) in free text, so a name
  -- token can't survive next to a "Team member N" label either; and no Han, Kana or Hangul part of a name anywhere in it.
  if not show_people and (
       exists (select 1 from regexp_split_to_table(free, '[^[:alpha:]]+') as w (tok)
                where w.tok in (select private.share_name_tokens(ws, 'person')))
    or exists (select 1 from private.share_name_tokens(ws, 'script') as s (part) where strpos(free, s.part) > 0)) then
    return 'The snapshot names a person.';
  end if;

  -- 7. Financials off: no costs, margins or overhead. A number stored as a string counts; so does a role-rate change inside a
  -- scenario or a solution's lever changes (the visitor's browser would price work at the real rate); so does money in text.
  if not show_financials and (
       jsonb_path_exists(snap, 'lax $.**.default_cost_rate ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
    or jsonb_path_exists(snap, 'lax $.**.margin ? (@.type() == "string" || (@.type() == "number" && @ != 0))')
    or jsonb_path_exists(snap, 'lax $.**.cost_override ? (@ != null)')
    or jsonb_path_exists(snap, 'lax $.**.overhead_monthly')
    or jsonb_path_exists(snap, 'lax $.**.target_margin')
    or jsonb_path_exists(snap, 'lax $.**.path ? (@ like_regex "cost_rate$")')
    or everything ~* ('[£$€¥₹][[:space:]]*[0-9]|[0-9][[:space:]]*[£€¥₹]'
      || '|(^|[^a-z0-9])(gbp|usd|eur|aud|nzd|cad|rs\.?)[[:space:]/-]*[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?([^a-z0-9]|$)'
      || '|(^|[^a-z0-9])[0-9][0-9.,]*(e[+-]?[0-9]+)?([[:space:]]*(k|m|bn))?[[:space:]/-]*(gbp|usd|eur|aud|nzd|cad)([^a-z0-9]|$)'
      || '|[0-9]([[:space:]]*(k|m|bn))?[[:space:]]*(pounds?|dollars?|euros?|quid|sterling)([^a-z]|$)')) then
    return 'The snapshot contains costs or margins.';
  end if;

  return null;
end;
$$;

create or replace function public.open_share_link(token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  l public.share_links;
  e text;
begin
  if token is null or token !~ '^[A-Za-z0-9_-]{43}$' then
    return null;
  end if;
  select * into l from public.share_links s
    where s.token_hash = encode(pg_catalog.sha256(pg_catalog.convert_to(token, 'UTF8')), 'hex')
      and s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and s.mode in ('view', 'play');  -- B4
  if not found then
    return null;
  end if;
  if l.show_people or l.show_financials then
    if auth.uid() is null then
      return jsonb_build_object('status', 'sign_in');
    end if;
    -- A confirmed address AND a Google identity whose own email is that address (any case): a password sign-up with a listed
    -- address is not the person it names, and neither is an account that links an unrelated Google identity to it.
    select lower(u.email) into e from auth.users u
      where u.id = auth.uid() and u.email_confirmed_at is not null
        and exists (select 1 from auth.identities i
                     where i.user_id = u.id and i.provider = 'google'
                       and lower(i.identity_data ->> 'email') = lower(u.email));
    if e is null or not (e = any (l.allowed_emails)) then
      return jsonb_build_object('status', 'not_allowed');
    end if;
  end if;
  update public.share_links set opens = opens + 1, last_opened_at = now() where id = l.id;
  return jsonb_build_object('status', 'ok', 'kind', l.kind, 'mode', l.mode, 'show_people', l.show_people,
    'show_financials', l.show_financials, 'snapshot_at', l.snapshot_at, 'expires_at', l.expires_at, 'snapshot', l.snapshot);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Is this set of lever changes allowed from this link?
-- ---------------------------------------------------------------------------

-- Returns null when every change is acceptable, else a plain message that names no id and no value. Only the definer function
-- below calls it. The families mirror `leverKindId` (lib/scenarios/lever-catalogue.ts) and `buildLevers` (lib/scenarios/levers.ts):
-- the paths a shared slider can produce, and nothing else. An id must be in the link's frozen snapshot FIRST, then in the
-- workspace, and both misses read the same, so the answer tells an outsider nothing the page didn't already show.
create function private.play_patch_problem(ws uuid, link public.share_links, levers jsonb) returns text
language plpgsql stable
set search_path = ''
as $$
declare
  hidden jsonb := coalesce(link.snapshot -> 'hiddenLevers', '[]'::jsonb);
  refuse constant text := 'One of those changes can''t be sent from a shared link.';
  out_of_range constant text := 'One of the values is out of range.';
  missing constant text := 'One of those changes points at something that isn''t in this page.';
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  n integer;
  el jsonb;
  p text;
  o text;
  v numeric;
  m text[];
  fam text;
  sid text;
  v_kind text;
  set_hi numeric;   -- null: `set` is not allowed
  mul_ok boolean;
  whole boolean;
  in_snap boolean;
  in_ws boolean;
begin
  if jsonb_typeof(levers) is distinct from 'array' then
    return 'Those changes aren''t valid.';
  end if;
  n := jsonb_array_length(levers);
  if n = 0 then
    return 'Move at least one lever first.';
  end if;
  if n > 50 then
    return 'Send at most 50 changes.';
  end if;
  if not private.is_scenario_patch(levers) then
    return 'Those changes aren''t valid.';
  end if;
  if (select count(distinct e ->> 'path') from jsonb_array_elements(levers) e) <> n then
    return 'Each lever can only be sent once.';
  end if;

  for el in select e from jsonb_array_elements(levers) e loop
    p := el ->> 'path';
    o := el ->> 'op';
    v := (el -> 'value')::text::numeric;
    sid := null;
    whole := false;
    mul_ok := false;
    set_hi := null;
    fam := null;

    -- 3. The path is one a shared slider produces.
    if p = 'demand.leads_per_week' then
      v_kind := 'demand.enquiries'; set_hi := 10000;
    elsif p = 'demand.active_clients' then
      v_kind := 'clients.count'; set_hi := 100000; whole := true;
    elsif p = 'demand.churn_monthly' then
      v_kind := 'clients.churn'; set_hi := 1;
    elsif p = 'finances.retainer' then
      v_kind := 'finances.prices'; set_hi := 10000000;
    else
      m := regexp_match(p, '^(services|roles|people|steps)\.([^.]+)\.(price|headcount|fte|work_hours|wait_hours|rework_rate)$');
      if m is null or left(m[2], 1) = '@' then
        return refuse;
      end if;
      fam := m[1] || '.' || m[3];
      sid := m[2];
      case fam
        when 'services.price' then v_kind := 'finances.prices'; set_hi := 10000000;
        when 'roles.headcount' then v_kind := 'people.headcount'; set_hi := 500; whole := true;
        when 'people.fte' then v_kind := 'people.hours'; set_hi := 1.5;
        when 'steps.work_hours' then v_kind := 'process.time'; mul_ok := true;
        when 'steps.wait_hours' then v_kind := 'process.wait'; mul_ok := true; set_hi := 10000;
        when 'steps.rework_rate' then v_kind := 'process.rework'; mul_ok := true; set_hi := 0.5;
        else return refuse;
      end case;
    end if;

    -- 4. The workspace didn't hide its kind (the frozen list: what the visitor saw).
    if hidden ? v_kind then
      return refuse;
    end if;
    -- 5. A person's hours only when the link shows people.
    if fam = 'people.fte' and not link.show_people then
      return refuse;
    end if;

    -- 6. The operation and the value.
    if o = 'multiply' then
      if not mul_ok or v < 0.1 or v > 2 then
        return out_of_range;
      end if;
    elsif o = 'set' then
      if set_hi is null or v < 0 or v > set_hi or (whole and v <> trunc(v)) then
        return out_of_range;
      end if;
    else
      return out_of_range;
    end if;

    -- 7. The id, in the snapshot first, then in the workspace (one message for both).
    if sid is not null then
      if fam = 'services.price' then
        in_snap := jsonb_path_exists(link.snapshot, '$.bundle.services[*] ? (@.id == $id)', jsonb_build_object('id', sid));
      elsif fam = 'roles.headcount' then
        in_snap := jsonb_path_exists(link.snapshot, '$.bundle.roles[*] ? (@.id == $id)', jsonb_build_object('id', sid));
      elsif fam = 'people.fte' then
        in_snap := jsonb_path_exists(link.snapshot, '$.bundle.people[*] ? (@.id == $id)', jsonb_build_object('id', sid));
      else
        in_snap := jsonb_path_exists(link.snapshot, '$.bundle.steps[*] ? (@.id == $id)', jsonb_build_object('id', sid))
          or jsonb_path_exists(link.snapshot, '$.bundle.otherProcesses[*].steps[*] ? (@.id == $id)', jsonb_build_object('id', sid));
      end if;
      if not in_snap or sid !~ uuid_re then
        return missing;
      end if;
      if fam = 'services.price' then
        in_ws := exists (select 1 from public.services t where t.id = sid::uuid and t.workspace_id = ws);
      elsif fam = 'roles.headcount' then
        in_ws := exists (select 1 from public.roles t where t.id = sid::uuid and t.workspace_id = ws);
      elsif fam = 'people.fte' then
        in_ws := exists (select 1 from public.people t where t.id = sid::uuid and t.workspace_id = ws);
      else
        in_ws := exists (select 1 from public.steps t where t.id = sid::uuid and t.workspace_id = ws);
      end if;
      if not in_ws then
        return missing;
      end if;
    end if;
  end loop;
  return null;
end;
$$;

revoke execute on function private.play_patch_problem(uuid, public.share_links, jsonb) from public;

-- ---------------------------------------------------------------------------
-- 6. Sending an idea
-- ---------------------------------------------------------------------------

-- The only write a play link can make. Expected outcomes are RETURNED ({"status": ...}); bad input RAISES 22023 with a plain message
-- the dialog shows. Cheap checks first: a link at its limit answers before the patch and leak checks run. Nothing here is ever applied:
-- the row is a pending suggestion, and only a person's Build it or Dismiss acts on it.
create function public.submit_play_proposal(token text, title text, note text, name text, email text, issue uuid, levers jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  l public.share_links;
  e text;
  v_email text;
  v_title text;
  v_name text;
  v_note text;
  v_levers jsonb;
  v_problem text;
  v_held jsonb := '{}'::jsonb;
  v_shown_title text;
  v_shown_note text;
  v_shown_name text;
  r record;
  n_10m integer;
  n_day integer;
  n_email integer;
  n_pending integer;
begin
  -- 1. No API tokens (the MCP server): ideas are sent from the shared page.
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Ideas are sent from the shared page.' using errcode = '42501';
  end if;

  -- 2. The link: a live play link, by the hash of its token. `for update` serialises submissions to one link, so the counts below hold.
  if token is null or token !~ '^[A-Za-z0-9_-]{43}$' then
    return jsonb_build_object('status', 'gone');
  end if;
  select * into l from public.share_links s
    where s.token_hash = encode(pg_catalog.sha256(pg_catalog.convert_to(token, 'UTF8')), 'hex')
      and s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and s.mode = 'play'
    for update;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;

  -- 3. Who is sending. A restricted link: open_share_link's check, copied (a confirmed address AND a Google identity whose own email is
  -- that address); the address recorded is the verified one, whatever was typed. An open link: the typed address.
  if l.show_people or l.show_financials then
    if auth.uid() is null then
      return jsonb_build_object('status', 'sign_in');
    end if;
    select lower(u.email) into e from auth.users u
      where u.id = auth.uid() and u.email_confirmed_at is not null
        and exists (select 1 from auth.identities i
                     where i.user_id = u.id and i.provider = 'google'
                       and lower(i.identity_data ->> 'email') = lower(u.email));
    if e is null or not (e = any (l.allowed_emails)) then
      return jsonb_build_object('status', 'not_allowed');
    end if;
    v_email := e;
  else
    v_email := lower(pg_catalog.btrim(coalesce(email, '')));
    if v_email = '' then
      raise exception 'Add your email address so the team can reply.' using errcode = '22023';
    end if;
    if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'That isn''t an email address.' using errcode = '22023';
    end if;
  end if;

  -- 4. Format only: nothing here depends on the workspace's data.
  v_title := pg_catalog.btrim(coalesce(title, ''));
  v_name := pg_catalog.btrim(coalesce(name, ''));
  v_note := nullif(pg_catalog.btrim(coalesce(note, '')), '');
  if v_title = '' then
    raise exception 'Give your idea a name.' using errcode = '22023';
  end if;
  if char_length(v_title) > 120 then
    raise exception 'Keep the name under 120 characters.' using errcode = '22023';
  end if;
  if v_name = '' then
    raise exception 'Add your name.' using errcode = '22023';
  end if;
  if char_length(v_name) > 100 then
    raise exception 'Keep your name under 100 characters.' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'Keep the note under 1,000 characters.' using errcode = '22023';
  end if;
  if v_title ~ '[\x01-\x1f\x7f]' or v_name ~ '[\x01-\x1f\x7f]' or v_note ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    raise exception 'Remove the unusual characters and try again.' using errcode = '22023';
  end if;

  -- 5. Rate limits, over the ideas stored from this link (the partial index). Refused calls store nothing and aren't counted.
  select count(*) filter (where x.created_at > now() - interval '10 minutes'),
         count(*),
         count(*) filter (where lower(x.proposer_email) = v_email)
    into n_10m, n_day, n_email
    from public.suggestion_proposals x
    where x.share_link_id = l.id and x.created_at > now() - interval '24 hours';
  if n_10m >= 5 or n_day >= 50 or n_email >= 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  select count(*) into n_pending from public.suggestion_proposals x
    where x.workspace_id = l.workspace_id and x.created_via = 'play_link' and x.status = 'pending';
  if n_pending >= 200 then
    return jsonb_build_object('status', 'busy');
  end if;

  -- 6. The changes: every id in the snapshot first, then the workspace.
  v_problem := private.play_patch_problem(l.workspace_id, l, levers);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  -- Rebuilt from the checked elements: only path, op and value, in order.
  select jsonb_agg(jsonb_build_object('path', a.e ->> 'path', 'op', a.e ->> 'op', 'value', a.e -> 'value') order by a.ord)
    into v_levers from jsonb_array_elements(levers) with ordinality as a (e, ord);

  -- 7. The issue it fixes, if any: on this page (snapshot first), then an open issue of this workspace. One message.
  if issue is not null then
    if not (
         jsonb_path_exists(l.snapshot, '$.issues[*] ? (@.id == $id && (@.process_id == $pid || @.links[*].process_id == $pid))',
                           jsonb_build_object('id', issue::text, 'pid', l.target_id::text))
         and exists (select 1 from public.issues i
                      where i.id = issue and i.workspace_id = l.workspace_id
                        and i.status in ('open', 'in_progress') and i.source <> 'detected')) then
      raise exception 'Pick an issue from this page, or none.' using errcode = '22023';
    end if;
  end if;

  -- 8. What the visitor typed is read by members and viewers, so it meets THEIR rules (a People-off, Financials-off link), whatever
  -- the link's toggles. A field that fails is HELD, never refused: a refusal would tell an outsider which words are the team's or a
  -- client's names. Members and viewers read a stand-in; owners and editors read the original.
  for r in select f.k, f.v from (values ('title', v_title), ('note', v_note), ('name', v_name)) as f (k, v) where f.v is not null loop
    if private.share_snapshot_problem(l.workspace_id, 'process',
         jsonb_build_object('v', 1, 'kind', 'process', 'toggles', '{"people":false,"financials":false}'::jsonb, 'text', r.v),
         false, false) is not null then
      v_held := v_held || jsonb_build_object(r.k, r.v);
    end if;
  end loop;
  v_shown_title := case when v_held ? 'title' then 'A visitor''s idea' else v_title end;
  v_shown_note := case when v_held ? 'note' then null else v_note end;
  v_shown_name := case when v_held ? 'name' then 'A visitor' else v_name end;

  -- 9. The one write. The trigger honours the setting for this statement only.
  perform set_config('transpera.play_submitting', 'on', true);
  insert into public.suggestion_proposals (workspace_id, kind, title, detail, payload, evidence, note, issue_id,
      proposer_name, proposer_email, share_link_id, visitor_text)
    values (l.workspace_id, 'solution_idea', v_shown_title, v_shown_note,
      jsonb_build_object('steps', '[]'::jsonb, 'edges', '[]'::jsonb, 'replaces_step_ids', '[]'::jsonb, 'levers', v_levers,
        'process_id', l.target_id, 'base_revision_id', l.snapshot -> 'bundle' -> 'revision' ->> 'id'),
      '[]'::jsonb, null, issue, v_shown_name, v_email, l.id, nullif(v_held, '{}'::jsonb));
  perform set_config('transpera.play_submitting', '', true);

  -- 10. Never the proposal's id, never whether anything was held, nothing from the workspace.
  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function public.submit_play_proposal(text, text, text, text, text, uuid, jsonb) from public;
grant execute on function public.submit_play_proposal(text, text, text, text, text, uuid, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. The visitor's email and held text, for those who may read them
-- ---------------------------------------------------------------------------

-- {"<proposal id>": {"email": "...", "held": {"title"?, "note"?, "name"?}}} for the workspace's visitor ideas, newest 500. Owners,
-- editors and agency admins only (members and viewers never see a visitor's email or held text).
create function public.play_proposal_contacts(ws uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt(), '{}') ? 'api_token_id' then
    raise exception 'Visitors'' emails are shown in the app only.' using errcode = '42501';
  end if;
  if ws is null or not coalesce(public.can_edit_workspace(ws), false) then
    raise exception 'play_proposal_contacts: you cannot read visitors'' details in this workspace' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_object_agg(x.id::text,
             jsonb_build_object('email', x.proposer_email)
             || case when x.visitor_text is not null then jsonb_build_object('held', x.visitor_text) else '{}'::jsonb end)
    from (select p.id, p.proposer_email, p.visitor_text from public.suggestion_proposals p
          where p.workspace_id = ws and p.created_via = 'play_link'
          order by p.created_at desc, p.id limit 500) x), '{}'::jsonb);
end;
$$;

revoke all on function public.play_proposal_contacts(uuid) from public, anon;
grant execute on function public.play_proposal_contacts(uuid) to authenticated;

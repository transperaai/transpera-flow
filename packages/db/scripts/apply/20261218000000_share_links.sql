-- Production apply file for 20261218000000_share_links (B3, issue #32). One table (`share_links`), one trigger, two private
-- functions (the leak check and the email rule) plus the trigger function, and two public functions (`share_team_capacity`,
-- `open_share_link`). Strictly additive: nothing existing is changed. Applies after row 62 (20261216000000, C1); this is row 63. Preflight, post-apply checks and rollback are in the migration's own
-- header, repeated below. Apply BEFORE deploying the app (the app calls `open_share_link` and inserts into `share_links`).
-- Sets `lock_timeout` to 5 s.

begin;
set local lock_timeout = '5s';

-- View-only share links with redacted snapshots (issue #32, B3; docs/plans/b3-brief.md, docs/adr/0016-share-links.md).
--
-- Owners and editors make a token link to a frozen, redacted copy ("snapshot") of the Overview, a process, an issue or a
-- solution. The Next.js server builds the snapshot from the existing loaders (through the same redacted team-input shape
-- members get); this migration is where Postgres REFUSES to store a snapshot that still holds a name, an email, a person's
-- pay or (with Financials off) a financial field, and where a visitor, signed in or not, reads a snapshot only through one
-- SECURITY DEFINER function keyed by an unguessable token.
--
-- Austin, 6 Oct (#30): members and viewers get no pay data. So no share link ever carries an individual cost rate: the
-- Financials toggle shows role rates, margins and overhead, never one person's pay.
--
-- What this adds (strictly additive; nothing existing is changed: not `save_fields`, not `team_capacity`, no policy or grant):
--   * `private.share_emails_ok(text[])`: the allowed-email list rule (<= 50, lower-case, valid, no duplicates).
--   * Table `public.share_links` (token hash, target, toggles, allowed emails, expiry, frozen snapshot, revoked, opens).
--     RLS: owners, editors and agency admins only. Column-level grants: the token hash and the snapshot are never readable
--     through the API; `mode` is not insertable ('view' only until B4).
--   * `private.share_snapshot_problem(...)`: the leak check, run by a BEFORE trigger on every insert and every snapshot change.
--   * `private.share_norm(text)`, `share_unpct(text)`, `share_strings(jsonb)`, `share_name_tokens(uuid, text)`: the text those checks match
--     on (percent-decoded, NFKC, invisible characters and marks out, lower case, one space for any white space), the string values with
--     their keys, and the tokens of the names in a workspace.
--   * `private.share_links_before_write()` + trigger `share_links_before_write`: refuses API tokens, stamps the caller, checks
--     the target belongs to the workspace, freezes the guarded columns, keeps revoked links revoked, runs the leak check.
--   * `public.share_team_capacity(ws, show_people)`: `team_capacity`'s shape for a share link (labels or names, NO pay for anyone).
--   * `public.open_share_link(token)`: the only way a visitor reads anything (anon and authenticated).
-- No `audit` trigger: it would copy the multi-megabyte snapshot into `audit_log`; `created_by` and `revoked_by` record who.
--
-- ORDER: after 20261216000000 (C1, row 62: B5 is row 60, B21 row 61) and every earlier row. It depends only on `can_edit_workspace` and the base tables.
--
-- PREFLIGHT (read-only; `prod-sql.sh -c`, one query at a time):
--   0. Latest applied versions; expect the latest to be 20261216000000 and nothing >= '20261218000000':
--        select version from supabase_migrations.schema_migrations where version >= '20261212000000' order by 1;
--   1. Nothing created yet. Expect null x9:
--        select to_regclass('public.share_links'), to_regprocedure('public.open_share_link(text)'),
--               to_regprocedure('public.share_team_capacity(uuid, boolean)'),
--               to_regprocedure('private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)'),
--               to_regprocedure('private.share_emails_ok(text[])'), to_regprocedure('private.share_norm(text)'),
--               to_regprocedure('private.share_unpct(text)'), to_regprocedure('private.share_strings(jsonb)'),
--               to_regprocedure('private.share_name_tokens(uuid, text)');
--   2. Helpers exist. Expect 3 rows: can_edit_workspace, team_capacity, can_read_workspace in public:
--        select p.proname, n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and p.proname in ('can_edit_workspace', 'team_capacity', 'can_read_workspace');
--   3. pg_catalog.sha256 and jsonpath work. Expect t, t:
--        select encode(pg_catalog.sha256('x'::bytea), 'hex') ~ '^[0-9a-f]{64}$',
--               jsonb_path_exists('{"a":{"cost_rate":1}}', 'lax $.**.cost_rate ? (@ != null)');
--   4. auth.users.email_confirmed_at exists. Expect 1:
--        select count(*) from information_schema.columns
--        where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at';
--   5. For the log: people and clients whose names the check will look for (>= 3 characters), per workspace:
--        select w.slug,
--               (select count(*) from public.people p where p.workspace_id = w.id and char_length(btrim(p.name)) >= 3),
--               (select count(*) from public.clients c where c.workspace_id = w.id and char_length(btrim(c.name)) >= 3)
--        from public.workspaces w order by 1;
--
-- POST-APPLY CHECK:
--   1. RLS on and three policies. Expect t, 3:
--        select relrowsecurity, (select count(*) from pg_policies where schemaname = 'public' and tablename = 'share_links')
--        from pg_class where oid = 'public.share_links'::regclass;
--   2. anon holds nothing on the table; authenticated has column-level SELECT/INSERT/UPDATE only (list them):
--        select grantee, privilege_type from information_schema.role_table_grants
--        where table_schema = 'public' and table_name = 'share_links' and grantee in ('anon', 'authenticated');
--        Expect no row for anon, and none for authenticated (its grants are on columns only). Then:
--        select grantee, privilege_type, column_name from information_schema.column_privileges
--        where table_schema = 'public' and table_name = 'share_links' and grantee in ('anon', 'authenticated')
--        order by 1, 2, 3;
--        Expect rows for authenticated only: SELECT on 18 columns (not token_hash, not snapshot), INSERT on 11 (not mode),
--        UPDATE on 4 (label, snapshot, engine_version, revoked_at); none for anon.
--   3. Function privileges. Expect t, t, f, t, f, f:
--        has_function_privilege('anon', 'public.open_share_link(text)', 'execute'), ('authenticated', same),
--        ('anon', 'public.share_team_capacity(uuid, boolean)', 'execute'), ('authenticated', same),
--        ('authenticated', 'private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)', 'execute'), ('anon', same).
--      And the four helpers (share_norm(text), share_unpct(text), share_strings(jsonb), share_name_tokens(uuid, text)), each for
--      anon and for authenticated. Expect f x8:
--        select has_function_privilege(r, f, 'execute') from unnest(array['anon', 'authenticated']) r,
--          unnest(array['private.share_norm(text)', 'private.share_unpct(text)', 'private.share_strings(jsonb)',
--                       'private.share_name_tokens(uuid, text)']) f;
--   4. prosecdef and proconfig: open_share_link t, share_team_capacity t, share_links_before_write t, share_snapshot_problem f,
--      and share_norm, share_unpct, share_strings, share_name_tokens f; all {search_path=""} (compare with array['search_path=""']):
--        select proname, prosecdef, proconfig = array['search_path=""'] from pg_proc
--        where pronamespace in ('public'::regnamespace, 'private'::regnamespace) and proname like any (array['share\_%', 'open\_share\_link']);
--   5. Smoke test, ROLLED BACK, as an agency admin on Northbeam (production Northbeam has no owner):
--        begin; set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated","app_metadata":{"agency_admin":true}}', true);
--        insert a link with the token hash of a known 43-character token and a minimal clean snapshot
--        ({"v":1,"kind":"overview","toggles":{"people":false,"financials":false}}, engine_version '1.8.0') -> succeeds;
--        the same with "x":"<a real person's full name>" -> 23514 "The snapshot names a person.";
--        set local role anon; select public.open_share_link('<token>') ->> 'status'; -> ok;  rollback;
--
-- ROLLBACK (run as one transaction; nothing existing was changed). Rolling it back deletes every share link:
--   begin;
--   drop function if exists public.open_share_link(text);
--   drop function if exists public.share_team_capacity(uuid, boolean);
--   drop table if exists public.share_links;
--   drop function if exists private.share_links_before_write();
--   drop function if exists private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean);
--   drop function if exists private.share_name_tokens(uuid, text);
--   drop function if exists private.share_strings(jsonb);
--   drop function if exists private.share_norm(text);
--   drop function if exists private.share_unpct(text);
--   drop function if exists private.share_emails_ok(text[]);
--   delete from supabase_migrations.schema_migrations where version = '20261218000000';
--   commit;
--
-- Production data: none needed.

-- ---------------------------------------------------------------------------
-- 1. The allowed-email list rule (same format rule as `workspace_access_emails`)
-- ---------------------------------------------------------------------------

create function private.share_emails_ok(emails text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select emails is not null
    and coalesce(cardinality(emails), 0) <= 50
    and not exists (
      select 1 from unnest(emails) as e
      where e is null or e <> lower(btrim(e)) or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    and (select count(distinct e) from unnest(emails) as e) = coalesce(cardinality(emails), 0);
$$;

-- ---------------------------------------------------------------------------
-- 2. The table
-- ---------------------------------------------------------------------------

create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Lowercase hex SHA-256 of the token; the token itself is never stored (shown once, like an API token).
  token_hash text not null constraint share_links_token_hash check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null constraint share_links_kind check (kind in ('overview', 'process', 'issue', 'solution')),
  -- The process, issue or solution shared; null for the Overview. Not a foreign key (it points at one of three tables).
  target_id uuid,
  mode text not null default 'view' constraint share_links_mode check (mode in ('view', 'play')),
  show_people boolean not null default false,
  show_financials boolean not null default false,
  allowed_emails text[] not null default '{}',
  expires_at timestamptz,
  label text constraint share_links_label check (label is null or char_length(btrim(label)) between 1 and 120),
  snapshot jsonb not null,
  snapshot_at timestamptz not null default now(),
  engine_version text not null constraint share_links_engine_version check (char_length(engine_version) between 1 and 32),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  opens integer not null default 0,
  last_opened_at timestamptz,
  constraint share_links_target check ((kind = 'overview') = (target_id is null)),
  -- PRD §9 / D12: any toggle on needs allowed emails and an expiry.
  constraint share_links_restricted check (
    (not show_people and not show_financials) or (cardinality(allowed_emails) > 0 and expires_at is not null)),
  constraint share_links_emails check (private.share_emails_ok(allowed_emails)),
  constraint share_links_snapshot_size check (octet_length(snapshot::text) <= 5242880)
);
create unique index share_links_token_hash_key on public.share_links (token_hash);
create index share_links_workspace_idx on public.share_links (workspace_id, created_at desc);

-- Owners, editors and agency admins only; members, viewers and anon nothing.
alter table public.share_links enable row level security;
create policy "read share links" on public.share_links for select to authenticated
  using (public.can_edit_workspace(workspace_id));
create policy "create share links" on public.share_links for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update share links" on public.share_links for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
-- No delete policy: links are revoked, never deleted (they go with their workspace).

-- Supabase re-grants new tables to anon by default.
revoke all on public.share_links from anon, authenticated;
-- Not token_hash, not snapshot.
grant select (id, workspace_id, kind, target_id, mode, show_people, show_financials, allowed_emails, expires_at, label,
  snapshot_at, engine_version, created_by, created_at, revoked_at, revoked_by, opens, last_opened_at)
  on public.share_links to authenticated;
-- Not mode: 'view' only until B4.
grant insert (workspace_id, token_hash, kind, target_id, show_people, show_financials, allowed_emails, expires_at, label,
  snapshot, engine_version) on public.share_links to authenticated;
grant update (label, snapshot, engine_version, revoked_at) on public.share_links to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The leak check
-- ---------------------------------------------------------------------------

-- The text a share link's checks match on, in one form (the app's `normaliseView`, packages/db/src/share-text.ts, is its twin):
-- best-effort percent-decoding, Unicode NFKC, every default-ignorable character (zero-width space and joiners, soft hyphen,
-- combining grapheme joiner, variation selectors, Hangul fillers) and every combining mark removed, curly quotes and apostrophes
-- and the hyphen variants straightened, lower case, and every run of white space (or a JSON escape of one written out as text:
-- \n, \t,  ) one space. The list of marks and ignorables is spelled out (Postgres has no Unicode property classes).

-- `%20`, `%C3%A9`: a run of %XX that is valid UTF-8 becomes its characters; anything else stays as written.
create function private.share_unpct(t text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  rest text := coalesce(t, '');
  res text := '';
  run text;
  p integer;
begin
  loop
    run := substring(rest from '((?:%[0-9A-Fa-f]{2})+)');
    exit when run is null;
    p := strpos(rest, run);
    res := res || left(rest, p - 1);
    begin
      res := res || convert_from(decode(replace(run, '%', ''), 'hex'), 'UTF8');
    exception when others then
      res := res || run;
    end;
    rest := substr(rest, p + char_length(run));
  end loop;
  return res || rest;
end;
$$;

create function private.share_norm(t text) returns text
language sql immutable
set search_path = ''
as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.translate(
      pg_catalog.regexp_replace(
        normalize(private.share_unpct(t), nfkc),
        U&'[\00AD\034F\061C\115F\1160\17B4\17B5\180B-\180F\200B-\200F\202A-\202E\2060-\206F\3164\FE00-\FE0F\FEFF\FFA0\FFF0-\FFF8\+0E0000-\+0E0FFF\+01BCA0-\+01BCA3\+01D173-\+01D17A\0300-\036F\0483-\0489\0591-\05BD\05BF\05C1\05C2\05C4\05C5\05C7\0610-\061A\064B-\065F\0670\06D6-\06DC\06DF-\06E4\06E7\06E8\06EA-\06ED\0711\0730-\074A\0900-\0903\093A-\093C\093E-\094F\0951-\0957\0962\0963\0E31\0E34-\0E3A\0E47-\0E4E\1AB0-\1AFF\1DC0-\1DFF\20D0-\20FF\302A-\302F\3099\309A\FE20-\FE2F]',
        '', 'g'),
      U&'\2019\2018\02BC\2032\0060\00B4\201C\201D\2010\2011\2012\2013\2014\2212',
      pg_catalog.repeat('''', 6) || '""' || '------')),
    '([[:space:]]|\\[nrtbf]|\\u[0-9a-fA-F]{4})+', ' ', 'g'));
$$;

revoke execute on function private.share_unpct(text) from public;
revoke execute on function private.share_norm(text) from public;

-- The strings of a snapshot with the key each sits under (an array of strings takes its parent's key). JSON keys are never text.
create function private.share_strings(snap jsonb) returns table (k text, v text)
language sql immutable
set search_path = ''
as $$
  with recursive w (k, v) as (
    select null::text, snap
    union all
    select coalesce(e.key, w.k), e.value
    from w
    cross join lateral (
      select o.key, o.value from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) as o
      union all
      select null::text, a.value from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) as a
    ) as e
  )
  select w.k, w.v #>> '{}' from w where pg_catalog.jsonb_typeof(w.v) = 'string';
$$;

-- The tokens of the names of a workspace's people or clients that a share link must not carry: every letter run of a name that
-- is 3+ characters, and every run of them joined ("priyashah": what is left when a zero-width space sat between the words);
-- never a word of the labels the link writes, never a stop word. Parts under 3 characters ("o" in "O'Neil") are not tokens.
create function private.share_name_tokens(ws uuid, kind text) returns setof text
language plpgsql stable
set search_path = ''
as $$
declare
  nm record;
  parts text[];
  a integer;
  b integer;
  tok text;
begin
  -- A loop, not one big query: as a query the planner priced it high enough to start JIT compilation (0.3 s a call).
  for nm in select private.share_norm(n.name) as name
            from (select c.name from public.clients c where c.workspace_id = ws and kind = 'client'
                  union all
                  select p.name from public.people p where p.workspace_id = ws and kind = 'person') as n loop
    parts := array(select x from unnest(regexp_split_to_array(nm.name, '[^[:alpha:]]+')) as x
                   where x <> '' and x not in ('the', 'and', 'for', 'ltd', 'inc', 'llc', 'plc'));
    -- A name of one short word ("Li") is no name.
    continue when char_length(array_to_string(parts, '')) < 3;
    for a in 1 .. cardinality(parts) loop
      for b in a .. cardinality(parts) loop
        tok := array_to_string(parts[a:b], '');
        if char_length(tok) >= 3 and tok not in ('team', 'member', 'client', 'hidden', 'email', 'amount') then
          return next tok;
        end if;
      end loop;
    end loop;
  end loop;
  return;
end;
$$;

revoke execute on function private.share_strings(jsonb) from public;
revoke execute on function private.share_name_tokens(uuid, text) from public;

-- Returns null when the snapshot is clean, else a plain message naming WHAT leaked, never the leaked value (no name, no
-- email in the message). Names are looked for token by token in the free-text values only (the keys below, the same list as the
-- app's `SHARE_FREE_TEXT_KEYS`); emails and money in every string value; JSON keys never.
create function private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  -- The keys whose string values are free text (keep equal to SHARE_FREE_TEXT_KEYS in packages/db/src/share.ts).
  free_keys constant text[] := array['actor', 'agreed_by', 'auto_note', 'body', 'breaks_if_removed', 'message', 'owner_text', 'source',
    'statement', 'test', 'horizon', 'description', 'detail', 'domain', 'evidence', 'example', 'excerpt', 'expect', 'job_done',
    'job_progress', 'job_situation', 'job_who', 'label', 'movedOn', 'name', 'note', 'notes', 'proposer_name', 'reason', 'review_note',
    'resolution_note', 'root_cause', 'speaker', 'speakers', 'summary', 'target_goal', 'target_measure', 'target_now', 'text', 'title',
    'tool', 'user_name', 'user_notes', 'why', 'why_problem', 'workspaceName'];
  everything text;
  free text;
begin
  -- 1. The snapshot is the link's.
  if snap is null or jsonb_typeof(snap) <> 'object'
     or snap -> 'v' is distinct from '1'::jsonb
     or snap -> 'kind' is distinct from to_jsonb(kind)
     or jsonb_typeof(snap -> 'toggles') is distinct from 'object'
     or snap -> 'toggles' -> 'people' is distinct from to_jsonb(show_people)
     or snap -> 'toggles' -> 'financials' is distinct from to_jsonb(show_financials) then
    return 'The snapshot doesn''t match the link.';
  end if;
  -- Every string value, normalised (the \x01 between them is no space and no letter, so nothing matches across two values),
  -- and the free-text ones on their own.
  select string_agg(private.share_norm(s.v), E'\x01'),
         string_agg(private.share_norm(s.v), E'\x01') filter (where s.k = any (free_keys))
    into everything, free
    from private.share_strings(snap) as s;
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

  -- 5. Clients are always anonymised: no token of a client's name (3+ characters, any case, any separators) in free text.
  if exists (select 1 from regexp_split_to_table(free, '[^[:alpha:]]+') as w (tok)
              where w.tok in (select private.share_name_tokens(ws, 'client'))) then
    return 'The snapshot names a client.';
  end if;

  -- 6. People are labels unless People is on: the same for a person's name (first name, surname, any part), so a name
  -- token can't survive next to a "Team member N" label either.
  if not show_people and exists (select 1 from regexp_split_to_table(free, '[^[:alpha:]]+') as w (tok)
                                  where w.tok in (select private.share_name_tokens(ws, 'person'))) then
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
      || '|(gbp|usd|eur|aud|nzd|cad|rs\.?)[[:space:]]*[0-9][0-9.,]*([[:space:]]*(k|m|bn))?([^a-z0-9]|$)'
      || '|[0-9]([[:space:]]*(k|m|bn))?[[:space:]]*(gbp|usd|eur|aud|nzd|cad|pounds?|dollars?|euros?|quid|sterling)([^a-z]|$)')) then
    return 'The snapshot contains costs or margins.';
  end if;

  return null;
end;
$$;

revoke execute on function private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean) from public;

-- ---------------------------------------------------------------------------
-- 4. The write trigger
-- ---------------------------------------------------------------------------

create function private.share_links_before_write() returns trigger
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
    if new.mode <> 'view' then
      raise exception 'Play links come later.' using errcode = '22023';
    end if;
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

create trigger share_links_before_write before insert or update on public.share_links
  for each row execute function private.share_links_before_write();

-- ---------------------------------------------------------------------------
-- 5. Team inputs for a share link
-- ---------------------------------------------------------------------------

-- A copy of `public.team_capacity` (20261207500000) with exactly these changes: only those who may make links call it;
-- `everyone` is the People toggle; there is no "own person"; the cost rate is null for EVERYONE; provenance is empty.
create function public.share_team_capacity(ws uuid, show_people boolean) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  everyone boolean;
  result jsonb;
begin
  -- `can_edit_workspace` is null (not false) for someone with no membership, and `not null` is null: coalesce it.
  if ws is null or show_people is null or not coalesce(public.can_edit_workspace(ws), false) then
    raise exception 'share_team_capacity: you cannot make share links in this workspace' using errcode = '42501';
  end if;
  everyone := show_people;

  with p as (
    select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.active, pe.start_date, pe.end_date,
           row_number() over (order by pe.created_at, pe.id) as n
    from public.people pe where pe.workspace_id = ws
  ),
  shown as (
    select p.*, case when everyone then p.name else 'Team member ' || p.n end as shown_name
    from p
  )
  select jsonb_build_object(
    'sees_everyone', everyone,
    'own_person_id', null,
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'workspace_id', s.workspace_id, 'name', s.shown_name, 'fte', s.fte,
        'capacity_hours_week', s.capacity_hours_week, 'cost_rate', null, 'active', s.active,
        'start_date', s.start_date, 'end_date', s.end_date, 'provenance', '{}'::jsonb)
      order by case when everyone then s.name end, s.n) from shown s), '[]'::jsonb),
    'person_roles', coalesce((select jsonb_agg(jsonb_build_object('person_id', r.person_id, 'role_id', r.role_id,
        'workspace_id', r.workspace_id) order by r.person_id, r.role_id)
      from public.person_roles r where r.workspace_id = ws), '[]'::jsonb),
    'person_skills', coalesce((select jsonb_agg(jsonb_build_object('person_id', k.person_id, 'step_id', k.step_id,
        'workspace_id', k.workspace_id) order by k.person_id, k.step_id)
      from public.person_skills k where k.workspace_id = ws), '[]'::jsonb),
    'person_leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id,
        'workspace_id', l.workspace_id, 'start_date', l.start_date, 'end_date', l.end_date)
        order by l.person_id, l.start_date, l.id)
      from public.person_leave l where l.workspace_id = ws), '[]'::jsonb),
    'client_assignments', coalesce((select jsonb_agg(jsonb_build_object('client_id', a.client_id, 'role_id', a.role_id,
        'person_id', a.person_id, 'workspace_id', a.workspace_id) order by a.client_id, a.role_id)
      from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke execute on function public.share_team_capacity(uuid, boolean) from public, anon;
grant execute on function public.share_team_capacity(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Opening a link
-- ---------------------------------------------------------------------------

-- The only way a visitor reads anything. Unknown, malformed, expired and revoked links all look the same: null. A restricted
-- link (any toggle on) answers `sign_in` to a signed-out caller and `not_allowed` to a signed-in one whose CONFIRMED email
-- isn't listed; both carry nothing else. Never returns workspace_id, token_hash, allowed_emails, created_by or label.
-- Volatile: it counts opens (a count and the last time; nothing about who).
create function public.open_share_link(token text) returns jsonb
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
      and s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and s.mode = 'view';
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

revoke execute on function public.open_share_link(text) from public;
grant execute on function public.open_share_link(text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261218000000', 'share_links', array[$mig$-- View-only share links with redacted snapshots (issue #32, B3; docs/plans/b3-brief.md, docs/adr/0016-share-links.md).
--
-- Owners and editors make a token link to a frozen, redacted copy ("snapshot") of the Overview, a process, an issue or a
-- solution. The Next.js server builds the snapshot from the existing loaders (through the same redacted team-input shape
-- members get); this migration is where Postgres REFUSES to store a snapshot that still holds a name, an email, a person's
-- pay or (with Financials off) a financial field, and where a visitor, signed in or not, reads a snapshot only through one
-- SECURITY DEFINER function keyed by an unguessable token.
--
-- Austin, 6 Oct (#30): members and viewers get no pay data. So no share link ever carries an individual cost rate: the
-- Financials toggle shows role rates, margins and overhead, never one person's pay.
--
-- What this adds (strictly additive; nothing existing is changed: not `save_fields`, not `team_capacity`, no policy or grant):
--   * `private.share_emails_ok(text[])`: the allowed-email list rule (<= 50, lower-case, valid, no duplicates).
--   * Table `public.share_links` (token hash, target, toggles, allowed emails, expiry, frozen snapshot, revoked, opens).
--     RLS: owners, editors and agency admins only. Column-level grants: the token hash and the snapshot are never readable
--     through the API; `mode` is not insertable ('view' only until B4).
--   * `private.share_snapshot_problem(...)`: the leak check, run by a BEFORE trigger on every insert and every snapshot change.
--   * `private.share_norm(text)`, `share_unpct(text)`, `share_strings(jsonb)`, `share_name_tokens(uuid, text)`: the text those checks match
--     on (percent-decoded, NFKC, invisible characters and marks out, lower case, one space for any white space), the string values with
--     their keys, and the tokens of the names in a workspace.
--   * `private.share_links_before_write()` + trigger `share_links_before_write`: refuses API tokens, stamps the caller, checks
--     the target belongs to the workspace, freezes the guarded columns, keeps revoked links revoked, runs the leak check.
--   * `public.share_team_capacity(ws, show_people)`: `team_capacity`'s shape for a share link (labels or names, NO pay for anyone).
--   * `public.open_share_link(token)`: the only way a visitor reads anything (anon and authenticated).
-- No `audit` trigger: it would copy the multi-megabyte snapshot into `audit_log`; `created_by` and `revoked_by` record who.
--
-- ORDER: after 20261216000000 (C1, row 62: B5 is row 60, B21 row 61) and every earlier row. It depends only on `can_edit_workspace` and the base tables.
--
-- PREFLIGHT (read-only; `prod-sql.sh -c`, one query at a time):
--   0. Latest applied versions; expect the latest to be 20261216000000 and nothing >= '20261218000000':
--        select version from supabase_migrations.schema_migrations where version >= '20261212000000' order by 1;
--   1. Nothing created yet. Expect null x9:
--        select to_regclass('public.share_links'), to_regprocedure('public.open_share_link(text)'),
--               to_regprocedure('public.share_team_capacity(uuid, boolean)'),
--               to_regprocedure('private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)'),
--               to_regprocedure('private.share_emails_ok(text[])'), to_regprocedure('private.share_norm(text)'),
--               to_regprocedure('private.share_unpct(text)'), to_regprocedure('private.share_strings(jsonb)'),
--               to_regprocedure('private.share_name_tokens(uuid, text)');
--   2. Helpers exist. Expect 3 rows: can_edit_workspace, team_capacity, can_read_workspace in public:
--        select p.proname, n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and p.proname in ('can_edit_workspace', 'team_capacity', 'can_read_workspace');
--   3. pg_catalog.sha256 and jsonpath work. Expect t, t:
--        select encode(pg_catalog.sha256('x'::bytea), 'hex') ~ '^[0-9a-f]{64}$',
--               jsonb_path_exists('{"a":{"cost_rate":1}}', 'lax $.**.cost_rate ? (@ != null)');
--   4. auth.users.email_confirmed_at exists. Expect 1:
--        select count(*) from information_schema.columns
--        where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at';
--   5. For the log: people and clients whose names the check will look for (>= 3 characters), per workspace:
--        select w.slug,
--               (select count(*) from public.people p where p.workspace_id = w.id and char_length(btrim(p.name)) >= 3),
--               (select count(*) from public.clients c where c.workspace_id = w.id and char_length(btrim(c.name)) >= 3)
--        from public.workspaces w order by 1;
--
-- POST-APPLY CHECK:
--   1. RLS on and three policies. Expect t, 3:
--        select relrowsecurity, (select count(*) from pg_policies where schemaname = 'public' and tablename = 'share_links')
--        from pg_class where oid = 'public.share_links'::regclass;
--   2. anon holds nothing on the table; authenticated has column-level SELECT/INSERT/UPDATE only (list them):
--        select grantee, privilege_type from information_schema.role_table_grants
--        where table_schema = 'public' and table_name = 'share_links' and grantee in ('anon', 'authenticated');
--        Expect no row for anon, and none for authenticated (its grants are on columns only). Then:
--        select grantee, privilege_type, column_name from information_schema.column_privileges
--        where table_schema = 'public' and table_name = 'share_links' and grantee in ('anon', 'authenticated')
--        order by 1, 2, 3;
--        Expect rows for authenticated only: SELECT on 18 columns (not token_hash, not snapshot), INSERT on 11 (not mode),
--        UPDATE on 4 (label, snapshot, engine_version, revoked_at); none for anon.
--   3. Function privileges. Expect t, t, f, t, f, f:
--        has_function_privilege('anon', 'public.open_share_link(text)', 'execute'), ('authenticated', same),
--        ('anon', 'public.share_team_capacity(uuid, boolean)', 'execute'), ('authenticated', same),
--        ('authenticated', 'private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)', 'execute'), ('anon', same).
--      And the four helpers (share_norm(text), share_unpct(text), share_strings(jsonb), share_name_tokens(uuid, text)), each for
--      anon and for authenticated. Expect f x8:
--        select has_function_privilege(r, f, 'execute') from unnest(array['anon', 'authenticated']) r,
--          unnest(array['private.share_norm(text)', 'private.share_unpct(text)', 'private.share_strings(jsonb)',
--                       'private.share_name_tokens(uuid, text)']) f;
--   4. prosecdef and proconfig: open_share_link t, share_team_capacity t, share_links_before_write t, share_snapshot_problem f,
--      and share_norm, share_unpct, share_strings, share_name_tokens f; all {search_path=""} (compare with array['search_path=""']):
--        select proname, prosecdef, proconfig = array['search_path=""'] from pg_proc
--        where pronamespace in ('public'::regnamespace, 'private'::regnamespace) and proname like any (array['share\_%', 'open\_share\_link']);
--   5. Smoke test, ROLLED BACK, as an agency admin on Northbeam (production Northbeam has no owner):
--        begin; set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated","app_metadata":{"agency_admin":true}}', true);
--        insert a link with the token hash of a known 43-character token and a minimal clean snapshot
--        ({"v":1,"kind":"overview","toggles":{"people":false,"financials":false}}, engine_version '1.8.0') -> succeeds;
--        the same with "x":"<a real person's full name>" -> 23514 "The snapshot names a person.";
--        set local role anon; select public.open_share_link('<token>') ->> 'status'; -> ok;  rollback;
--
-- ROLLBACK (run as one transaction; nothing existing was changed). Rolling it back deletes every share link:
--   begin;
--   drop function if exists public.open_share_link(text);
--   drop function if exists public.share_team_capacity(uuid, boolean);
--   drop table if exists public.share_links;
--   drop function if exists private.share_links_before_write();
--   drop function if exists private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean);
--   drop function if exists private.share_name_tokens(uuid, text);
--   drop function if exists private.share_strings(jsonb);
--   drop function if exists private.share_norm(text);
--   drop function if exists private.share_unpct(text);
--   drop function if exists private.share_emails_ok(text[]);
--   delete from supabase_migrations.schema_migrations where version = '20261218000000';
--   commit;
--
-- Production data: none needed.

-- ---------------------------------------------------------------------------
-- 1. The allowed-email list rule (same format rule as `workspace_access_emails`)
-- ---------------------------------------------------------------------------

create function private.share_emails_ok(emails text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select emails is not null
    and coalesce(cardinality(emails), 0) <= 50
    and not exists (
      select 1 from unnest(emails) as e
      where e is null or e <> lower(btrim(e)) or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    and (select count(distinct e) from unnest(emails) as e) = coalesce(cardinality(emails), 0);
$$;

-- ---------------------------------------------------------------------------
-- 2. The table
-- ---------------------------------------------------------------------------

create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Lowercase hex SHA-256 of the token; the token itself is never stored (shown once, like an API token).
  token_hash text not null constraint share_links_token_hash check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null constraint share_links_kind check (kind in ('overview', 'process', 'issue', 'solution')),
  -- The process, issue or solution shared; null for the Overview. Not a foreign key (it points at one of three tables).
  target_id uuid,
  mode text not null default 'view' constraint share_links_mode check (mode in ('view', 'play')),
  show_people boolean not null default false,
  show_financials boolean not null default false,
  allowed_emails text[] not null default '{}',
  expires_at timestamptz,
  label text constraint share_links_label check (label is null or char_length(btrim(label)) between 1 and 120),
  snapshot jsonb not null,
  snapshot_at timestamptz not null default now(),
  engine_version text not null constraint share_links_engine_version check (char_length(engine_version) between 1 and 32),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  opens integer not null default 0,
  last_opened_at timestamptz,
  constraint share_links_target check ((kind = 'overview') = (target_id is null)),
  -- PRD §9 / D12: any toggle on needs allowed emails and an expiry.
  constraint share_links_restricted check (
    (not show_people and not show_financials) or (cardinality(allowed_emails) > 0 and expires_at is not null)),
  constraint share_links_emails check (private.share_emails_ok(allowed_emails)),
  constraint share_links_snapshot_size check (octet_length(snapshot::text) <= 5242880)
);
create unique index share_links_token_hash_key on public.share_links (token_hash);
create index share_links_workspace_idx on public.share_links (workspace_id, created_at desc);

-- Owners, editors and agency admins only; members, viewers and anon nothing.
alter table public.share_links enable row level security;
create policy "read share links" on public.share_links for select to authenticated
  using (public.can_edit_workspace(workspace_id));
create policy "create share links" on public.share_links for insert to authenticated
  with check (public.can_edit_workspace(workspace_id));
create policy "update share links" on public.share_links for update to authenticated
  using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
-- No delete policy: links are revoked, never deleted (they go with their workspace).

-- Supabase re-grants new tables to anon by default.
revoke all on public.share_links from anon, authenticated;
-- Not token_hash, not snapshot.
grant select (id, workspace_id, kind, target_id, mode, show_people, show_financials, allowed_emails, expires_at, label,
  snapshot_at, engine_version, created_by, created_at, revoked_at, revoked_by, opens, last_opened_at)
  on public.share_links to authenticated;
-- Not mode: 'view' only until B4.
grant insert (workspace_id, token_hash, kind, target_id, show_people, show_financials, allowed_emails, expires_at, label,
  snapshot, engine_version) on public.share_links to authenticated;
grant update (label, snapshot, engine_version, revoked_at) on public.share_links to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The leak check
-- ---------------------------------------------------------------------------

-- The text a share link's checks match on, in one form (the app's `normaliseView`, packages/db/src/share-text.ts, is its twin):
-- best-effort percent-decoding, Unicode NFKC, every default-ignorable character (zero-width space and joiners, soft hyphen,
-- combining grapheme joiner, variation selectors, Hangul fillers) and every combining mark removed, curly quotes and apostrophes
-- and the hyphen variants straightened, lower case, and every run of white space (or a JSON escape of one written out as text:
-- \n, \t,  ) one space. The list of marks and ignorables is spelled out (Postgres has no Unicode property classes).

-- `%20`, `%C3%A9`: a run of %XX that is valid UTF-8 becomes its characters; anything else stays as written.
create function private.share_unpct(t text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  rest text := coalesce(t, '');
  res text := '';
  run text;
  p integer;
begin
  loop
    run := substring(rest from '((?:%[0-9A-Fa-f]{2})+)');
    exit when run is null;
    p := strpos(rest, run);
    res := res || left(rest, p - 1);
    begin
      res := res || convert_from(decode(replace(run, '%', ''), 'hex'), 'UTF8');
    exception when others then
      res := res || run;
    end;
    rest := substr(rest, p + char_length(run));
  end loop;
  return res || rest;
end;
$$;

create function private.share_norm(t text) returns text
language sql immutable
set search_path = ''
as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.translate(
      pg_catalog.regexp_replace(
        normalize(private.share_unpct(t), nfkc),
        U&'[\00AD\034F\061C\115F\1160\17B4\17B5\180B-\180F\200B-\200F\202A-\202E\2060-\206F\3164\FE00-\FE0F\FEFF\FFA0\FFF0-\FFF8\+0E0000-\+0E0FFF\+01BCA0-\+01BCA3\+01D173-\+01D17A\0300-\036F\0483-\0489\0591-\05BD\05BF\05C1\05C2\05C4\05C5\05C7\0610-\061A\064B-\065F\0670\06D6-\06DC\06DF-\06E4\06E7\06E8\06EA-\06ED\0711\0730-\074A\0900-\0903\093A-\093C\093E-\094F\0951-\0957\0962\0963\0E31\0E34-\0E3A\0E47-\0E4E\1AB0-\1AFF\1DC0-\1DFF\20D0-\20FF\302A-\302F\3099\309A\FE20-\FE2F]',
        '', 'g'),
      U&'\2019\2018\02BC\2032\0060\00B4\201C\201D\2010\2011\2012\2013\2014\2212',
      pg_catalog.repeat('''', 6) || '""' || '------')),
    '([[:space:]]|\\[nrtbf]|\\u[0-9a-fA-F]{4})+', ' ', 'g'));
$$;

revoke execute on function private.share_unpct(text) from public;
revoke execute on function private.share_norm(text) from public;

-- The strings of a snapshot with the key each sits under (an array of strings takes its parent's key). JSON keys are never text.
create function private.share_strings(snap jsonb) returns table (k text, v text)
language sql immutable
set search_path = ''
as $$
  with recursive w (k, v) as (
    select null::text, snap
    union all
    select coalesce(e.key, w.k), e.value
    from w
    cross join lateral (
      select o.key, o.value from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) as o
      union all
      select null::text, a.value from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) as a
    ) as e
  )
  select w.k, w.v #>> '{}' from w where pg_catalog.jsonb_typeof(w.v) = 'string';
$$;

-- The tokens of the names of a workspace's people or clients that a share link must not carry: every letter run of a name that
-- is 3+ characters, and every run of them joined ("priyashah": what is left when a zero-width space sat between the words);
-- never a word of the labels the link writes, never a stop word. Parts under 3 characters ("o" in "O'Neil") are not tokens.
create function private.share_name_tokens(ws uuid, kind text) returns setof text
language plpgsql stable
set search_path = ''
as $$
declare
  nm record;
  parts text[];
  a integer;
  b integer;
  tok text;
begin
  -- A loop, not one big query: as a query the planner priced it high enough to start JIT compilation (0.3 s a call).
  for nm in select private.share_norm(n.name) as name
            from (select c.name from public.clients c where c.workspace_id = ws and kind = 'client'
                  union all
                  select p.name from public.people p where p.workspace_id = ws and kind = 'person') as n loop
    parts := array(select x from unnest(regexp_split_to_array(nm.name, '[^[:alpha:]]+')) as x
                   where x <> '' and x not in ('the', 'and', 'for', 'ltd', 'inc', 'llc', 'plc'));
    -- A name of one short word ("Li") is no name.
    continue when char_length(array_to_string(parts, '')) < 3;
    for a in 1 .. cardinality(parts) loop
      for b in a .. cardinality(parts) loop
        tok := array_to_string(parts[a:b], '');
        if char_length(tok) >= 3 and tok not in ('team', 'member', 'client', 'hidden', 'email', 'amount') then
          return next tok;
        end if;
      end loop;
    end loop;
  end loop;
  return;
end;
$$;

revoke execute on function private.share_strings(jsonb) from public;
revoke execute on function private.share_name_tokens(uuid, text) from public;

-- Returns null when the snapshot is clean, else a plain message naming WHAT leaked, never the leaked value (no name, no
-- email in the message). Names are looked for token by token in the free-text values only (the keys below, the same list as the
-- app's `SHARE_FREE_TEXT_KEYS`); emails and money in every string value; JSON keys never.
create function private.share_snapshot_problem(ws uuid, kind text, snap jsonb, show_people boolean, show_financials boolean)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  -- The keys whose string values are free text (keep equal to SHARE_FREE_TEXT_KEYS in packages/db/src/share.ts).
  free_keys constant text[] := array['actor', 'agreed_by', 'auto_note', 'body', 'breaks_if_removed', 'message', 'owner_text', 'source',
    'statement', 'test', 'horizon', 'description', 'detail', 'domain', 'evidence', 'example', 'excerpt', 'expect', 'job_done',
    'job_progress', 'job_situation', 'job_who', 'label', 'movedOn', 'name', 'note', 'notes', 'proposer_name', 'reason', 'review_note',
    'resolution_note', 'root_cause', 'speaker', 'speakers', 'summary', 'target_goal', 'target_measure', 'target_now', 'text', 'title',
    'tool', 'user_name', 'user_notes', 'why', 'why_problem', 'workspaceName'];
  everything text;
  free text;
begin
  -- 1. The snapshot is the link's.
  if snap is null or jsonb_typeof(snap) <> 'object'
     or snap -> 'v' is distinct from '1'::jsonb
     or snap -> 'kind' is distinct from to_jsonb(kind)
     or jsonb_typeof(snap -> 'toggles') is distinct from 'object'
     or snap -> 'toggles' -> 'people' is distinct from to_jsonb(show_people)
     or snap -> 'toggles' -> 'financials' is distinct from to_jsonb(show_financials) then
    return 'The snapshot doesn''t match the link.';
  end if;
  -- Every string value, normalised (the \x01 between them is no space and no letter, so nothing matches across two values),
  -- and the free-text ones on their own.
  select string_agg(private.share_norm(s.v), E'\x01'),
         string_agg(private.share_norm(s.v), E'\x01') filter (where s.k = any (free_keys))
    into everything, free
    from private.share_strings(snap) as s;
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

  -- 5. Clients are always anonymised: no token of a client's name (3+ characters, any case, any separators) in free text.
  if exists (select 1 from regexp_split_to_table(free, '[^[:alpha:]]+') as w (tok)
              where w.tok in (select private.share_name_tokens(ws, 'client'))) then
    return 'The snapshot names a client.';
  end if;

  -- 6. People are labels unless People is on: the same for a person's name (first name, surname, any part), so a name
  -- token can't survive next to a "Team member N" label either.
  if not show_people and exists (select 1 from regexp_split_to_table(free, '[^[:alpha:]]+') as w (tok)
                                  where w.tok in (select private.share_name_tokens(ws, 'person'))) then
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
      || '|(gbp|usd|eur|aud|nzd|cad|rs\.?)[[:space:]]*[0-9][0-9.,]*([[:space:]]*(k|m|bn))?([^a-z0-9]|$)'
      || '|[0-9]([[:space:]]*(k|m|bn))?[[:space:]]*(gbp|usd|eur|aud|nzd|cad|pounds?|dollars?|euros?|quid|sterling)([^a-z]|$)')) then
    return 'The snapshot contains costs or margins.';
  end if;

  return null;
end;
$$;

revoke execute on function private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean) from public;

-- ---------------------------------------------------------------------------
-- 4. The write trigger
-- ---------------------------------------------------------------------------

create function private.share_links_before_write() returns trigger
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
    if new.mode <> 'view' then
      raise exception 'Play links come later.' using errcode = '22023';
    end if;
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

create trigger share_links_before_write before insert or update on public.share_links
  for each row execute function private.share_links_before_write();

-- ---------------------------------------------------------------------------
-- 5. Team inputs for a share link
-- ---------------------------------------------------------------------------

-- A copy of `public.team_capacity` (20261207500000) with exactly these changes: only those who may make links call it;
-- `everyone` is the People toggle; there is no "own person"; the cost rate is null for EVERYONE; provenance is empty.
create function public.share_team_capacity(ws uuid, show_people boolean) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  everyone boolean;
  result jsonb;
begin
  -- `can_edit_workspace` is null (not false) for someone with no membership, and `not null` is null: coalesce it.
  if ws is null or show_people is null or not coalesce(public.can_edit_workspace(ws), false) then
    raise exception 'share_team_capacity: you cannot make share links in this workspace' using errcode = '42501';
  end if;
  everyone := show_people;

  with p as (
    select pe.id, pe.workspace_id, pe.name, pe.fte, pe.capacity_hours_week, pe.active, pe.start_date, pe.end_date,
           row_number() over (order by pe.created_at, pe.id) as n
    from public.people pe where pe.workspace_id = ws
  ),
  shown as (
    select p.*, case when everyone then p.name else 'Team member ' || p.n end as shown_name
    from p
  )
  select jsonb_build_object(
    'sees_everyone', everyone,
    'own_person_id', null,
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'workspace_id', s.workspace_id, 'name', s.shown_name, 'fte', s.fte,
        'capacity_hours_week', s.capacity_hours_week, 'cost_rate', null, 'active', s.active,
        'start_date', s.start_date, 'end_date', s.end_date, 'provenance', '{}'::jsonb)
      order by case when everyone then s.name end, s.n) from shown s), '[]'::jsonb),
    'person_roles', coalesce((select jsonb_agg(jsonb_build_object('person_id', r.person_id, 'role_id', r.role_id,
        'workspace_id', r.workspace_id) order by r.person_id, r.role_id)
      from public.person_roles r where r.workspace_id = ws), '[]'::jsonb),
    'person_skills', coalesce((select jsonb_agg(jsonb_build_object('person_id', k.person_id, 'step_id', k.step_id,
        'workspace_id', k.workspace_id) order by k.person_id, k.step_id)
      from public.person_skills k where k.workspace_id = ws), '[]'::jsonb),
    'person_leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'person_id', l.person_id,
        'workspace_id', l.workspace_id, 'start_date', l.start_date, 'end_date', l.end_date)
        order by l.person_id, l.start_date, l.id)
      from public.person_leave l where l.workspace_id = ws), '[]'::jsonb),
    'client_assignments', coalesce((select jsonb_agg(jsonb_build_object('client_id', a.client_id, 'role_id', a.role_id,
        'person_id', a.person_id, 'workspace_id', a.workspace_id) order by a.client_id, a.role_id)
      from public.client_assignments a where a.workspace_id = ws), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke execute on function public.share_team_capacity(uuid, boolean) from public, anon;
grant execute on function public.share_team_capacity(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Opening a link
-- ---------------------------------------------------------------------------

-- The only way a visitor reads anything. Unknown, malformed, expired and revoked links all look the same: null. A restricted
-- link (any toggle on) answers `sign_in` to a signed-out caller and `not_allowed` to a signed-in one whose CONFIRMED email
-- isn't listed; both carry nothing else. Never returns workspace_id, token_hash, allowed_emails, created_by or label.
-- Volatile: it counts opens (a count and the last time; nothing about who).
create function public.open_share_link(token text) returns jsonb
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
      and s.revoked_at is null and (s.expires_at is null or s.expires_at > now()) and s.mode = 'view';
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

revoke execute on function public.open_share_link(text) from public;
grant execute on function public.open_share_link(text) to anon, authenticated;
$mig$]);

commit;

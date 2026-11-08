-- Per-field saves with a version check (docs/PRD.md D14, docs/adr/0001-per-field-saves.md).
--
-- The client sends, per field, the value it last saw (`base`) and the value it
-- wants (`changes`). Under a row lock each field is compared with what is
-- stored now:
--   stored = base            -> nobody else touched it: write it
--   stored = wanted value    -> already saved (e.g. a retry): nothing to do
--   otherwise                -> same-field conflict: not written, reported with
--                               the stored value so the user can pick
-- Fields the client did not send are never written, so edits to different
-- fields of the same row merge. "Keep mine" is a second call with base set to
-- the conflicting stored value.
--
-- Both functions are SECURITY INVOKER: they run as the signed-in user, so the
-- tables' grants and row-level security decide what may be written.

create function public.save_fields(target text, key jsonb, base jsonb, changes jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Tables whose rows are edited field by field. Keep in sync with `EditableTable` in the app.
  editable constant text[] := array['workspaces', 'roles', 'people', 'person_leave', 'processes', 'steps', 'edges'];
  fixed constant text[] := array['id', 'workspace_id', 'created_at', 'updated_at', 'created_by'];
  key_match text;
  stored jsonb;
  typed_base jsonb;
  typed_changes jsonb;
  patch jsonb := '{}';
  conflicts jsonb := '{}';
  field text;
  col text;
  sub text;
  seen jsonb;
  mine jsonb;
  theirs jsonb;
  set_cols text;
  from_cols text;
begin
  if target is null or not (target = any (editable)) then
    raise exception 'save_fields: table % is not editable', target using errcode = '42501';
  end if;
  if jsonb_typeof(key) is distinct from 'object' or key = '{}' then
    raise exception 'save_fields: key must be a non-empty object' using errcode = '22023';
  end if;
  if jsonb_typeof(changes) is distinct from 'object' or changes = '{}' then
    raise exception 'save_fields: changes must be a non-empty object' using errcode = '22023';
  end if;
  if jsonb_typeof(base) is distinct from 'object' then
    raise exception 'save_fields: base must be an object' using errcode = '22023';
  end if;

  select string_agg(format('t.%1$I = k.%1$I', kc.name), ' and ') into key_match from jsonb_object_keys(key) as kc(name);

  -- Lock the row. RLS applies: a row the user may not update is not found.
  execute format(
    'select to_jsonb(t) from public.%1$I t, jsonb_populate_record(null::public.%1$I, $1) k where %2$s for update of t',
    target, key_match)
  into stored using key;
  if stored is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Round-trip top-level values through the column types so "1.50" and 1.5, or
  -- two spellings of a date, compare equal.
  execute format('select to_jsonb(jsonb_populate_record(null::public.%I, $1))', target) into typed_base using base;
  execute format('select to_jsonb(jsonb_populate_record(null::public.%I, $1))', target) into typed_changes using changes;

  for field in select jsonb_object_keys(changes) loop
    -- A field is a column, or `column.key` for one key of a jsonb column (e.g. settings.availability_floor).
    col := split_part(field, '.', 1);
    sub := nullif(substr(field, length(col) + 2), '');
    if col = any (fixed) or key ? col or not stored ? col or position('.' in coalesce(sub, '')) > 0 then
      raise exception 'save_fields: % cannot be saved', field using errcode = '42501';
    end if;
    if not base ? field then
      raise exception 'save_fields: no base value for %', field using errcode = '22023';
    end if;

    if sub is null then
      seen := typed_base -> col;
      mine := typed_changes -> col;
      theirs := stored -> col;
    else
      if jsonb_typeof(stored -> col) not in ('object', 'null') then
        raise exception 'save_fields: % is not a json object', col using errcode = '42501';
      end if;
      seen := coalesce(base -> field, 'null');
      mine := coalesce(changes -> field, 'null');
      theirs := coalesce(stored -> col -> sub, 'null');
    end if;

    if theirs is distinct from seen and theirs is distinct from mine then
      conflicts := conflicts || jsonb_build_object(field, theirs);
    elsif theirs is distinct from mine then
      if sub is null then
        patch := patch || jsonb_build_object(col, mine);
      else
        patch := patch || jsonb_build_object(col,
          coalesce(patch -> col, nullif(stored -> col, 'null'), '{}') || jsonb_build_object(sub, mine));
      end if;
    end if;
  end loop;

  if patch <> '{}' then
    select string_agg(quote_ident(pc.name), ', '), string_agg('p.' || quote_ident(pc.name), ', ')
      into set_cols, from_cols from jsonb_object_keys(patch) as pc(name);
    execute format(
      'update public.%1$I t set (%3$s) = (select %4$s from jsonb_populate_record(null::public.%1$I, $2) p)
       from jsonb_populate_record(null::public.%1$I, $1) k where %2$s returning to_jsonb(t)',
      target, key_match, set_cols, from_cols)
    into stored using key, patch;
  end if;

  return jsonb_build_object(
    'status', case when conflicts = '{}' then 'saved' else 'conflict' end,
    'row', stored,
    'conflicts', conflicts);
end;
$$;

-- The same check for a set held in a link table, e.g. a person's roles
-- (person_roles.role_id) or skills (person_skills.step_id). `owner` holds the
-- columns shared by every row of the set, including workspace_id; `base` and
-- `next` are JSON arrays of member values. The set is compared as a whole.
create function public.save_links(target text, owner jsonb, member text, base jsonb, next jsonb) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Link tables and their member column. Keep in sync with `LinkTable` in the app.
  links constant jsonb := '{"person_roles": "role_id", "person_skills": "step_id"}';
  owner_match text;
  owner_cols text;
  sorted_base jsonb;
  sorted_next jsonb;
  stored jsonb;
begin
  if target is null or links ->> target is distinct from member then
    raise exception 'save_links: %.% is not an editable set', target, member using errcode = '42501';
  end if;
  if jsonb_typeof(owner) is distinct from 'object' or not owner ? 'workspace_id' or owner ? member then
    raise exception 'save_links: owner must be an object with workspace_id' using errcode = '22023';
  end if;
  if jsonb_typeof(base) is distinct from 'array' or jsonb_typeof(next) is distinct from 'array' then
    raise exception 'save_links: base and next must be arrays' using errcode = '22023';
  end if;
  -- Deletes of rows RLS hides would silently do nothing, so check up front.
  -- coalesce: the helper returns null, not false, for users with no membership.
  if not coalesce(public.can_edit_workspace((owner ->> 'workspace_id')::uuid), false) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select string_agg(format('t.%1$I = k.%1$I', oc.name), ' and '), string_agg(quote_ident(oc.name), ', ')
    into owner_match, owner_cols from jsonb_object_keys(owner) as oc(name);

  -- Serialise edits of the same set (there is no single row to lock).
  perform pg_advisory_xact_lock(hashtextextended(target || owner::text, 0));

  select coalesce(jsonb_agg(distinct e.v order by e.v), '[]') into sorted_base from jsonb_array_elements(base) as e(v);
  select coalesce(jsonb_agg(distinct e.v order by e.v), '[]') into sorted_next from jsonb_array_elements(next) as e(v);
  execute format(
    'select coalesce(jsonb_agg(distinct to_jsonb(t.%3$I) order by to_jsonb(t.%3$I)), ''[]'')
     from public.%1$I t, jsonb_populate_record(null::public.%1$I, $1) k where %2$s',
    target, owner_match, member)
  into stored using owner;

  if stored <> sorted_base and stored <> sorted_next then
    return jsonb_build_object('status', 'conflict', 'members', stored);
  end if;

  if stored <> sorted_next then
    execute format(
      'delete from public.%1$I t using jsonb_populate_record(null::public.%1$I, $1) k
       where %2$s and not ($2 @> to_jsonb(t.%3$I))',
      target, owner_match, member)
    using owner, sorted_next;
    execute format(
      'insert into public.%1$I (%2$s, %3$I)
       select %4$s, r.%3$I from jsonb_array_elements($2) as m(v),
         jsonb_populate_record(null::public.%1$I, $1 || jsonb_build_object(%3$L, m.v)) r
       where not ($3 @> m.v)',
      target, owner_cols, member,
      (select string_agg('r.' || quote_ident(oc.name), ', ') from jsonb_object_keys(owner) as oc(name)))
    using owner, sorted_next, stored;
  end if;

  return jsonb_build_object('status', 'saved', 'members', sorted_next);
end;
$$;

revoke execute on function public.save_fields(text, jsonb, jsonb, jsonb) from public, anon;
revoke execute on function public.save_links(text, jsonb, text, jsonb, jsonb) from public, anon;
grant execute on function public.save_fields(text, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.save_links(text, jsonb, text, jsonb, jsonb) to authenticated;

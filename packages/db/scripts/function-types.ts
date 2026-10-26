// Builds src/function-types.ts from pg_proc: each public function's argument names and types and its return type, so
// rpc()/rpcRows() are typed from the SQL itself. Imported by gen-types.ts and by the test that checks the file is current.
// Only type syntax, so it loads under --experimental-strip-types.

/** The part of pg.Client used here. */
interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
}

interface PgType {
  oid: number;
  name: string;
  /** b base, c composite, d domain, e enum, p pseudo, r range, m multirange */
  kind: string;
  category: string;
  elem: number;
  base: number;
  relid: number;
  labels: string[] | null;
}
interface Column {
  name: string;
  type: number;
  notNull: boolean;
}

const NUMBERS = new Set(["int2", "int4", "int8", "float4", "float8", "numeric", "oid", "money"]);
// Timestamps and dates are strings, int8 and numeric are numbers: what createPool's parsers give (and PostgREST gave).
const STRINGS = new Set([
  ...["text", "varchar", "bpchar", "name", "char", "citext", "uuid", "bytea", "inet", "cidr", "macaddr", "xml", "tsvector"],
  ...["timestamp", "timestamptz", "date", "time", "timetz", "interval"],
]);

// `returns table (…)` columns carry no nullability in the catalog, so they are plain unless listed here: a column the
// function fills from a nullable column or an outer join. Checked by hand against each function's SQL.
const NULLABLE_TABLE_COLUMNS: Record<string, readonly string[]> = {
  mcp_token_lookup: ["email", "active_workspace_id"],
  report_download: ["pdf"],
  revision_history: ["author_kind", "author_name", "changes", "note", "published_at"],
};

// Arguments with no default that the function nevertheless accepts as null (the catalog can't say): typed `| null`.
const NULLABLE_ARGS: Record<string, readonly string[]> = {
  submit_play_proposal: ["note", "issue"],
};

const q = (s: string) => JSON.stringify(s);
const key = (s: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : q(s));

export async function generateFunctionTypes(db: Queryable): Promise<string> {
  const types = new Map<number, PgType>();
  for (const r of (
    await db.query(`
      select t.oid::int8 as oid, t.typname as name, t.typtype as kind, t.typcategory as category, t.typelem::int8 as elem,
             t.typbasetype::int8 as base, t.typrelid::int8 as relid,
             (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels
      from pg_type t`)
  ).rows) {
    types.set(Number(r.oid), { ...r, oid: Number(r.oid), elem: Number(r.elem), base: Number(r.base), relid: Number(r.relid) } as PgType);
  }
  const columns = new Map<number, Column[]>();
  for (const r of (
    await db.query(`
      select a.attrelid::int8 as relid, a.attname::text as name, a.atttypid::int8 as type, a.attnotnull as not_null
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'v', 'm', 'p', 'c', 'f')
      order by a.attrelid, a.attnum`)
  ).rows) {
    const list = columns.get(Number(r.relid)) ?? [];
    list.push({ name: r.name, type: Number(r.type), notNull: r.not_null });
    columns.set(Number(r.relid), list);
  }

  const tsType = (oid: number): string => {
    const t = types.get(oid);
    if (!t) throw new Error(`function-types: unknown type oid ${oid}`);
    if (t.kind === "d") return tsType(t.base);
    if (t.kind === "e") return (t.labels ?? []).map(q).join(" | ") || "never";
    if (t.category === "A" && t.elem) {
      const inner = tsType(t.elem);
      return inner.includes(" ") ? `(${inner})[]` : `${inner}[]`;
    }
    if (t.kind === "c") return row(columns.get(t.relid) ?? []);
    if (t.name === "json" || t.name === "jsonb") return "Json";
    if (t.name === "bool") return "boolean";
    if (t.name === "void") return "null";
    if (NUMBERS.has(t.name)) return "number";
    if (STRINGS.has(t.name)) return "string";
    return "unknown";
  };
  // A column is `| null` unless it is declared not null (or, for `returns table`, not listed in NULLABLE_TABLE_COLUMNS).
  const row = (cols: Column[]): string => `{ ${cols.map((c) => `${key(c.name)}: ${tsType(c.type)}${c.notNull ? "" : " | null"}`).join("; ")} }`;

  const procs = (
    await db.query(`
      select p.proname as name,
             pg_get_function_identity_arguments(p.oid) as identity,
             p.proargnames as names, p.proargmodes::text[] as modes,
             coalesce(p.proallargtypes, string_to_array(p.proargtypes::text, ' ')::oid[])::int8[] as types,
             p.pronargdefaults::int as defaults, p.prorettype::int8 as ret, p.proretset as retset
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
      order by p.proname, identity`)
  ).rows;

  const byName = new Map<string, string[]>();
  for (const p of procs) {
    const allTypes: number[] = p.types.map(Number);
    const modes: string[] = p.modes ?? allTypes.map(() => "i");
    const names: string[] = p.names ?? [];
    const inputs: { name: string; type: number }[] = [];
    const outputs: { name: string; type: number }[] = [];
    allTypes.forEach((type, i) => {
      const arg = { name: names[i] ?? "", type };
      if (["i", "b", "v"].includes(modes[i]!)) inputs.push(arg);
      if (["o", "b", "t"].includes(modes[i]!)) outputs.push(arg);
    });
    const unnamed = inputs.find((a) => !a.name);
    if (unnamed) throw new Error(`function-types: public.${p.name}(${p.identity}) has an unnamed argument; rpc() calls arguments by name`);
    const firstDefault = inputs.length - p.defaults;
    const args = inputs.length
      ? `{ ${inputs.map((a, i) => `${key(a.name)}${i >= firstDefault ? "?" : ""}: ${tsType(a.type)}${NULLABLE_ARGS[p.name]?.includes(a.name) ? " | null" : ""}`).join("; ")} }`
      : "never";

    let returns: string;
    if (outputs.length) {
      // One OUT parameter is just a scalar result; several make a row.
      const one = outputs.length === 1 && modes.includes("o") && !modes.includes("t");
      const value = one ? tsType(outputs[0]!.type) : row(outputs.map((o) => ({ name: o.name, type: o.type, notNull: !NULLABLE_TABLE_COLUMNS[p.name]?.includes(o.name) })));
      returns = p.retset ? `${value.includes(" ") && one ? `(${value})` : value}[]` : value;
    } else {
      const ret = types.get(Number(p.ret))!;
      const value = tsType(Number(p.ret));
      returns = p.retset ? (ret.kind === "c" || !value.includes(" ") ? `${value}[]` : `(${value})[]`) : value;
    }
    const list = byName.get(p.name) ?? [];
    list.push(`{ Args: ${args}; Returns: ${returns} }`);
    byName.set(p.name, list);
  }

  const lines = [...byName].map(([name, sigs]) => `  ${key(name)}: ${sigs.join("\n    | ")};`);
  return [
    "// Generated by scripts/gen-types.ts from pg_proc (public schema). Do not edit.",
    "// Each function's named arguments (`?` where the function has a default) and what it returns. An overloaded function's",
    "// type is a union with one member per signature. Numbers (int8, numeric) and strings (timestamps, dates, uuid, text)",
    "// are the types createPool's parsers produce. A table or composite row's columns are `| null` where the table allows it;",
    "// `returns table (…)` columns are not, unless scripts/function-types.ts lists them (the catalog records no nullability).",
    'import type { Json } from "./db-types";',
    "",
    "export interface Functions {",
    ...lines,
    "}",
    "",
    "export type FunctionName = keyof Functions;",
    "",
  ].join("\n");
}

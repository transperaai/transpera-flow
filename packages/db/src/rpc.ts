import { sql, type Kysely } from "kysely";
import type { Database } from "./database.types";
import type { DB } from "./db-types";

// --- Calling SQL functions the way supabase-js `.rpc()` did. ---

type Functions = Database["public"]["Functions"];
type FnName = keyof Functions & string;
type FnArgs<N extends FnName> = Functions[N] extends { Args: infer A } ? A : never;
type FnReturns<N extends FnName> = Functions[N] extends { Returns: infer R } ? R : never;

const IDENT = /^[a-z_][a-z0-9_]*$/;

// Argument types of public functions, by name: PostgREST sent arguments as JSON and Postgres coerced them, so a JS array
// meant for a json/jsonb argument was JSON. node-postgres would send it as a Postgres array instead, so those are
// JSON-encoded here. The schema doesn't change while a process runs, so each function is looked up once.
const jsonArgs = new Map<string, Promise<Set<string>>>();

function jsonArgsOf(db: Kysely<DB>, name: string): Promise<Set<string>> {
  let found = jsonArgs.get(name);
  if (!found) {
    found = sql<{ arg: string }>`
      select distinct a.name as arg
      from pg_proc p, unnest(p.proargnames, coalesce(p.proallargtypes, p.proargtypes::oid[])) as a(name, type)
      where p.pronamespace = 'public'::regnamespace and p.proname = ${name} and a.type in ('json'::regtype, 'jsonb'::regtype)`
      .execute(db)
      .then((r) => new Set(r.rows.map((x) => x.arg)));
    found.catch(() => jsonArgs.delete(name));
    jsonArgs.set(name, found);
  }
  return found;
}

/** `public.name(k => v, …)` with named arguments; undefined ones are left out so their defaults apply, as PostgREST did. */
async function call(db: Kysely<DB>, name: string, args: object | undefined) {
  if (!IDENT.test(name)) throw new Error(`rpc: bad function name ${name}`);
  const entries = Object.entries(args ?? {}).filter(([, v]) => v !== undefined);
  const json = entries.some(([, v]) => v !== null && typeof v === "object") ? await jsonArgsOf(db, name) : new Set<string>();
  const named = entries.map(([k, v]) => {
    if (!IDENT.test(k)) throw new Error(`rpc: bad argument name ${k}`);
    return sql`${sql.id(k)} => ${json.has(k) && v !== null ? JSON.stringify(v) : v}`;
  });
  return sql`${sql.id("public")}.${sql.id(name)}(${sql.join(named)})`;
}

/**
 * A function returning one value or row (or void): what `.rpc()` gave as `data`. The result goes through to_json, so
 * numbers, JSON and timestamps come back exactly as PostgREST rendered them.
 */
export async function rpc<N extends FnName>(db: Kysely<DB>, name: N, args?: FnArgs<N>): Promise<FnReturns<N>> {
  const fn = await call(db, name, args as object | undefined);
  const { rows } = await sql<{ r: unknown }>`select to_json(f) as r from ${fn} as f`.execute(db);
  return (rows[0]?.r ?? null) as FnReturns<N>;
}

/** A set-returning function (`returns setof …` / `returns table`): its rows, as `.rpc()` gave them. */
export async function rpcRows<N extends FnName>(db: Kysely<DB>, name: N, args?: FnArgs<N>): Promise<FnReturns<N>> {
  const fn = await call(db, name, args as object | undefined);
  const { rows } = await sql<{ r: unknown }>`select coalesce(json_agg(f), '[]'::json) as r from ${fn} as f`.execute(db);
  return rows[0]!.r as FnReturns<N>;
}

import { sql, type Kysely } from "kysely";
import type { DB } from "./db-types";
import type { Functions } from "./function-types";

// --- Calling SQL functions the way PostgREST's `/rpc` did. ---

type FnName = keyof Functions & string;
// Distributes over an overloaded function's signatures, so any one of their argument lists is accepted.
type FnArgs<N extends FnName> = Functions[N] extends infer F ? (F extends { Args: infer A } ? A : never) : never;
type FnReturns<N extends FnName> = Functions[N] extends { Returns: infer R } ? R : never;

const IDENT = /^[a-z_][a-z0-9_]*$/;

// What the catalog says about a public function, by name: which arguments are json/jsonb, and the function's own
// `statement_timeout` if it has one. PostgREST sent arguments as JSON and Postgres coerced them, so a JS array meant for a
// json/jsonb argument was JSON; node-postgres would send it as a Postgres array instead, so those are JSON-encoded here.
// PostgREST also applied a function's own `set statement_timeout` (Postgres itself starts the clock for the calling statement
// before the function's setting takes effect, so a function's setting alone never lengthens it), so that is applied here
// before the call. The schema doesn't change while a process runs, so each function is looked up once.
interface FunctionInfo {
  jsonArgs: Set<string>;
  /** As Postgres spells it in `proconfig` ("40s"), or undefined when the function sets none. */
  statementTimeout: string | undefined;
}
const functionInfo = new Map<string, Promise<FunctionInfo>>();

const UNIT_MS: Record<string, number> = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };
/** A statement_timeout value in milliseconds (a bare number is ms, as in Postgres); NaN when not recognised. */
function timeoutMs(value: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/.exec(value);
  return m ? Number(m[1]) * UNIT_MS[m[2] ?? "ms"]! : NaN;
}

function functionInfoOf(db: Kysely<DB>, name: string): Promise<FunctionInfo> {
  let found = functionInfo.get(name);
  if (!found) {
    found = sql<{ config: string[] | null; json_args: string[] }>`
      select p.proconfig as config,
             array(select distinct a.name from unnest(p.proargnames, coalesce(p.proallargtypes, p.proargtypes::oid[])) as a(name, type)
                   where a.type in ('json'::regtype, 'jsonb'::regtype)) as json_args
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = ${name}`
      .execute(db)
      .then((r) => {
        // Overloads share a name here; the longest limit among them applies to all of them.
        const limits = r.rows.flatMap((x) => (x.config ?? []).flatMap((c) => (c.startsWith("statement_timeout=") ? [c.slice(18)] : [])));
        limits.sort((a, b) => timeoutMs(b) - timeoutMs(a) || 0);
        return { jsonArgs: new Set(r.rows.flatMap((x) => x.json_args)), statementTimeout: limits[0] };
      });
    found.catch(() => functionInfo.delete(name));
    functionInfo.set(name, found);
  }
  return found;
}

/** `public.name(k => v, …)` with named arguments; undefined ones are left out so their defaults apply, as PostgREST did. */
async function call(db: Kysely<DB>, name: string, args: object | undefined) {
  if (!IDENT.test(name)) throw new Error(`rpc: bad function name ${name}`);
  const entries = Object.entries(args ?? {}).filter(([, v]) => v !== undefined);
  // Looked up for every call, so a string meant for a jsonb argument is always a JSON string, whatever the other arguments are.
  const info = await functionInfoOf(db, name);
  const named = entries.map(([k, v]) => {
    if (!IDENT.test(k)) throw new Error(`rpc: bad argument name ${k}`);
    return sql`${sql.id(k)} => ${info.jsonArgs.has(k) && v !== null ? JSON.stringify(v) : v}`;
  });
  const fn = sql`${sql.id("public")}.${sql.id(name)}(${sql.join(named)})`;
  // The limit is set and the statement run on one connection and in one transaction, in that order. Inside db.transaction()
  // that is the transaction already open.
  const timeout = info.statementTimeout;
  const run = async <R>(f: (db: Kysely<DB>) => Promise<R>): Promise<R> => {
    if (!timeout) return f(db);
    // Reads the limit in force and sets the function's in one statement; the CTE is computed first, so `v` is the earlier limit.
    const apply = async (d: Kysely<DB>) =>
      (
        await sql<{ v: string }>`
          with prev as materialized (select current_setting('statement_timeout') as v)
          select v, set_config('statement_timeout', ${timeout}, true) from prev`.execute(d)
      ).rows[0]!.v;
    const restore = (d: Kysely<DB>, v: string) => sql`select set_config('statement_timeout', ${v}, true)`.execute(d);
    // Inside db.transaction() (or a db.connection() the caller holds) the connection stays open after the call, so the
    // earlier limit is put back and later statements keep theirs; a connection opened here is released (committed) right after.
    if (db.isTransaction) {
      const prev = await apply(db);
      const result = await f(db);
      await restore(db, prev);
      return result;
    }
    return db.connection().execute(async (c) => {
      const prev = await apply(c);
      const result = await f(c);
      await restore(c, prev);
      return result;
    });
  };
  return { fn, run };
}

/**
 * A function returning one value or row (or void): what `.rpc()` gave as `data`. The result goes through to_json, so
 * numbers, JSON and timestamps come back exactly as PostgREST rendered them.
 */
export async function rpc<N extends FnName>(db: Kysely<DB>, name: N, args?: FnArgs<N>): Promise<FnReturns<N>> {
  const { fn, run } = await call(db, name, args as object | undefined);
  const { rows } = await run((d) => sql<{ r: unknown }>`select to_json(f) as r from ${fn} as f`.execute(d));
  return (rows[0]?.r ?? null) as FnReturns<N>;
}

/** A set-returning function (`returns setof …` / `returns table`): its rows, as `.rpc()` gave them. */
export async function rpcRows<N extends FnName>(db: Kysely<DB>, name: N, args?: FnArgs<N>): Promise<FnReturns<N>> {
  const { fn, run } = await call(db, name, args as object | undefined);
  const { rows } = await run((d) => sql<{ r: unknown }>`select coalesce(json_agg(f), '[]'::json) as r from ${fn} as f`.execute(d));
  return rows[0]!.r as FnReturns<N>;
}

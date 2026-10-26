import pg from "pg";
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type TransactionSettings,
  sql,
} from "kysely";
import type { Database } from "./database.types";
import type { DB } from "./db-types";

// Query layer for the move off Supabase (docs/plans/supabase-exit-brief.md, step 1). Authorization stays in Postgres: every
// query runs as `authenticated` (or `anon` when signed out) with Supabase-shaped JWT claims set for its transaction, so
// the RLS policies and SECURITY DEFINER functions that call auth.uid() / auth.jwt() work unchanged.

/** What auth.jwt() returns inside a query. Built in one place in the app (apps/web/src/lib/db/claims.ts). */
export interface Claims {
  sub: string;
  role: "authenticated";
  email?: string;
  app_metadata?: { agency_admin?: boolean; [key: string]: unknown };
  /** Set for an MCP token (ADR 0002). */
  api_token_id?: string;
  [key: string]: unknown;
}

// --- Type parsing: match what PostgREST returned, so values keep their types across the port. ---

const OID = { int8: 20, numeric: 1700, date: 1082, timestamp: 1114, timestamptz: 1184 } as const;
const ARRAY_OID = { int8: 1016, numeric: 1231, date: 1182, timestamp: 1115, timestamptz: 1185 } as const;

const parseTextArray = pg.types.getTypeParser(1009 as never) as (v: string) => (string | null)[] | null;
const toNumbers = (v: unknown): unknown => (Array.isArray(v) ? v.map(toNumbers) : v === null ? null : Number(v));
const asString = (v: string) => v;

// Postgres's text output (DateStyle ISO, which every ClaimsDriver transaction pins) next to what to_json() gives, which is
// what PostgREST returned: "2026-10-26 10:00:00.5+00" → "2026-10-26T10:00:00.5+00:00". Only the separator and a whole-hour
// offset differ; "+05:30", "+00:09:21", " BC" and fractional seconds already match, and infinity passes through.
const TIMESTAMP = /^(\d{4,}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?)([+-]\d\d(?::\d\d){0,2})?( BC)?$/;
/** A timestamp or timestamptz in its text output → exactly Postgres's to_json() string for the same value. */
export function toJsonTimestamp(text: string): string {
  const m = TIMESTAMP.exec(text);
  if (!m) return text;
  const [, date, time, offset = "", bc = ""] = m;
  return `${date}T${time}${offset.length === 3 ? `${offset}:00` : offset}${bc}`;
}
const toJsonTimestamps = (v: string) => parseTextArray(v)?.map((t) => (t === null ? null : toJsonTimestamp(t))) ?? null;

/**
 * numeric and int8 arrive as numbers; timestamptz and timestamp as Postgres's to_json() strings (as PostgREST sent them);
 * date stays YYYY-MM-DD; json/jsonb parse as usual.
 */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    switch (oid) {
      case OID.int8:
      case OID.numeric:
        return Number;
      case OID.date:
        return asString;
      case OID.timestamp:
      case OID.timestamptz:
        return toJsonTimestamp;
      case ARRAY_OID.int8:
      case ARRAY_OID.numeric:
        return (v: string) => toNumbers(parseTextArray(v));
      // pg's own array parsers for dates build Date objects; the text[] parser leaves the strings alone.
      case ARRAY_OID.date:
        return parseTextArray;
      case ARRAY_OID.timestamp:
      case ARRAY_OID.timestamptz:
        return toJsonTimestamps;
      default:
        return pg.types.getTypeParser(oid, format as "text");
    }
  },
} as pg.CustomTypesConfig;

/**
 * One per process. Parsers are set on the pool, so other pg users (Better Auth, scripts) keep pg's defaults.
 * Logs, rather than crashes on, an idle client's error (Neon closes idle connections when the compute suspends).
 */
export function createPool(url: string, options: Omit<pg.PoolConfig, "connectionString" | "types"> = {}): pg.Pool {
  const pool = new pg.Pool({ ...options, connectionString: url, types });
  pool.on("error", (err) => console.error("db pool: idle client error", err));
  return pool;
}

// --- ClaimsDriver ---

// A server error (it has a severity) leaves the connection usable unless it is fatal; anything else (reset, timeout) does not.
const isBroken = (err: unknown) => {
  const severity = (err as { severity?: string } | null)?.severity;
  return severity === undefined || severity === "FATAL" || severity === "PANIC";
};
const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

/** Statements that can change the role or a setting for the rest of the transaction (`set role`, `reset all`, ...). */
const RESETS_STATE = new Set(["SET", "RESET", "DISCARD"]);

/**
 * The statement that puts a connection under the caller's claims, for the current transaction only (`set_config(..., true)`).
 * It also clears the legacy per-claim settings auth.uid() / auth.jwt() / auth.role() read first, so a value someone left
 * at session level on a pooled connection can't stand in for these claims, and pins TimeZone and DateStyle to what
 * Supabase's PostgREST sessions ran with (UTC, ISO), which the timestamp parser above relies on.
 */
function claimsStatement(claims: Claims | null): string {
  // The database role always follows whether there are claims, and the claims' role always says the same, so a caller
  // can't pass role "service_role" in the claims and have SQL that checks auth.role() treat it as the service role.
  // Signed out, PostgREST set {"role":"anon"} from the anon key; do the same so auth.role() reads 'anon'.
  const role = claims ? "authenticated" : "anon";
  const json = JSON.stringify(claims ? { ...claims, role } : { role });
  const set = (name: string, value: string) => `set_config('${name}', ${pg.escapeLiteral(value)}, true)`;
  return `select ${[
    set("role", role),
    set("request.jwt.claims", json),
    set("request.jwt.claim", ""),
    set("request.jwt.claim.sub", ""),
    set("request.jwt.claim.role", ""),
    set("TimeZone", "UTC"),
    set("DateStyle", "ISO, MDY"),
  ].join(", ")}`;
}

class ClaimsConnection implements DatabaseConnection {
  /** Set when the connection failed in a way that makes it unfit for reuse. */
  broken: Error | undefined;
  /** A statement may have changed the role or claims (`set role ...`): put them back before the next one. */
  #dirty = false;

  // The pool stops listening for errors on a checked-out client; without a listener a dropped connection would crash the process.
  readonly onError = (err: Error) => {
    this.broken = err;
  };

  constructor(
    readonly client: pg.PoolClient,
    private readonly claimsSql: string,
  ) {
    client.on("error", this.onError);
  }

  /** "I" outside a transaction, "T" inside one, "E" inside a failed one. */
  get status() {
    return this.client.getTransactionStatus();
  }

  /** Our own statements (claims, transaction control): simple protocol, no claims check first. */
  async run(text: string) {
    if (this.broken) throw this.broken;
    try {
      return await this.client.query(text);
    } catch (err) {
      if (isBroken(err)) this.broken = asError(err);
      throw err;
    }
  }

  /** Opens the claims transaction, or (inside one) applies the claims again. */
  async applyClaims() {
    const open = this.status === "I";
    await this.run(open ? `begin; ${this.claimsSql}` : this.claimsSql);
    if (this.status !== "T") throw new Error(`claims not applied: transaction status ${this.status}`);
    this.#dirty = false;
  }

  release() {
    this.client.off("error", this.onError);
    // A client still inside a transaction would hand that transaction (and its role and claims) to the next caller.
    const leftover = this.status === "I" ? undefined : new Error(`released with transaction status ${this.status}`);
    this.client.release(this.broken ?? leftover);
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    if (this.broken) throw this.broken;
    // No statement runs outside the claims: a raw `commit` / `rollback` (or the rollback of a db.transaction() inside
    // db.connection()) ended the claims transaction, and the next statement would otherwise run as the owner role.
    if (this.#dirty || this.status === "I") await this.applyClaims();
    try {
      // The extended protocol takes exactly one statement, so `commit; select ...` can't slip past the check above.
      const config = { text: compiled.sql, values: compiled.parameters as unknown[], queryMode: "extended" };
      const { command, rowCount, rows } = await this.client.query(config as pg.QueryConfig);
      if (RESETS_STATE.has(command)) this.#dirty = true;
      return {
        numAffectedRows: ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(command) ? BigInt(rowCount ?? 0) : undefined,
        rows: rows as R[],
      };
    } catch (err) {
      if (isBroken(err)) this.broken = asError(err);
      throw err;
    }
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming queries are not supported");
  }
}

/**
 * Kysely's own PostgresDriver can't do this job: it releases the client without an error argument (so a broken
 * connection would go back into the pool), and it keeps the client private, so a wrapper can't intercept either. This
 * driver talks to the pool directly instead.
 *
 * Every connection it hands out is already inside a transaction that has the role and claims set (`set_config(..., true)`
 * lasts to the end of the transaction). A statement outside db.transaction() is therefore its own short transaction:
 * `begin; set_config` on acquire, `commit` on release. Inside db.transaction() Kysely's begin and commit are no-ops
 * (we are already in one), and its rollback really rolls back; a statement after that rollback on the same connection
 * (db.connection()) opens a new claims transaction first.
 *
 * The app's login is the database owner, so the claims are the only thing between a statement and RLS-free access: the
 * connection re-applies them whenever a statement ended the transaction or ran SET/RESET. It can't see a
 * `select set_config('role', ...)` inside a statement; don't build SQL from user input.
 */
class ClaimsDriver implements Driver {
  readonly #claimsSql: string;

  constructor(
    private readonly pool: pg.Pool,
    claims: Claims | null,
  ) {
    this.#claimsSql = claimsStatement(claims);
  }

  async init() {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const client = await this.pool.connect();
    const connection = new ClaimsConnection(client, this.#claimsSql);
    try {
      if (connection.status !== "I") throw new Error(`pool handed out a client with transaction status ${connection.status}`);
      await connection.applyClaims();
    } catch (err) {
      // Mid-transaction or unreachable: don't hand this client to anyone else.
      connection.broken ??= asError(err);
      connection.release();
      throw err;
    }
    return connection;
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings) {
    // The transaction began on acquire, after which an isolation level or access mode can no longer be set.
    if (settings.isolationLevel || settings.accessMode) {
      throw new Error("Transaction isolation level and access mode are not supported");
    }
    // A second db.transaction() on one db.connection(), after the first rolled back.
    const c = connection as ClaimsConnection;
    if (c.status === "I") await c.applyClaims();
  }

  async commitTransaction() {
    // Committed in releaseConnection, so a failure there (deferred constraints) still reaches the caller.
  }

  async rollbackTransaction(connection: DatabaseConnection) {
    await (connection as ClaimsConnection).run("rollback");
  }

  async savepoint(connection: DatabaseConnection, name: string) {
    await (connection as ClaimsConnection).run(`savepoint ${pg.escapeIdentifier(name)}`);
  }

  async rollbackToSavepoint(connection: DatabaseConnection, name: string) {
    await (connection as ClaimsConnection).run(`rollback to ${pg.escapeIdentifier(name)}`);
  }

  async releaseSavepoint(connection: DatabaseConnection, name: string) {
    await (connection as ClaimsConnection).run(`release ${pg.escapeIdentifier(name)}`);
  }

  async releaseConnection(connection: DatabaseConnection) {
    const c = connection as ClaimsConnection;
    try {
      // Postgres turns a commit of an aborted transaction into a rollback, so a failed statement needs no special case.
      if (!c.broken && c.status !== "I") await c.run("commit");
    } finally {
      c.release();
    }
  }

  /** The pool is shared and outlives every Kysely instance; the owner ends it. */
  async destroy() {}
}

function dialect(pool: pg.Pool, claims: Claims | null): Dialect {
  return {
    createDriver: () => new ClaimsDriver(pool, claims),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: (db) => new PostgresIntrospector(db),
  };
}

/** A query builder that runs every statement as `claims`' user (null: signed out, role `anon`), with RLS applying. */
export function createDb(pool: pg.Pool, claims: Claims | null): Kysely<DB> {
  return new Kysely<DB>({ dialect: dialect(pool, claims) });
}

// --- Calling SQL functions the way supabase-js `.rpc()` did. ---

type Functions = Database["public"]["Functions"];
type FnName = keyof Functions & string;
type FnArgs<N extends FnName> = Functions[N] extends { Args: infer A } ? A : never;
type FnReturns<N extends FnName> = Functions[N] extends { Returns: infer R } ? R : never;

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** `public.name(k => v, …)` with named arguments; undefined ones are left out so their defaults apply, as PostgREST did. */
function call(name: string, args: object | undefined) {
  if (!IDENT.test(name)) throw new Error(`rpc: bad function name ${name}`);
  const named = Object.entries(args ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      if (!IDENT.test(k)) throw new Error(`rpc: bad argument name ${k}`);
      return sql`${sql.id(k)} => ${v}`;
    });
  return sql`${sql.id("public")}.${sql.id(name)}(${sql.join(named)})`;
}

/**
 * A function returning one value or row (or void): what `.rpc()` gave as `data`. The result goes through to_json, so
 * numbers, JSON and timestamps come back exactly as PostgREST rendered them.
 */
export async function rpc<N extends FnName>(db: Kysely<DB>, name: N, args?: FnArgs<N>): Promise<FnReturns<N>> {
  const fn = call(name, args);
  const { rows } = await sql<{ r: unknown }>`select to_json(f) as r from ${fn} as f`.execute(db);
  return (rows[0]?.r ?? null) as FnReturns<N>;
}

/** A set-returning function (`returns setof …` / `returns table`): its rows, as `.rpc()` gave them. */
export async function rpcRows<N extends FnName>(db: Kysely<DB>, name: N, args?: FnArgs<N>): Promise<FnReturns<N>> {
  const fn = call(name, args);
  const { rows } = await sql<{ r: unknown }>`select coalesce(json_agg(f), '[]'::json) as r from ${fn} as f`.execute(db);
  return rows[0]!.r as FnReturns<N>;
}

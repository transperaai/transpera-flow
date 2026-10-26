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
} from "kysely";
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

const parseTextArray = pg.types.getTypeParser(1009 as never) as (v: string) => unknown[] | null;
const toNumbers = (v: unknown): unknown => (Array.isArray(v) ? v.map(toNumbers) : v === null ? null : Number(v));
const asString = (v: string) => v;

/** numeric and int8 arrive as numbers; timestamptz, timestamp and date stay strings; json/jsonb parse as usual. */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    switch (oid) {
      case OID.int8:
      case OID.numeric:
        return Number;
      case OID.date:
      case OID.timestamp:
      case OID.timestamptz:
        return asString;
      case ARRAY_OID.int8:
      case ARRAY_OID.numeric:
        return (v: string) => toNumbers(parseTextArray(v));
      // pg's own array parsers for dates build Date objects; the text[] parser leaves the strings alone.
      case ARRAY_OID.date:
      case ARRAY_OID.timestamp:
      case ARRAY_OID.timestamptz:
        return parseTextArray;
      default:
        return pg.types.getTypeParser(oid, format as "text");
    }
  },
} as pg.CustomTypesConfig;

/** One per process. Parsers are set on the pool, so other pg users (Better Auth, scripts) keep pg's defaults. */
export function createPool(url: string, options: Omit<pg.PoolConfig, "connectionString" | "types"> = {}): pg.Pool {
  return new pg.Pool({ ...options, connectionString: url, types });
}

// --- ClaimsDriver ---

// A server error (it has a severity) leaves the connection usable unless it is fatal; anything else (reset, timeout) does not.
const isBroken = (err: unknown) => {
  const severity = (err as { severity?: string } | null)?.severity;
  return severity === undefined || severity === "FATAL" || severity === "PANIC";
};
const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

class ClaimsConnection implements DatabaseConnection {
  /** The claims transaction is over (rolled back), so release has nothing to commit. */
  ended = false;
  /** Set when the connection failed in a way that makes it unfit for reuse. */
  broken: Error | undefined;

  constructor(readonly client: pg.PoolClient) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    try {
      const { command, rowCount, rows } = await this.client.query(compiled.sql, compiled.parameters as unknown[]);
      return {
        numAffectedRows: ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(command) ? BigInt(rowCount ?? 0) : undefined,
        rows: rows as R[],
      };
    } catch (err) {
      if (isBroken(err)) this.broken = asError(err);
      throw err;
    }
  }

  // eslint-disable-next-line require-yield
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
 * (we are already in one), and its rollback really rolls back.
 */
class ClaimsDriver implements Driver {
  readonly #setup: string;

  constructor(
    private readonly pool: pg.Pool,
    claims: Claims | null,
  ) {
    const role = claims ? "authenticated" : "anon";
    const json = claims ? JSON.stringify(claims) : "";
    // One simple-protocol round trip (no parameters), so the claims go in as an escaped literal.
    this.#setup = `begin; select set_config('role', '${role}', true), set_config('request.jwt.claims', ${pg.escapeLiteral(json)}, true)`;
  }

  async init() {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const client = await this.pool.connect();
    try {
      await client.query(this.#setup);
    } catch (err) {
      // Mid-transaction or unreachable: don't hand this client to anyone else.
      client.release(asError(err));
      throw err;
    }
    return new ClaimsConnection(client);
  }

  async beginTransaction(_: DatabaseConnection, settings: TransactionSettings) {
    // The transaction began on acquire, after which an isolation level or access mode can no longer be set.
    if (settings.isolationLevel || settings.accessMode) {
      throw new Error("Transaction isolation level and access mode are not supported");
    }
  }

  async commitTransaction() {
    // Committed in releaseConnection, so a failure there (deferred constraints) still reaches the caller.
  }

  async rollbackTransaction(connection: DatabaseConnection) {
    const c = connection as ClaimsConnection;
    try {
      await c.client.query("rollback");
    } catch (err) {
      if (isBroken(err)) c.broken = asError(err);
      throw err;
    } finally {
      c.ended = true;
    }
  }

  async savepoint(connection: DatabaseConnection, name: string) {
    await connection.executeQuery(CompiledQuery.raw(`savepoint ${pg.escapeIdentifier(name)}`));
  }

  async rollbackToSavepoint(connection: DatabaseConnection, name: string) {
    await connection.executeQuery(CompiledQuery.raw(`rollback to ${pg.escapeIdentifier(name)}`));
  }

  async releaseSavepoint(connection: DatabaseConnection, name: string) {
    await connection.executeQuery(CompiledQuery.raw(`release ${pg.escapeIdentifier(name)}`));
  }

  async releaseConnection(connection: DatabaseConnection) {
    const c = connection as ClaimsConnection;
    if (!c.ended && !c.broken) {
      try {
        // Postgres turns a commit of an aborted transaction into a rollback, so a failed statement needs no special case.
        await c.client.query("commit");
      } catch (err) {
        c.broken = isBroken(err) ? asError(err) : undefined;
        c.client.release(c.broken);
        throw err;
      }
    }
    c.client.release(c.broken);
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

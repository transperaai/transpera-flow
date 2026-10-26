import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import { createPool } from "@transpera-flow/db/client";
import { authEnv } from "@/lib/auth/env";

// One pool per process and purpose, kept on globalThis so dev reloads reuse it. `attachDatabasePool` lets Vercel's Fluid compute
// close idle connections before a function instance is suspended.

const globalPools = globalThis as unknown as { __tfAppPool?: pg.Pool; __tfAuthPool?: pg.Pool };

function databaseUrl(): string {
  const env = authEnv();
  if (!env) throw new Error("DATABASE_URL and BETTER_AUTH_SECRET are not set");
  return env.databaseUrl;
}

/** The pool behind `getDb()`: numeric, int8 and date types parse as PostgREST returned them (see createPool). */
export function appPool(): pg.Pool {
  if (!globalPools.__tfAppPool) {
    globalPools.__tfAppPool = createPool(databaseUrl());
    attachDatabasePool(globalPools.__tfAppPool);
  }
  return globalPools.__tfAppPool;
}

/**
 * Better Auth's pool, and the one the sign-in access functions use. It connects as the database owner (it reads and writes
 * `better_auth.*` and `auth.users`), with pg's default parsers, and is never used for app queries.
 */
export function authPool(): pg.Pool {
  if (!globalPools.__tfAuthPool) {
    globalPools.__tfAuthPool = new pg.Pool({ connectionString: databaseUrl() });
    attachDatabasePool(globalPools.__tfAuthPool);
  }
  return globalPools.__tfAuthPool;
}

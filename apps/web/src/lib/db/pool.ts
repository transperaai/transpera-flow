import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import { createPool } from "@transpera-flow/db/client";
import { authEnv } from "@/lib/auth/env";

// One pool per process and purpose, kept on globalThis so dev reloads reuse it. `attachDatabasePool` lets Vercel's Fluid compute
// close idle connections before a function instance is suspended.

const globalPools = globalThis as unknown as { __tfAppPool?: pg.Pool; __tfAuthPool?: pg.Pool };

function env() {
  const found = authEnv();
  if (!found) throw new Error("DATABASE_URL and BETTER_AUTH_SECRET are not set");
  return found;
}

/**
 * The pool behind `getDb()`: numeric, int8 and date types parse as PostgREST returned them (see createPool). It connects with
 * `APP_DATABASE_URL` (the `authenticator` login, which can only become `anon` or `authenticated`) and falls back to
 * `DATABASE_URL` (the owner) where that is not set, such as local development.
 */
export function appPool(): pg.Pool {
  if (!globalPools.__tfAppPool) {
    globalPools.__tfAppPool = createPool(env().appDatabaseUrl);
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
    globalPools.__tfAuthPool = new pg.Pool({ connectionString: env().databaseUrl });
    attachDatabasePool(globalPools.__tfAuthPool);
  }
  return globalPools.__tfAuthPool;
}

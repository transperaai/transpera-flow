// Prepares the database the PostgREST end-to-end suite (postgrest.test.ts)
// runs against: auth and storage shims, every migration, the seed, and Supabase's
// `authenticator` login role. Run it, then start PostgREST against it (CI does
// both; see .github/workflows/ci.yml). Test-only: never point it at Supabase.
//
//   node --experimental-strip-types test/postgrest-db.ts

import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

// POSTGREST_DATABASE lets a local run use its own database beside another checkout's.
export const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const supabaseDir = new URL("../../db/supabase/", import.meta.url);

const root = new pg.Client({ connectionString: ADMIN_URL });
await root.connect();
await root.query(`drop database if exists ${DATABASE_NAME} with (force)`);
await root.query(`create database ${DATABASE_NAME}`);
await root.end();

const url = new URL(ADMIN_URL);
url.pathname = `/${DATABASE_NAME}`;
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
await db.query(readFileSync(new URL("../../db/test/sql/auth-shim.sql", import.meta.url), "utf8"));
await db.query(readFileSync(new URL("../../db/test/sql/storage-shim.sql", import.meta.url), "utf8"));
// Supabase's PostgREST login role, created before the migrations so the one
// that registers the pre-request hook on it applies.
await db.query(`do $$ begin
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'authenticator';
  end if;
end $$`);
await db.query("grant anon, authenticated, service_role to authenticator");
for (const f of readdirSync(new URL("migrations/", supabaseDir)).filter((f) => f.endsWith(".sql")).sort()) {
  await db.query(readFileSync(new URL(`migrations/${f}`, supabaseDir), "utf8"));
}
await db.query(readFileSync(new URL("seed.sql", supabaseDir), "utf8"));
await db.end();
console.log(`Prepared ${DATABASE_NAME}`);

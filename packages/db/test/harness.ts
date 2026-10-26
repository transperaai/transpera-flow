import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Kysely } from "kysely";
import { applyCompat, applyMigrations, type CompatOptions } from "../src/migrations";
import { createDb, createPool, type Claims } from "../src/client";
import type { DB } from "../src/db-types";

// Creates a throwaway database, applies the compat layer, every migration and the seed with the
// same code the migrate script runs on Neon, and lets tests run queries as a given user (RLS applies).

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const dir = (p: string) => new URL(p, import.meta.url);

export interface TestDb {
  client: pg.Client;
  /** Connection string of the throwaway database, for extra connections. */
  url: string;
  /** Run `fn` as `authenticated` with the given JWT claims, inside a rolled-back transaction. */
  as<T>(claims: Record<string, unknown> | null, fn: (c: pg.Client) => Promise<T>): Promise<T>;
  /** A `Db` acting as `claims`' user (null: signed out), as the app's getDb() gives one. Changes are committed. */
  dbAs(claims: Claims | null): Kysely<DB>;
  close(): Promise<void>;
}

export interface TestDbOptions {
  /** The Realtime stand-in (publication and realtime.messages) loads by default; `false` leaves it out. */
  realtime?: boolean;
  /**
   * Give anon, authenticated and service_role full privileges on every table made from now on, as a Supabase project did.
   * Neon has no such default, but the migrations were written and applied on Supabase, where every table started with all
   * privileges: the tests that check what the migrations revoke or grant (and the ones on the production data's history) still
   * run with it, to show the migrations leave the right privileges whichever way a database starts.
   */
  supabaseDefaultPrivileges?: boolean;
}

/** The compat layer and legacy shims (as in production), plus the test-only grants. Run before any migration. */
export async function loadShims(client: pg.Client, options: CompatOptions = {}): Promise<void> {
  await applyCompat(client, options);
  await client.query(readFileSync(dir("./sql/test-extras.sql"), "utf8"));
}

export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
  const name = `transpera_flow_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();

  await loadShims(client, { realtimeShim: options.realtime });
  if (options.supabaseDefaultPrivileges) {
    await client.query("alter default privileges in schema public grant all on tables to anon, authenticated, service_role");
  }
  await applyMigrations(client, { seed: true });

  let pool: pg.Pool | undefined;
  return {
    client,
    url: url.toString(),
    dbAs(claims) {
      pool ??= createPool(url.toString(), { max: 4 });
      return createDb(pool, claims);
    },
    async as(claims, fn) {
      await client.query("begin");
      try {
        await client.query("set local role authenticated");
        await client.query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : ""]);
        return await fn(client);
      } finally {
        await client.query("rollback");
      }
    },
    async close() {
      await pool?.end();
      await client.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export interface UserOptions {
  /** Add a Google identity; `hd` is the ID token's hosted-domain claim (absent for personal accounts). */
  google?: { hd?: string };
  /** Leave the email unconfirmed. */
  unconfirmed?: boolean;
}

export async function createUser(
  db: TestDb,
  email: string,
  appMetadata: Record<string, unknown> = {},
  options: UserOptions = {},
) {
  const id = randomUUID();
  await db.client.query(
    "insert into auth.users (id, email, raw_app_meta_data, email_confirmed_at) values ($1, $2, $3, $4)",
    [id, email, appMetadata, options.unconfirmed ? null : new Date()],
  );
  if (options.google) {
    // Mirrors what Supabase Auth stores from Google's ID token.
    const hd = options.google.hd;
    const identityData = { sub: id, email, ...(hd ? { custom_claims: { hd } } : {}) };
    await db.client.query(
      "insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, 'google', $2, $3)",
      [id, id, identityData],
    );
  }
  return { id, claims: { sub: id, role: "authenticated", app_metadata: appMetadata } };
}

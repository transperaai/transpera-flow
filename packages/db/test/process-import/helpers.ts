import { randomUUID } from "node:crypto";
import type pg from "pg";
import { vi } from "vitest";
import type { Claims } from "../../src/client";
import { createTestDb, type TestDb, type TestDbOptions } from "../harness";

// These suites came from the MCP package, whose config allowed 60 s a test and 120 s a hook: each builds its own database and
// imports whole processes, which can pass the default 5 s when the shared Postgres is busy.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/** What a signed-in user's queries run as: Supabase-shaped claims, as the app's `claimsFor` builds them for a session. */
export function userClaims(sub: string, extra: Partial<Claims> = {}): Claims {
  return { sub, role: "authenticated", aud: "authenticated", app_metadata: {}, ...extra };
}

/** A throwaway database (every migration and the seed), and `dbAs` for queries as a user. */
export interface ImportTestDb {
  /** The harness: `client` runs as the database owner (no RLS), for setting up and checking rows. */
  t: TestDb;
  /** A `Db` acting as `claims`' user, as the web app's `getDb()` gives one (null: signed out). */
  dbAs: TestDb["dbAs"];
  close(): Promise<void>;
}

export async function startTestDb(testOptions: TestDbOptions = {}): Promise<ImportTestDb> {
  const t = await createTestDb(testOptions);
  return { t, dbAs: (claims) => t.dbAs(claims), close: () => t.close() };
}

/** A user in auth.users, with the metadata `raw_app_meta_data` holds (`agency_admin` …). */
export async function createUser(admin: pg.Client, email: string, appMetadata: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await admin.query("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, $3)", [id, email, appMetadata]);
  return id;
}

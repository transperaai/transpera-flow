import { readdirSync, readFileSync } from "node:fs";

// Applies the schema: compat.sql and legacy-shims.sql (idempotent), then each file in migrations/ that
// public.schema_migrations doesn't list yet. Shared by scripts/migrate.ts and the test harness, so tests and Neon run
// identical SQL. Only node built-ins are imported, so scripts load it under --experimental-strip-types.

/** The part of pg.Client / pg.PoolClient used here. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** Marks where legacy-shims.sql turns from the Storage stand-in to the Realtime one. */
const REALTIME_MARKER = "-- @realtime-shim";

export interface CompatOptions {
  /** Load the Realtime stand-in (publication and realtime.messages). On by default. */
  realtimeShim?: boolean;
}

export async function applyCompat(db: Queryable, options: CompatOptions = {}): Promise<void> {
  await db.query(read("sql/compat.sql"));
  const shims = read("sql/legacy-shims.sql");
  await db.query(options.realtimeShim === false ? shims.slice(0, shims.indexOf(REALTIME_MARKER)) : shims);
}

/** Migration file names, oldest first. seed.sql and bootstrap.sql live beside migrations/, not in it. */
export function migrationFiles(): string[] {
  return readdirSync(new URL("migrations/", root)).filter((f) => f.endsWith(".sql")).sort();
}

const versionOf = (file: string) => file.split("_")[0]!;

export interface MigrateOptions {
  /** List what would be applied without applying it. */
  dryRun?: boolean;
  /** After a run that applied migrations, load seed.sql (local dev and tests only). */
  seed?: boolean;
}

export interface MigrateResult {
  /** Migrations applied (or, for a dry run, pending), in order. */
  files: string[];
  seeded: boolean;
}

export async function applyMigrations(db: Queryable, options: MigrateOptions = {}): Promise<MigrateResult> {
  if (options.dryRun) {
    // A dry run changes nothing, not even the log table: no table means everything is pending.
    const exists = (await db.query("select to_regclass('public.schema_migrations') as t")).rows[0]!.t !== null;
    const done = exists ? await appliedVersions(db) : new Set<string>();
    return { files: migrationFiles().filter((f) => !done.has(versionOf(f))), seeded: false };
  }
  await db.query(
    "create table if not exists public.schema_migrations (version text primary key, applied_at timestamptz default now())",
  );
  const done = await appliedVersions(db);
  const files: string[] = [];
  for (const file of migrationFiles()) {
    if (done.has(versionOf(file))) continue;
    await db.query("begin");
    try {
      await db.query(read(`migrations/${file}`));
      await db.query("insert into public.schema_migrations (version) values ($1)", [versionOf(file)]);
      await db.query("commit");
    } catch (err) {
      await db.query("rollback");
      throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    files.push(file);
  }
  let seeded = false;
  if (options.seed && files.length > 0) {
    await db.query(read("seed.sql"));
    seeded = true;
  }
  return { files, seeded };
}

async function appliedVersions(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query("select version from public.schema_migrations");
  return new Set(rows.map((r) => r.version as string));
}

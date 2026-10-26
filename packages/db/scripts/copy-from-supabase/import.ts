// Loads an export (export.ts) into a database already migrated to the current head, in one transaction
// (docs/plans/supabase-exit-brief.md, step 7a).
//   node --experimental-strip-types scripts/copy-from-supabase/import.ts --in <dir> [--url <target postgres url>] [--driver pg|neon-ws]
//       [--dry-run] [--no-replica]
// The target is the owner connection (DATABASE_URL when --url is absent) and must hold no data yet, apart from deployment_access.
// --dry-run prints the report and rolls everything back. --no-replica skips `set session_replication_role = replica`, taking the
// path used when the database refuses it (Neon): foreign-key order, user triggers disabled per table. --driver neon-ws connects
// through @neondatabase/serverless over a WebSocket (connect.ts), for a machine without TCP access to Neon.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { migrationFiles } from "../../src/migrations.ts";
import { DRIVERS, connectTarget, type Driver } from "./connect.ts";
import { listForeignKeys, planLoad, type ForeignKey } from "./foreign-keys.ts";
import {
  EXPECTED_SOURCE_VERSION,
  LOGO_MAX_BYTES,
  LOGO_MIMES,
  REPORT_FILE,
  STORAGE_FILE,
  brandingFile,
  isMain,
  parseRowsExactly,
  qualified,
  quoteIdent,
  quoteLiteral,
  readJson,
  readManifest,
  runMain,
  splitName,
  tableFile,
  usageError,
  writePrivate,
  type Queryable,
  type StorageObject,
} from "./shared.ts";

export interface ImportOptions {
  /** The export directory. */
  dir: string;
  dryRun?: boolean;
  /** Take the fallback path without trying the replica role (a test of what happens when the database refuses it). */
  forceFallback?: boolean;
  /** Rows per insert. Default 500. */
  chunkSize?: number;
  /** How long to wait for a table lock before failing, as Postgres reads it. Default 15s. */
  lockTimeout?: string;
  log?: (line: string) => void;
}

export interface ImportReport {
  dryRun: boolean;
  /** `replica`: foreign keys and triggers were off through session_replication_role. `fallback`: foreign-key order and `disable trigger user`. */
  path: "replica" | "fallback";
  pathReason: string;
  sourceMaxMigration: string | null;
  /** Rows loaded per table. */
  tables: Record<string, number>;
  /** Columns the export had and the target has not, per table (their data is dropped). */
  droppedColumns: Record<string, string[]>;
  /** Fallback path: tables whose user triggers were off while loading. */
  triggersDisabledOn: string[];
  /** Fallback path: `table.constraint` loaded as null and updated afterwards. */
  deferredKeys: string[];
  betterAuth: {
    users: number;
    accounts: number;
    skippedUsers: { id: string; email: string | null; reason: string }[];
    skippedAccounts: { id: string; provider: string; reason: string }[];
    /** Identities with a provider other than Google, which get no Better Auth account. */
    otherProviders: Record<string, number>;
  };
  deploymentAccess: {
    added: { email: string; role: string }[];
    existing: string[];
    skipped: { email: string | null; reason: string }[];
  };
  logos: {
    loaded: { workspaceId: string; mime: string; bytes: number; sha256: string }[];
    oversized: { workspaceId: string; path: string; bytes: number }[];
    skipped: { workspaceId: string; path: string; reason: string }[];
  };
  /** Storage objects that are not copied (only the current logos are), per bucket. */
  storageNotCopied: Record<string, number>;
  sequences: Record<string, number>;
  warnings: string[];
}

type Row = Record<string, unknown>;

const SCHEMAS = ["public", "auth", "better_auth"];
const EMAIL_RULE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const BETTER_AUTH_TABLES = ["better_auth.user", "better_auth.account"];
const ADDED_TABLES = ["public.workspace_logos", "public.deployment_access"];

export async function runImport(client: Queryable, options: ImportOptions): Promise<ImportReport> {
  const log = options.log ?? (() => {});
  const chunkSize = options.chunkSize ?? 500;
  const manifest = readManifest(options.dir);
  const storagePath = join(options.dir, STORAGE_FILE);
  const storage = existsSync(storagePath) ? readJson<StorageObject[]>(storagePath) : [];
  const warnings: string[] = [];

  // --- Before anything is written -----------------------------------------------------------------------------------------
  const applied = new Set((await client.query("select version from public.schema_migrations")).rows.map((r) => r.version as string));
  const pending = migrationFiles().filter((f) => !applied.has(f.split("_")[0]!));
  if (pending.length > 0) throw new Error(`the target is not at the current head (${pending.length} migration(s) pending, first ${pending[0]}); run pnpm migrate first`);
  const head = migrationFiles().at(-1)!.split("_")[0]!;
  if (manifest.maxMigration === null) warnings.push("the export does not say which migration the source was at");
  else if (manifest.maxMigration > head) throw new Error(`the export is from migration ${manifest.maxMigration}, newer than the target's head ${head}`);
  else if (manifest.maxMigration !== EXPECTED_SOURCE_VERSION) warnings.push(`the source was at migration ${manifest.maxMigration}, not ${EXPECTED_SOURCE_VERSION}`);

  const targetColumns = await loadColumns(client);
  const exported = Object.keys(manifest.tables);
  for (const name of exported) {
    if (!targetColumns.has(name)) throw new Error(`the target has no table ${name}, so its ${manifest.tables[name]!.rows} rows have nowhere to go`);
  }
  const mustBeEmpty = [...exported, ...BETTER_AUTH_TABLES, "public.workspace_logos"];
  await assertEmpty(client, mustBeEmpty);
  const disabled = (
    await client.query(
      `select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal and t.tgenabled <> 'O' and n.nspname = any ($1)`,
      [SCHEMAS],
    )
  ).rows[0]!.n as number;
  if (disabled > 0) throw new Error(`${disabled} trigger(s) in the target are already disabled; enable them first so this import can tell what it changed`);

  // Reading every file up front finds a missing or damaged one before the transaction starts.
  const data = new Map<string, Row[]>();
  for (const name of exported) {
    const rows = parseRowsExactly(readFileSync(join(options.dir, tableFile(name)), "utf8")) as Row[];
    if (rows.length !== manifest.tables[name]!.rows) throw new Error(`${tableFile(name)} holds ${rows.length} rows, the manifest says ${manifest.tables[name]!.rows}`);
    // Only the manifest's columns are loaded, so a key it doesn't list would be dropped without a word.
    const listed = new Set(manifest.tables[name]!.columns);
    const unlisted = new Set(rows.flatMap((r) => Object.keys(r).filter((k) => !listed.has(k))));
    if (unlisted.size > 0) throw new Error(`${tableFile(name)} has columns the manifest does not list: ${[...unlisted].join(", ")}`);
    data.set(name, rows);
  }
  const droppedColumns: ImportReport["droppedColumns"] = {};
  for (const name of exported) {
    const have = targetColumns.get(name)!;
    // A column the target computes itself (generated) is recomputed from the copied ones, so it is not lost.
    const gone = manifest.tables[name]!.columns.filter((c) => !have.some((t) => t.name === c));
    if (gone.length > 0) droppedColumns[name] = gone;
    const absent = have.filter((t) => t.required && !manifest.tables[name]!.columns.includes(t.name));
    if (absent.length > 0) throw new Error(`${name}: the target requires ${absent.map((a) => a.name).join(", ")}, which the export does not have`);
  }

  const report: ImportReport = {
    dryRun: options.dryRun === true,
    path: "replica",
    pathReason: "",
    sourceMaxMigration: manifest.maxMigration,
    tables: {},
    droppedColumns,
    triggersDisabledOn: [],
    deferredKeys: [],
    betterAuth: { users: 0, accounts: 0, skippedUsers: [], skippedAccounts: [], otherProviders: {} },
    deploymentAccess: { added: [], existing: [], skipped: [] },
    logos: { loaded: [], oversized: [], skipped: [] },
    storageNotCopied: {},
    sequences: {},
    warnings,
  };

  // --- One transaction ------------------------------------------------------------------------------------------------------
  await client.query("begin");
  try {
    await client.query("set local statement_timeout = 0");
    // Nothing else may write these tables until the commit (a preview deployment signing someone in, say). Waiting long for
    // that lock, or for the stronger one `disable trigger` takes, fails the import instead of hanging it.
    await client.query("select set_config('lock_timeout', $1, true)", [options.lockTimeout ?? "15s"]);
    const written = [...exported, ...BETTER_AUTH_TABLES, ...ADDED_TABLES];
    await client.query(`lock table ${written.map(qualified).join(", ")} in exclusive mode`);
    await assertEmpty(client, mustBeEmpty);
    const replica = await tryReplica(client, options.forceFallback === true);
    report.path = replica.ok ? "replica" : "fallback";
    report.pathReason = replica.reason;
    log(`path: ${report.path} (${report.pathReason})`);

    let order = exported;
    let deferred: ForeignKey[] = [];
    if (!replica.ok) {
      // Foreign keys are enforced and user triggers are the only thing that can be switched off, per table.
      for (const name of written) await client.query(`alter table ${qualified(name)} disable trigger user`);
      report.triggersDisabledOn = written;
      ({ order, deferred } = planLoad(exported, await listForeignKeys(client)));
      report.deferredKeys = deferred.map((fk) => `${fk.child}.${fk.name}`);
    }

    const logoPaths: { workspaceId: string; path: string }[] = [];
    const fills: (() => Promise<void>)[] = [];
    for (const name of order) {
      const rows = data.get(name)!;
      if (name === "public.workspaces") {
        // branding.logo_path is gone from the target's shape check; the logo itself goes to workspace_logos below.
        for (const row of rows) {
          const branding = row.branding as Row | null;
          if (branding && typeof branding === "object" && "logo_path" in branding) {
            if (typeof branding.logo_path === "string" && branding.logo_path !== "") logoPaths.push({ workspaceId: row.id as string, path: branding.logo_path });
            delete branding.logo_path;
          }
        }
      }
      const target = targetColumns.get(name)!;
      const columns = manifest.tables[name]!.columns.filter((c) => target.some((t) => t.name === c && !t.generated));
      const own = deferred.filter((fk) => fk.child === name);
      const nulled = new Set(own.flatMap((fk) => fk.childColumns.filter((c, i) => fk.nullable[i] && columns.includes(c))));
      const overrideIdentity = target.some((t) => t.identityAlways && columns.includes(t.name));
      report.tables[name] = await insertRows(client, name, columns, rows, chunkSize, { nulled, overrideIdentity });
      // After the loop: a key in a cycle points at a table that loads later.
      if (own.length > 0) fills.push(() => fillDeferred(client, name, columns, nulled, rows, chunkSize));
    }
    for (const fill of fills) await fill();

    await copyToBetterAuth(client, report, chunkSize, data.get("auth.users") ?? []);
    await copyLogos(client, report, logoPaths, storage, options.dir);
    await seedDeploymentAccess(client, report);
    report.sequences = await resetSequences(client);

    const notCopied: Record<string, number> = {};
    const copied = new Set(report.logos.loaded.map((l) => l.workspaceId));
    for (const o of storage) if (o.bucket !== "branding" || !logoPaths.some((l) => l.path === o.name && copied.has(l.workspaceId))) notCopied[o.bucket] = (notCopied[o.bucket] ?? 0) + 1;
    report.storageNotCopied = notCopied;

    // Deferred foreign-key checks run now, while they can still fail the import (and ALTER TABLE refuses with events pending).
    await client.query("set constraints all immediate");
    if (!replica.ok) for (const name of written) await client.query(`alter table ${qualified(name)} enable trigger user`);
    await client.query(options.dryRun ? "rollback" : "commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
  return report;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------------------------------------

interface Column {
  name: string;
  generated: boolean;
  /** `generated always as identity`: only `overriding system value` lets a copied value in. */
  identityAlways: boolean;
  /** NOT NULL with no default: the export must supply it. */
  required: boolean;
}

/** Throws when any of `tables` has a row (audit_log may hold the audit of deployment_access rules added through the app). */
async function assertEmpty(client: Queryable, tables: string[]): Promise<void> {
  const notEmpty: string[] = [];
  for (const name of tables) {
    const where = name === "public.audit_log" ? " where target_table <> 'deployment_access'" : "";
    if ((await client.query(`select exists (select 1 from ${qualified(name)}${where}) as e`)).rows[0]!.e) notEmpty.push(name);
  }
  if (notEmpty.length > 0) throw new Error(`the target already has rows in ${notEmpty.join(", ")}; import into a freshly migrated database`);
}

async function loadColumns(client: Queryable): Promise<Map<string, Column[]>> {
  const { rows } = await client.query(
    `select n.nspname as schema, c.relname as tbl, a.attname as col, a.attgenerated <> '' as generated, a.attidentity = 'a' as identity_always,
            a.attnotnull and not a.atthasdef and a.attidentity = '' and a.attgenerated = '' as required
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and n.nspname = any ($1) and c.relname <> 'schema_migrations'
      order by n.nspname, c.relname, a.attnum`,
    [SCHEMAS],
  );
  const out = new Map<string, Column[]>();
  for (const r of rows) {
    const key = `${r.schema as string}.${r.tbl as string}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push({ name: r.col as string, generated: r.generated as boolean, identityAlways: r.identity_always as boolean, required: r.required as boolean });
  }
  return out;
}

/** `set local session_replication_role = replica`, which switches off foreign-key checks and every ordinary trigger; the fallback when the role may not. */
async function tryReplica(client: Queryable, force: boolean): Promise<{ ok: boolean; reason: string }> {
  if (force) return { ok: false, reason: "forced by --no-replica" };
  await client.query("savepoint try_replica");
  try {
    await client.query("set local session_replication_role = replica");
    await client.query("release savepoint try_replica");
    return { ok: true, reason: "session_replication_role = replica was accepted" };
  } catch (err) {
    await client.query("rollback to savepoint try_replica");
    if ((err as { code?: string }).code === "42501") return { ok: false, reason: "session_replication_role = replica was refused (42501, permission denied)" };
    throw err;
  }
}

/** A row's JSON is at most this long in one statement's parameter, so a table of big rows (reports.pdf) goes in small batches. */
const CHUNK_BYTES = 8 * 1024 * 1024;

/** `rows` as JSON arrays of at most `size` rows and about CHUNK_BYTES characters each (a single bigger row goes alone). */
const chunks = (rows: Row[], size: number): string[] => {
  const out: string[] = [];
  let part: string[] = [];
  let length = 0;
  for (const row of rows) {
    const text = JSON.stringify(row);
    if (part.length > 0 && (part.length >= size || length + text.length > CHUNK_BYTES)) {
      out.push(`[${part.join(",")}]`);
      part = [];
      length = 0;
    }
    part.push(text);
    length += text.length + 1;
  }
  if (part.length > 0) out.push(`[${part.join(",")}]`);
  return out;
};

/** Inserts `rows` through json_populate_recordset, naming only `columns`: a column the export lacks takes the target's default. */
async function insertRows(
  client: Queryable,
  table: string,
  columns: string[],
  rows: Row[],
  chunkSize: number,
  options: { nulled?: Set<string>; overrideIdentity?: boolean } = {},
): Promise<number> {
  if (rows.length === 0 || columns.length === 0) return 0;
  const q = qualified(table);
  const nulled = options.nulled ?? new Set<string>();
  const sql = `insert into ${q} (${columns.map(quoteIdent).join(", ")})${options.overrideIdentity ? " overriding system value" : ""}
    select ${columns.map((c) => (nulled.has(c) ? "null" : `r.${quoteIdent(c)}`)).join(", ")}
    from json_populate_recordset(null::${q}, $1::json) as r`;
  let n = 0;
  for (const chunk of chunks(rows, chunkSize)) n += (await client.query(sql, [chunk])).rowCount ?? 0;
  if (n !== rows.length) throw new Error(`${table}: inserted ${n} of ${rows.length} rows`);
  return n;
}

/** Sets the columns that loaded as null (a self-reference or a cycle), by primary key, once every table is in. */
async function fillDeferred(client: Queryable, table: string, columns: string[], nulled: Set<string>, rows: Row[], chunkSize: number): Promise<void> {
  const q = qualified(table);
  const [schema, name] = splitName(table);
  const pk = (
    await client.query(
      `select a.attname::text as col from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        where i.indisprimary and i.indrelid = ${quoteLiteral(`${quoteIdent(schema)}.${quoteIdent(name)}`)}::regclass order by k.ord`,
    )
  ).rows.map((r) => r.col as string);
  if (pk.length === 0 || !pk.every((c) => columns.includes(c))) throw new Error(`${table} has deferred foreign keys but no primary key to update by`);
  const cols = [...nulled];
  const sql = `update ${q} t set ${cols.map((c) => `${quoteIdent(c)} = r.${quoteIdent(c)}`).join(", ")}
    from json_populate_recordset(null::${q}, $1::json) as r where ${pk.map((c) => `t.${quoteIdent(c)} = r.${quoteIdent(c)}`).join(" and ")}`;
  for (const chunk of chunks(rows, chunkSize)) await client.query(sql, [chunk]);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Better Auth
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * One better_auth."user" per auth.users row that has an email, and one better_auth.account per Google identity. auth.users is
 * already loaded as it was, which is why the sync_auth_user trigger must not run for these inserts (it would rewrite auth.users).
 */
async function copyToBetterAuth(client: Queryable, report: ImportReport, chunkSize: number, sourceUsers: Row[]): Promise<void> {
  const now = new Date().toISOString();
  // auth.users' created_at and updated_at are in the export but not in the target's auth.users, so they are read from the export.
  const stamps = new Map(sourceUsers.map((u) => [u.id as string, u]));
  const stamp = (v: unknown) => (typeof v === "string" && v !== "" ? v : now);
  // Better Auth keeps one user per address. Should two auth.users share one (any case), the one Google signs in to wins, then
  // a confirmed one; the other is reported.
  const users = (
    await client.query(
      `select u.id, u.email, u.email_confirmed_at, u.raw_user_meta_data from auth.users u
        order by lower(btrim(u.email)), exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'google') desc,
                 u.email_confirmed_at is null, u.id`,
    )
  ).rows;
  const seen = new Set<string>();
  const made = new Set<string>();
  const rows: Row[] = [];
  for (const u of users) {
    const id = u.id as string;
    const email = typeof u.email === "string" ? u.email.trim().toLowerCase() : "";
    if (email === "") {
      report.betterAuth.skippedUsers.push({ id, email: null, reason: "no email" });
      continue;
    }
    if (seen.has(email)) {
      report.betterAuth.skippedUsers.push({ id, email, reason: "another user has the same email (Better Auth keeps one per address)" });
      continue;
    }
    seen.add(email);
    made.add(id);
    const meta = (u.raw_user_meta_data ?? {}) as Row;
    const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
    rows.push({
      id,
      name: text(meta.full_name) ?? text(meta.name) ?? email.split("@")[0],
      email,
      emailVerified: u.email_confirmed_at != null,
      image: text(meta.avatar_url) ?? text(meta.picture),
      createdAt: stamp(stamps.get(id)?.created_at),
      updatedAt: stamp(stamps.get(id)?.updated_at ?? stamps.get(id)?.created_at),
    });
  }
  const userCols = ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"];
  report.betterAuth.users = await insertRows(client, "better_auth.user", userCols, rows, chunkSize);

  const accounts: Row[] = [];
  const identities = (await client.query("select id, user_id, provider, provider_id, created_at from auth.identities order by provider, provider_id")).rows;
  for (const i of identities) {
    const provider = i.provider as string;
    if (provider !== "google") {
      report.betterAuth.otherProviders[provider] = (report.betterAuth.otherProviders[provider] ?? 0) + 1;
      continue;
    }
    if (!made.has(i.user_id as string)) {
      report.betterAuth.skippedAccounts.push({ id: i.id as string, provider, reason: "its user has no Better Auth user" });
      continue;
    }
    accounts.push({
      id: randomUUID(),
      accountId: i.provider_id,
      providerId: "google",
      userId: i.user_id,
      createdAt: i.created_at instanceof Date ? i.created_at.toISOString() : now,
      updatedAt: now,
    });
  }
  report.betterAuth.accounts = await insertRows(client, "better_auth.account", ["id", "accountId", "providerId", "userId", "createdAt", "updatedAt"], accounts, chunkSize);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Logos and deployment access
// ---------------------------------------------------------------------------------------------------------------------------

const EXTENSION_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

async function copyLogos(client: Queryable, report: ImportReport, logoPaths: { workspaceId: string; path: string }[], storage: StorageObject[], dir: string): Promise<void> {
  for (const { workspaceId, path } of logoPaths) {
    const skip = (reason: string) => report.logos.skipped.push({ workspaceId, path, reason });
    const object = storage.find((o) => o.bucket === "branding" && o.name === path);
    if (!object) {
      skip("no such object in storage.json");
      continue;
    }
    const file = join(dir, object.file ?? brandingFile(path));
    if (!existsSync(file)) {
      skip(`its bytes are not in the export${object.error ? ` (${object.error})` : ""}`);
      continue;
    }
    const bytes = readFileSync(file);
    if (bytes.length > LOGO_MAX_BYTES) {
      report.logos.oversized.push({ workspaceId, path, bytes: bytes.length });
      continue;
    }
    if (bytes.length === 0) {
      skip("the object is empty");
      continue;
    }
    const mime = (object.contentType ?? EXTENSION_MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!LOGO_MIMES.includes(mime)) {
      skip(`type ${mime || "unknown"} is not PNG, JPEG or WebP`);
      continue;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // The table's own checks have the last word: a refusal skips this logo and the rest carry on.
    await client.query("savepoint logo");
    try {
      await client.query("insert into public.workspace_logos (workspace_id, mime, bytes, sha256) values ($1, $2, $3, $4)", [workspaceId, mime, bytes, sha256]);
      await client.query("release savepoint logo");
      report.logos.loaded.push({ workspaceId, mime, bytes: bytes.length, sha256 });
    } catch (err) {
      await client.query("rollback to savepoint logo");
      if ((err as { code?: string }).code !== "23514") throw err;
      skip(`refused by the table's check ${(err as { constraint?: string }).constraint ?? ""}`.trim());
    }
  }
}

/**
 * A named-email rule per user (brief, 7a): agency admins get admin; owners and editors anywhere get editor; everyone else
 * viewer. A user whose email already has a rule keeps it. Guests aren't seeded (they are not users here).
 */
async function seedDeploymentAccess(client: Queryable, report: ImportReport): Promise<void> {
  const users = (
    await client.query(
      `select u.email, coalesce(u.raw_app_meta_data ->> 'agency_admin', '') = 'true' as admin,
              exists (select 1 from public.memberships m where m.user_id = u.id and m.active and m.role in ('owner', 'editor')) as editor
         from auth.users u order by u.email`,
    )
  ).rows;
  for (const u of users) {
    const email = typeof u.email === "string" ? u.email.trim().toLowerCase() : "";
    if (email === "") {
      report.deploymentAccess.skipped.push({ email: null, reason: "no email" });
      continue;
    }
    const role = u.admin ? "admin" : u.editor ? "editor" : "viewer";
    const has = await client.query("select 1 from public.deployment_access where kind = 'email' and lower(value) = $1", [email]);
    if ((has.rowCount ?? 0) > 0) {
      report.deploymentAccess.existing.push(email);
      continue;
    }
    if (!EMAIL_RULE.test(email)) {
      report.deploymentAccess.skipped.push({ email, reason: "not an address deployment_access accepts" });
      continue;
    }
    await client.query("savepoint rule");
    try {
      await client.query("insert into public.deployment_access (kind, value, role, created_by) values ('email', $1, $2, null)", [email, role]);
      await client.query("release savepoint rule");
      report.deploymentAccess.added.push({ email, role });
    } catch (err) {
      await client.query("rollback to savepoint rule");
      if ((err as { code?: string }).code !== "23514") throw err;
      report.deploymentAccess.skipped.push({ email, reason: `refused by the table's check ${(err as { constraint?: string }).constraint ?? ""}`.trim() });
    }
  }
}

/** Every sequence owned by a public column goes to that column's maximum, so the next insert doesn't repeat a copied value. */
async function resetSequences(client: Queryable): Promise<Record<string, number>> {
  const { rows } = await client.query(
    `select s.relname as seq, t.relname as tbl, a.attname as col
       from pg_class s join pg_namespace sn on sn.oid = s.relnamespace
       join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
       join pg_class t on t.oid = d.refobjid join pg_namespace tn on tn.oid = t.relnamespace
       join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
      where s.relkind = 'S' and sn.nspname = 'public' and tn.nspname = 'public' order by 1`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) {
    const col = quoteIdent(r.col as string);
    const res = await client.query(
      `select setval(${quoteLiteral(qualified(`public.${r.seq as string}`))}, coalesce(max(${col}), 1), max(${col}) is not null)::text as v from ${qualified(`public.${r.tbl as string}`)}`,
    );
    out[`public.${r.seq as string}`] = Number(res.rows[0]!.v);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------------------

export function formatReport(report: ImportReport): string[] {
  const out: string[] = [];
  out.push(`${report.dryRun ? "DRY RUN (rolled back)" : "Imported"}; path: ${report.path} (${report.pathReason})`);
  const total = Object.values(report.tables).reduce((a, b) => a + b, 0);
  out.push(`Rows: ${total} in ${Object.keys(report.tables).length} tables`);
  for (const [t, cols] of Object.entries(report.droppedColumns)) out.push(`Dropped columns on ${t}: ${cols.join(", ")}`);
  if (report.deferredKeys.length > 0) out.push(`Keys loaded null, then updated: ${report.deferredKeys.join(", ")}`);
  if (report.path === "fallback") out.push(`User triggers were off on ${report.triggersDisabledOn.length} tables while loading, and are back on`);
  const b = report.betterAuth;
  out.push(`Better Auth: ${b.users} users, ${b.accounts} Google accounts`);
  for (const s of b.skippedUsers) out.push(`  SKIPPED user ${s.id} ${s.email ?? ""}: ${s.reason}`);
  for (const s of b.skippedAccounts) out.push(`  SKIPPED identity ${s.id} (${s.provider}): ${s.reason}`);
  for (const [p, n] of Object.entries(b.otherProviders)) out.push(`  ${n} ${p} identities have no Better Auth account (only Google is copied)`);
  const d = report.deploymentAccess;
  const byRole = (r: string) => d.added.filter((x) => x.role === r).length;
  out.push(`Deployment access: ${d.added.length} rules added (${byRole("admin")} admin, ${byRole("editor")} editor, ${byRole("viewer")} viewer), ${d.existing.length} already had one`);
  for (const s of d.skipped) out.push(`  SKIPPED rule for ${s.email ?? "a user"}: ${s.reason}`);
  const l = report.logos;
  out.push(`Logos: ${l.loaded.length} loaded`);
  for (const s of l.oversized) out.push(`  OVERSIZED logo for workspace ${s.workspaceId}: ${s.bytes} bytes (limit ${LOGO_MAX_BYTES}), ${s.path}`);
  for (const s of l.skipped) out.push(`  SKIPPED logo for workspace ${s.workspaceId} (${s.path}): ${s.reason}`);
  for (const [bucket, n] of Object.entries(report.storageNotCopied)) out.push(`Storage: ${n} object(s) in "${bucket}" not copied (see storage.json)`);
  for (const w of report.warnings) out.push(`WARNING ${w}`);
  return out;
}

async function main(): Promise<boolean> {
  const { values } = parseArgs({
    options: {
      in: { type: "string" },
      url: { type: "string" },
      driver: { type: "string" },
      "dry-run": { type: "boolean" },
      "no-replica": { type: "boolean" },
    },
    strict: true,
  });
  if (!values.in) usageError("Usage: import.ts --in <export dir> [--url <target postgres url>] [--driver pg|neon-ws] [--dry-run] [--no-replica]");
  const url = values.url ?? process.env.DATABASE_URL;
  if (!url) usageError("give --url <target postgres url> or set DATABASE_URL");
  const driver = (values.driver ?? "pg") as Driver;
  if (!DRIVERS.includes(driver)) usageError(`--driver must be one of ${DRIVERS.join(", ")}`);
  const { client, close } = await connectTarget(url, driver);
  try {
    const report = await runImport(client, {
      dir: values.in,
      dryRun: values["dry-run"] === true,
      forceFallback: values["no-replica"] === true,
      log: (line) => console.log(line),
    });
    for (const line of formatReport(report)) console.log(line);
    if (!report.dryRun) writePrivate(join(values.in, REPORT_FILE), JSON.stringify(report, null, 2));
    return true;
  } finally {
    await close();
  }
}

if (isMain(import.meta.url)) await runMain(main);

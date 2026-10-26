// Reads a Supabase database (at migration row 72) into a directory of JSON files, for import.ts (docs/plans/supabase-exit-brief.md,
// step 7a). Every query is a read-only select.
//   node --experimental-strip-types scripts/copy-from-supabase/export.ts --out <dir> (--supabase <project ref> | --url <postgres url>)
//       [--page-size 500] [--storage-ref <ref> | --storage-base <url>]
// --supabase reads through the Management API with SUPABASE_ACCESS_TOKEN (never printed) and downloads the public `branding` objects
// from the project's public storage URL. --url reads a Postgres database directly, in one read-only repeatable-read transaction
// (tests and rehearsals); it downloads branding objects only when --storage-ref or --storage-base says where they are.
import { parseArgs } from "node:util";
import { join } from "node:path";
import pg from "pg";
import {
  AUTH_COLUMNS,
  MANIFEST_FILE,
  STORAGE_FILE,
  assertReadOnlySelect,
  brandingFile,
  isMain,
  managementApiSource,
  prepareOutDir,
  qualified,
  quoteIdent,
  quoteLiteral,
  runMain,
  splitName,
  tableFile,
  tableName,
  usageError,
  writePrivate,
  type Manifest,
  type SqlSource,
  type StorageObject,
} from "./shared.ts";

export interface ExportOptions {
  out: string;
  source: SqlSource;
  sourceInfo: Manifest["source"];
  /** Rows per query at most. Default 500. */
  pageSize?: number;
  /** Fewer rows per query for a table whose widest row's text is big: about this many bytes a page. Default 4 MB. */
  pageBytes?: number;
  /** Where public `branding` objects can be fetched from (`<base>/branding/<name>`); without it nothing is downloaded. */
  storageBase?: string;
  log?: (line: string) => void;
}

export interface ExportResult {
  dir: string;
  manifest: Manifest;
  /** Anything that makes the export unusable as it stands (a table that changed while it was read, a failed branding download). */
  problems: string[];
}

/**
 * A read-only Postgres source: one repeatable-read transaction, so every page sees the same data. `row_security = off` makes a
 * query that row-level security would filter fail instead of quietly returning fewer rows (runExport also refuses such a role).
 */
export async function postgresSource(url: string): Promise<SqlSource> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("begin isolation level repeatable read read only");
  await client.query("set local row_security = off");
  return {
    async query(sql) {
      assertReadOnlySelect(sql);
      return (await client.query(sql)).rows;
    },
    async close() {
      await client.query("rollback").catch(() => {});
      await client.end();
    },
  };
}

const str = (v: unknown) => String(v);

export async function runExport(options: ExportOptions): Promise<ExportResult> {
  const { source } = options;
  const log = options.log ?? (() => {});
  const pageSize = options.pageSize ?? 500;
  const pageBytes = options.pageBytes ?? 4 * 1024 * 1024;
  const dir = prepareOutDir(options.out);
  const problems: string[] = [];

  const publicTables = (
    await source.query(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations' order by tablename",
    )
  ).map((r) => tableName("public", str(r.tablename)));
  const tables = [...publicTables, ...Object.keys(AUTH_COLUMNS)];

  // Row-level security would hide rows from a role that is subject to it, and the count would agree with what was read, so a
  // short export would look whole. Supabase's `postgres` (the Management API's role) bypasses it; anything else is refused.
  const storagePresent = (await source.query("select to_regclass('storage.objects')::text as t"))[0]!.t != null;
  const filtered: string[] = [];
  for (const name of [...tables, ...(storagePresent ? ["storage.objects"] : [])]) {
    const [{ a }] = (await source.query(`select row_security_active(${quoteLiteral(qualified(name))}::regclass) as a`)) as [{ a: unknown }];
    if (a === true || a === "t") filtered.push(name);
  }
  if (filtered.length > 0) {
    throw new Error(`row-level security applies to this role on ${filtered.join(", ")}, so rows could be missing; export as a role that bypasses it (Supabase's postgres)`);
  }
  // Writes counted per table from here to the end: a freeze that didn't hold shows up even when the row counts still agree
  // (an update, or an insert and a delete). Only the Management API source can see one: --url reads a single snapshot.
  const writesBefore = await writeCounters(source);

  const manifest: Manifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: options.sourceInfo,
    maxMigration: null,
    tables: {},
    storage: { objects: 0, brandingDownloaded: 0, brandingFailed: 0 },
  };

  for (const name of tables) {
    const [schema, table] = splitName(name);
    // From the catalog, not information_schema, which leaves out columns the role has no privilege on (`select *` would still
    // read them, and the import would then drop them as unlisted).
    const columns = (
      await source.query(
        `select a.attname as column_name from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${quoteLiteral(schema)} and c.relname = ${quoteLiteral(table)} and a.attnum > 0 and not a.attisdropped order by a.attnum`,
      )
    ).map((r) => str(r.column_name));
    const wanted = AUTH_COLUMNS[name];
    const selected = wanted ? wanted.filter((c) => columns.includes(c)) : columns;
    if (selected.length === 0) throw new Error(`${name} has no columns (does it exist?)`);

    // Pages in primary-key order; a table without one is ordered by every column, so pages never overlap.
    const pk = (
      await source.query(
        `select a.attname as col from pg_index i
           join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
           cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
           join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
          where i.indisprimary and n.nspname = ${quoteLiteral(schema)} and c.relname = ${quoteLiteral(table)}
          order by k.ord`,
      )
    ).map((r) => str(r.col));
    const orderBy = pk.length > 0 ? pk.map(quoteIdent).join(", ") : selected.map((c) => `${quoteIdent(c)}::text`).join(", ");
    const list = wanted ? selected.map(quoteIdent).join(", ") : "*";

    const [stats] = await source.query(
      `select count(*)::int as n, coalesce(max(octet_length(t::text)), 0)::bigint::text as widest from ${qualified(name)} t`,
    );
    const expected = Number(stats!.n);
    // Big rows (reports.pdf holds whole PDFs, as hex) come a few per page, so one answer stays near pageBytes of row text.
    const rowsPerPage = Math.max(1, Math.min(pageSize, Math.floor(pageBytes / Math.max(1, Number(stats!.widest)))));
    const parts: string[] = [];
    let read = 0;
    for (let offset = 0; offset < expected || offset === 0; offset += rowsPerPage) {
      const [page] = await source.query(
        `select count(*)::int as n, coalesce(json_agg(t), '[]'::json)::text as j
           from (select ${list} from ${qualified(name)} order by ${orderBy} limit ${rowsPerPage} offset ${offset}) t`,
      );
      const n = Number(page!.n);
      read += n;
      // The page's JSON text is kept as it came, so numbers keep every digit.
      if (n > 0) parts.push(str(page!.j).trim().slice(1, -1));
      if (n < rowsPerPage) break;
    }
    const text = `[${parts.join(",\n")}]`;
    const after = Number((await source.query(`select count(*)::int as n from ${qualified(name)}`))[0]!.n);
    if (read !== expected || after !== expected) {
      problems.push(`${name}: counted ${expected} rows, read ${read}, then counted ${after} (it changed while being exported)`);
    }
    if ((JSON.parse(text) as unknown[]).length !== read) throw new Error(`${name}: the exported JSON does not hold ${read} rows`);
    writePrivate(join(dir, tableFile(name)), text);
    manifest.tables[name] = { rows: read, columns: selected };
    log(`${name}: ${read} rows`);
  }

  // The highest migration the source has applied: Supabase's own log, or this repo's (a database made by scripts/migrate.ts).
  const logs = (
    await source.query(
      "select to_regclass('supabase_migrations.schema_migrations')::text as supabase, to_regclass('public.schema_migrations')::text as repo",
    )
  )[0]!;
  const logTable = logs.supabase ? "supabase_migrations.schema_migrations" : logs.repo ? "public.schema_migrations" : null;
  if (logTable) manifest.maxMigration = ((await source.query(`select max(version)::text as v from ${logTable}`))[0]!.v as string | null) ?? null;

  const objects = storagePresent ? await listStorage(source, pageSize) : [];
  manifest.storage.objects = objects.length;
  if (options.storageBase) {
    for (const o of objects.filter((x) => x.bucket === "branding")) {
      const failure = await download(options.storageBase, o, dir);
      if (failure) {
        o.error = failure;
        manifest.storage.brandingFailed++;
        problems.push(`branding/${o.name}: ${failure}`);
      } else manifest.storage.brandingDownloaded++;
    }
  }
  const writesAfter = await writeCounters(source);
  for (const name of [...tables, "storage.objects"]) {
    const before = writesBefore.get(name);
    const after = writesAfter.get(name);
    if (before !== undefined && after !== undefined && before !== after) {
      problems.push(`${name}: ${BigInt(after) - BigInt(before)} row write(s) while the export ran (Postgres counts a write up to a few seconds late); export again once nothing writes`);
    }
  }
  writePrivate(join(dir, STORAGE_FILE), JSON.stringify(objects, null, 2));
  writePrivate(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  log(`storage: ${objects.length} objects (${manifest.storage.brandingDownloaded} branding downloaded, ${manifest.storage.brandingFailed} failed)`);
  return { dir, manifest, problems };
}

/** Rows inserted, updated and deleted per table since the statistics were reset, as `schema.table` -> a decimal string. */
async function writeCounters(source: SqlSource): Promise<Map<string, string>> {
  const rows = await source.query(
    "select schemaname || '.' || relname as t, (n_tup_ins + n_tup_upd + n_tup_del)::text as w from pg_stat_all_tables where schemaname in ('public', 'auth', 'storage')",
  );
  return new Map(rows.map((r) => [str(r.t), str(r.w)]));
}

async function listStorage(source: SqlSource, pageSize: number): Promise<StorageObject[]> {
  const objects: StorageObject[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await source.query(
      `select bucket_id, name, (metadata ->> 'size') as size, (metadata ->> 'mimetype') as mime
         from storage.objects order by bucket_id, name limit ${pageSize} offset ${offset}`,
    );
    for (const r of rows) {
      objects.push({
        bucket: str(r.bucket_id),
        name: str(r.name),
        size: r.size == null ? null : Number(r.size),
        contentType: r.mime == null ? null : str(r.mime),
      });
    }
    if (rows.length < pageSize) return objects;
  }
}

/** Branding objects are public and are saved whole; anything bigger than this is not a logo and is left for import.ts to report. */
const MAX_DOWNLOAD = 5 * 1024 * 1024;

/** Saves one public object under the export directory; returns why it could not, or undefined. */
async function download(base: string, object: StorageObject, dir: string): Promise<string | undefined> {
  if (object.size !== null && object.size > MAX_DOWNLOAD) return `not downloaded: ${object.size} bytes is far over the logo limit`;
  const url = `${base.replace(/\/+$/, "")}/branding/${object.name.split("/").map(encodeURIComponent).join("/")}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return `download answered ${res.status}`;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD) return `not saved: ${bytes.length} bytes is far over the logo limit`;
    object.file = brandingFile(object.name);
    writePrivate(join(dir, object.file), bytes);
    object.size ??= bytes.length;
    return undefined;
  } catch (err) {
    return `download failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main(): Promise<boolean> {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      supabase: { type: "string" },
      url: { type: "string" },
      "page-size": { type: "string" },
      "storage-ref": { type: "string" },
      "storage-base": { type: "string" },
    },
    strict: true,
  });
  if (!values.out) usageError("Usage: export.ts --out <dir> (--supabase <project ref> | --url <postgres url>) [--page-size N] [--storage-ref <ref> | --storage-base <url>]");
  if (!values.supabase === !values.url) usageError("give exactly one of --supabase <ref> and --url <postgres url>");
  const pageSize = values["page-size"] === undefined ? 500 : Number(values["page-size"]);
  if (!Number.isInteger(pageSize) || pageSize < 1) usageError("--page-size must be a positive integer");
  const ref = values.supabase ?? values["storage-ref"];
  const storageBase = values["storage-base"] ?? (ref ? `https://${ref}.supabase.co/storage/v1/object/public` : undefined);
  const source = values.supabase
    ? managementApiSource({ ref: values.supabase, token: process.env.SUPABASE_ACCESS_TOKEN ?? "" })
    : await postgresSource(values.url!);
  try {
    const { dir, problems } = await runExport({
      out: values.out,
      source,
      sourceInfo: values.supabase ? { kind: "supabase", ref: values.supabase } : { kind: "url" },
      pageSize,
      storageBase,
      log: (line) => console.log(line),
    });
    console.log(`Exported to ${dir}`);
    for (const p of problems) console.error(`PROBLEM ${p}`);
    return problems.length === 0;
  } finally {
    await source.close();
  }
}

if (isMain(import.meta.url)) await runMain(main);

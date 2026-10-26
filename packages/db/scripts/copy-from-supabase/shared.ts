import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Code shared by export.ts, import.ts and verify.ts (docs/plans/supabase-exit-brief.md, step 7a). Only node built-ins and
// `pg` are used and only erasable TypeScript syntax, so the scripts run under `node --experimental-strip-types`.

/** The part of pg.Client used here. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** The migration the Supabase production database was at when the export was designed (brief: "row 72"). */
export const EXPECTED_SOURCE_VERSION = "20261227000000";
/** `workspace_logos_size`: 512 KB. */
export const LOGO_MAX_BYTES = 524_288;
export const LOGO_MIMES = ["image/png", "image/jpeg", "image/webp"];
export const MANIFEST_FILE = "manifest.json";
export const STORAGE_FILE = "storage.json";
export const REPORT_FILE = "import-report.json";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** A SQL string literal. Only for catalog-derived values and fixed text: anything from a user goes in as a parameter. */
export const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
/** `schema.table` as the export and its reports spell it. */
export const tableName = (schema: string, table: string) => `${schema}.${table}`;
export const splitName = (name: string): [string, string] => {
  const i = name.indexOf(".");
  return [name.slice(0, i), name.slice(i + 1)];
};
/** `"schema"."table"`. */
export const qualified = (name: string) => splitName(name).map(quoteIdent).join(".");
export const tableFile = (name: string) => `${name}.json`;
/** Where the exporter saves a `branding` object's bytes, relative to the export directory. One flat folder; `/` in the name is escaped. */
export const brandingFile = (objectName: string) => `branding/${encodeURIComponent(objectName)}`;

/** The columns exported from Supabase's own tables: this list, and not `select *`, so password hashes and tokens never leave it. */
export const AUTH_COLUMNS: Record<string, string[]> = {
  "auth.users": [
    "id",
    "email",
    "email_confirmed_at",
    "last_sign_in_at",
    "raw_app_meta_data",
    "raw_user_meta_data",
    "banned_until",
    "created_at",
    "updated_at",
  ],
  "auth.identities": ["id", "user_id", "provider", "provider_id", "identity_data", "last_sign_in_at", "created_at", "updated_at"],
};

// ---------------------------------------------------------------------------
// Manifest and storage listing
// ---------------------------------------------------------------------------

export interface Manifest {
  version: 1;
  exportedAt: string;
  source: { kind: "supabase" | "url"; ref?: string };
  /** The source's highest applied migration version, or null when it keeps no log. */
  maxMigration: string | null;
  tables: Record<string, { rows: number; columns: string[] }>;
  storage: { objects: number; brandingDownloaded: number; brandingFailed: number };
}

export interface StorageObject {
  bucket: string;
  name: string;
  size: number | null;
  contentType: string | null;
  /** Path of the downloaded bytes within the export directory (branding objects only). */
  file?: string;
  /** Why the bytes were not downloaded. */
  error?: string;
}

export function readManifest(dir: string): Manifest {
  return readJson<Manifest>(join(dir, MANIFEST_FILE));
}

export function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export function writePrivate(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** A new, empty export directory, owner-only (0700), and not inside the repository (exports hold real people's data). */
export function prepareOutDir(out: string): string {
  const dir = resolve(out);
  const repo = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
  const rel = relative(repo, dir);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep))) {
    throw new Error(`--out ${dir} is inside the repository; an export holds real data and must stay outside it`);
  }
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`--out ${dir} is not empty`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

// ---------------------------------------------------------------------------
// The read-only guard
// ---------------------------------------------------------------------------

const DENIED_WORDS =
  /\b(into|nextval|setval|set_config|pg_advisory\w*|pg_terminate_backend|pg_cancel_backend|pg_read_\w+|pg_ls_dir|pg_reload_conf|lo_\w+|dblink\w*|copy)\b/;
const LOCKING_CLAUSE = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/;

/**
 * Throws unless `sql` is one `select` statement. A guard against a bug in this tool, not a sandbox (Postgres is what keeps a
 * read-only role read-only): no comments, no dollar quoting, no backslashes or E'' strings, one statement, `select` first, and none of
 * `into`, a locking clause, or the functions that write or reach outside the database.
 */
export function assertReadOnlySelect(sql: string): void {
  let skeleton = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? "")) {
      throw new Error("refusing a query with an escape string (E'...')");
    }
    if (ch === "'" || ch === '"') {
      // Skip a literal or quoted identifier, in which `''` / `""` is an escaped quote.
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error("refusing a query with an unterminated quote");
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      skeleton += ch === "'" ? "''" : '""';
      i = j + 1;
      continue;
    }
    if (ch === "\\" || ch === "$") throw new Error(`refusing a query with ${ch === "$" ? "dollar quoting or a parameter" : "a backslash"}`);
    if ((ch === "-" && sql[i + 1] === "-") || (ch === "/" && sql[i + 1] === "*")) throw new Error("refusing a query with a comment");
    skeleton += ch;
    i++;
  }
  const body = skeleton.replace(/;\s*$/, "").trim().toLowerCase();
  if (body.includes(";")) throw new Error("refusing a query with more than one statement");
  if (!/^select\b/.test(body)) throw new Error("refusing a query that is not a select");
  const word = DENIED_WORDS.exec(body) ?? LOCKING_CLAUSE.exec(body);
  if (word) throw new Error(`refusing a select that uses "${word[0]}"`);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface SqlSource {
  query(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export interface ManagementApiOptions {
  ref: string;
  token: string;
  /** Default https://api.supabase.com; tests point it at a local server. */
  apiBase?: string;
  /** Pause before a retry, in ms (tests set it to 0). */
  retryDelayMs?: number;
}

/** Supabase's Management API: `POST /v1/projects/{ref}/database/query` with `{query}`, which answers with a JSON array of rows. */
export function managementApiSource(options: ManagementApiOptions): SqlSource {
  const { ref, token } = options;
  if (!/^[a-z0-9-]{1,40}$/.test(ref)) throw new Error("the project ref should be lower-case letters and digits");
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is not set");
  const url = `${(options.apiBase ?? "https://api.supabase.com").replace(/\/+$/, "")}/v1/projects/${ref}/database/query`;
  const delay = options.retryDelayMs ?? 2000;
  return {
    async query(sql) {
      assertReadOnlySelect(sql);
      for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ query: sql }),
          });
        } catch (err) {
          if (attempt < 4) {
            await sleep(delay * attempt);
            continue;
          }
          throw new Error(`Management API request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
        const text = await res.text();
        if (res.ok) {
          const rows: unknown = JSON.parse(text);
          if (!Array.isArray(rows)) throw new Error("Management API answered with something other than an array of rows");
          return rows as Record<string, unknown>[];
        }
        if ((res.status === 429 || res.status >= 500) && attempt < 4) {
          const wait = Number(res.headers.get("retry-after")) * 1000;
          await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 60_000) : delay * attempt);
          continue;
        }
        // The message goes to the console, so keep the body short and never echo the request.
        throw new Error(`Management API answered ${res.status}: ${text.slice(0, 300).replaceAll(token, "***")}`);
      }
    },
    async close() {},
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function usageError(message: string): never {
  const err = new Error(message);
  err.name = "UsageError";
  throw err;
}

/** Runs a script's `main` and turns its result into an exit code: 0, 1 for a failed check, 2 for a usage error. */
export async function runMain(main: () => Promise<boolean>): Promise<void> {
  try {
    process.exitCode = (await main()) ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = err instanceof Error && err.name === "UsageError" ? 2 : 1;
  }
}

export const isMain = (metaUrl: string) => process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href;

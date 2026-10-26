// Checks a target after import.ts (docs/plans/supabase-exit-brief.md, step 7a): the manifest's row counts, that every exported
// row is in the target with the same values (compared in SQL from the file's own text, so not through JavaScript), the Better Auth
// copies, the deployment-access rules, the logos, the sequences, that no trigger was left off, and that every foreign key
// resolves (a full anti-join per key: a constraint that was loaded unchecked is marked valid, so VALIDATE CONSTRAINT would skip it).
//   node --experimental-strip-types scripts/copy-from-supabase/verify.ts --in <dir> [--url <target postgres url>] [--driver pg|neon-ws]
// Exits 1 when anything is wrong. It only reads.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { migrationFiles } from "../../src/migrations.ts";
import { DRIVERS, connectTarget, type Driver } from "./connect.ts";
import type { ImportReport } from "./import.ts";
import { danglingSql, listForeignKeys } from "./foreign-keys.ts";
import { REPORT_FILE, isMain, qualified, quoteIdent, readJson, readManifest, runMain, tableFile, usageError, type Queryable } from "./shared.ts";

export interface VerifyLine {
  status: "ok" | "FAIL" | "info";
  text: string;
}

export interface VerifyResult {
  ok: boolean;
  lines: VerifyLine[];
}

/** Tables the import adds rows to beyond the export, so the target may hold more than the manifest says. */
const ADDED_TABLES = new Set(["public.workspace_logos", "public.deployment_access"]);
const EMAIL_RULE = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";

export async function runVerify(client: Queryable, dir: string): Promise<VerifyResult> {
  const manifest = readManifest(dir);
  const reportPath = join(dir, REPORT_FILE);
  const report = existsSync(reportPath) ? readJson<ImportReport>(reportPath) : null;
  const lines: VerifyLine[] = [];
  const check = (ok: boolean, text: string) => lines.push({ status: ok ? "ok" : "FAIL", text });
  const info = (text: string) => lines.push({ status: "info", text });
  const one = async (sql: string, params: unknown[] = []) => Number((await client.query(sql, params)).rows[0]!.n);
  info(report ? `using ${REPORT_FILE} from the import (${report.path} path) to allow for what it skipped` : `no ${REPORT_FILE}: nothing is allowed for skipped items`);

  // Head
  const applied = new Set((await client.query("select version from public.schema_migrations")).rows.map((r) => r.version as string));
  const pending = migrationFiles().filter((f) => !applied.has(f.split("_")[0]!));
  check(pending.length === 0, pending.length === 0 ? "target is at the current head" : `target has ${pending.length} migration(s) pending`);

  // Row counts
  for (const [name, { rows }] of Object.entries(manifest.tables)) {
    // Rules added to deployment_access through the app (before or after the copy) are audited; the export has none of those rows.
    const where = name === "public.audit_log" ? " where target_table <> 'deployment_access'" : "";
    const n = await one(`select count(*)::int as n from ${qualified(name)}${where}`);
    const exact = !ADDED_TABLES.has(name);
    check(exact ? n === rows : n >= rows, `${name}: ${n} rows, export had ${rows}${exact ? "" : " (import may add more)"}`);
  }

  // Content: every exported row, read into the target's row type from the file's own text, has an identical row in the target
  // (compared as the row's text, so 1.50 and 1.5 differ). Columns the target lacks are left out (the import drops them), and so
  // are those it generates; workspaces.branding is compared without logo_path, which the import moves to workspace_logos.
  const targetColumns = await comparableColumns(client);
  for (const [name, { rows, columns }] of Object.entries(manifest.tables)) {
    if (rows === 0) continue;
    const have = targetColumns.get(name) ?? new Set<string>();
    const cols = columns.filter((c) => have.has(c));
    const expr = (alias: string, side: "file" | "target") =>
      `row(${cols.map((c) => (side === "file" && name === "public.workspaces" && c === "branding" ? `${alias}."branding" - 'logo_path'` : `${alias}.${quoteIdent(c)}`)).join(", ")})::text`;
    const missing = await one(
      `select count(*)::int as n from (
         select ${expr("f", "file")} from json_populate_recordset(null::${qualified(name)}, $1::json) f
         except all
         select ${expr("t", "target")} from ${qualified(name)} t) x`,
      [readFileSync(join(dir, tableFile(name)), "utf8")],
    );
    check(missing === 0, `${name}: ${missing === 0 ? "every exported row is in the target unchanged" : `${missing} exported row(s) are missing or differ`} (${cols.length} columns compared)`);
  }

  // Better Auth
  const wantUsers = await one(`select count(distinct lower(btrim(email)))::int as n from auth.users where nullif(btrim(email), '') is not null`);
  const users = await one(`select count(*)::int as n from better_auth."user"`);
  check(users === wantUsers, `better_auth.user: ${users} users, ${wantUsers} auth.users have a distinct email`);
  if (report) check(users === report.betterAuth.users, `better_auth.user matches the ${report.betterAuth.users} the import reported`);
  const orphanUsers = await one(
    `select count(*)::int as n from better_auth."user" b where not exists (select 1 from auth.users u where u.id = b.id and lower(btrim(u.email)) = b.email)`,
  );
  check(orphanUsers === 0, `${orphanUsers} Better Auth users differ from their auth.users row (id or email)`);
  const unverified = await one(
    `select count(*)::int as n from better_auth."user" b join auth.users u on u.id = b.id where b."emailVerified" is distinct from (u.email_confirmed_at is not null)`,
  );
  check(unverified === 0, `${unverified} Better Auth users disagree with auth.users about emailVerified`);
  const wantAccounts = await one(
    `select count(*)::int as n from auth.identities i where i.provider = 'google' and exists (select 1 from better_auth."user" b where b.id = i.user_id)`,
  );
  const accounts = await one(`select count(*)::int as n from better_auth.account`);
  check(accounts === wantAccounts, `better_auth.account: ${accounts} accounts, ${wantAccounts} Google identities belong to a Better Auth user`);
  const badAccounts = await one(
    `select count(*)::int as n from better_auth.account a where a."providerId" <> 'google' or not exists (
       select 1 from auth.identities i where i.provider = 'google' and i.provider_id = a."accountId" and i.user_id = a."userId")`,
  );
  check(badAccounts === 0, `${badAccounts} Better Auth accounts do not match a Google identity (accountId, userId)`);

  // Deployment access
  const noRule = await one(
    `select count(*)::int as n from auth.users u where lower(btrim(u.email)) ~ $1
       and not exists (select 1 from public.deployment_access d where d.kind = 'email' and lower(d.value) = lower(btrim(u.email)))`,
    [EMAIL_RULE],
  );
  check(noRule === 0, `${noRule} users with an email have no named-email deployment_access rule`);
  const rules = await one(`select count(*)::int as n from public.deployment_access`);
  if (report) {
    const want = report.deploymentAccess.added.length + report.deploymentAccess.existing.length;
    check(rules >= want, `deployment_access: ${rules} rules, import added ${report.deploymentAccess.added.length} and found ${report.deploymentAccess.existing.length}`);
  } else info(`deployment_access: ${rules} rules`);

  // Logos
  const logos = await one(`select count(*)::int as n from public.workspace_logos`);
  const badLogos = await one(
    `select count(*)::int as n from public.workspace_logos where sha256 <> encode(pg_catalog.sha256(bytes), 'hex') or octet_length(bytes) > 524288`,
  );
  check(badLogos === 0, `${badLogos} logos whose hash or size is wrong`);
  if (report) check(logos === report.logos.loaded.length, `workspace_logos: ${logos} rows, import loaded ${report.logos.loaded.length}`);
  else info(`workspace_logos: ${logos} rows`);

  // Sequences
  const seqs = (
    await client.query(
      `select s.relname as seq, t.relname as tbl, a.attname as col
         from pg_class s join pg_namespace sn on sn.oid = s.relnamespace
         join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
         join pg_class t on t.oid = d.refobjid join pg_namespace tn on tn.oid = t.relnamespace
         join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
        where s.relkind = 'S' and sn.nspname = 'public' and tn.nspname = 'public' order by 1`,
    )
  ).rows;
  for (const s of seqs) {
    const max = (await client.query(`select max(${quoteIdent(s.col as string)})::text as m from ${qualified(`public.${s.tbl as string}`)}`)).rows[0]!.m as string | null;
    const last = (await client.query(`select last_value::text as v, is_called from ${qualified(`public.${s.seq as string}`)}`)).rows[0]!;
    const fine = max === null || (last.is_called as boolean && BigInt(last.v as string) >= BigInt(max));
    check(fine, `sequence ${s.seq as string}: at ${last.v as string}, ${s.tbl as string}.${s.col as string} max is ${max ?? "(empty)"}`);
  }

  // Triggers
  const off = await one(
    `select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and t.tgenabled <> 'O' and n.nspname in ('public', 'auth', 'better_auth')`,
  );
  check(off === 0, `${off} user trigger(s) are not enabled`);

  // Foreign keys
  const notValid = (
    await client.query(
      `select c.conrelid::regclass::text || '.' || c.conname as name from pg_constraint c
        where not c.convalidated and c.contype = 'f' and c.connamespace in ('public'::regnamespace, 'auth'::regnamespace, 'better_auth'::regnamespace)`,
    )
  ).rows;
  check(notValid.length === 0, notValid.length === 0 ? "every constraint is validated" : `NOT VALID constraints: ${notValid.map((r) => r.name as string).join(", ")}`);
  const fks = await listForeignKeys(client);
  let broken = 0;
  for (const fk of fks) {
    const n = Number((await client.query(danglingSql(fk))).rows[0]!.n);
    if (n > 0) {
      broken++;
      check(false, `${fk.child}.${fk.name}: ${n} row(s) reference a missing ${fk.parent}`);
    }
  }
  check(broken === 0, `${fks.length} foreign keys checked by anti-join, ${broken} broken`);

  return { ok: lines.every((l) => l.status !== "FAIL"), lines };
}

/** The target's stored (not generated) columns per `schema.table`. */
async function comparableColumns(client: Queryable): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query(
    `select n.nspname || '.' || c.relname as t, a.attname as col
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and n.nspname in ('public', 'auth', 'better_auth')`,
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.t as string)) out.set(r.t as string, new Set());
    out.get(r.t as string)!.add(r.col as string);
  }
  return out;
}

async function main(): Promise<boolean> {
  const { values } = parseArgs({ options: { in: { type: "string" }, url: { type: "string" }, driver: { type: "string" } }, strict: true });
  if (!values.in) usageError("Usage: verify.ts --in <export dir> [--url <target postgres url>] [--driver pg|neon-ws]");
  const url = values.url ?? process.env.DATABASE_URL;
  if (!url) usageError("give --url <target postgres url> or set DATABASE_URL");
  const driver = (values.driver ?? "pg") as Driver;
  if (!DRIVERS.includes(driver)) usageError(`--driver must be one of ${DRIVERS.join(", ")}`);
  const { client, close } = await connectTarget(url, driver);
  try {
    await client.query("begin read only");
    const { ok, lines } = await runVerify(client, values.in);
    for (const l of lines) console.log(`${l.status.padEnd(4)} ${l.text}`);
    console.log(ok ? "VERIFIED" : `VERIFY FAILED (${lines.filter((l) => l.status === "FAIL").length} problem(s))`);
    return ok;
  } finally {
    await client.query("rollback").catch(() => {});
    await close();
  }
}

if (isMain(import.meta.url)) await runMain(main);

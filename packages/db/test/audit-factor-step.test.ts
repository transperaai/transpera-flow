import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamLeadSourceIds, northbeamPersonIds, northbeamRoleIds, northbeamServiceIds, northbeamClientIds, northbeamStepIds } from "../src";
import { headerRollback } from "./header-rollback";
import { createTestDb, createUser, type TestDb } from "./harness";

// The change log names the step of a per-person time (issue #230, migration 20261225000000_audit_factor_step.sql): the audit diff
// of a `person_capacity_factors` row carries `step_id` or `every_step: true`, nothing else in any other table's diff moved, and the
// replaced function is the old one plus the two marked lines, with a header rollback that puts the old one back.

const FILE = "20261225000000_audit_factor_step.sql";
const OLD_FILE = "20261015000000_suggestions.sql";
const OLD_MD5 = "e936352b8a20cdd8fd374756e4fa4439";
const ws = NORTHBEAM_WORKSPACE_ID;
const person = northbeamPersonIds["Rosa Diaz"]!;
const sam = northbeamPersonIds["Sam Patel"]!;
const STEP = northbeamStepIds.audit;

const migrationSql = (file: string) => readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
/** What `pg_proc.prosrc` holds for `private.audit_company_write`: the text between the `$$` marks of the one live definition. */
const bodyOf = (sql: string) => {
  const start = sql.search(/^create (?:or replace )?function private\.audit_company_write\(\)/m);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("$$", sql.indexOf("as $$", start));
  return sql.slice(open + 2, sql.indexOf("$$", open + 2));
};

type AuditDiff = { step_id?: string; every_step?: boolean; old?: Record<string, unknown>; new?: Record<string, unknown> };
let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let owner: { id: string; claims: Record<string, unknown> };

beforeAll(async () => {
  db = await createTestDb();
  editor = await createUser(db, "afs-editor@example.com");
  owner = await createUser(db, "afs-owner@example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'owner')", [ws, editor.id, owner.id]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

/** The audit rows of the transaction so far for one table, read as the superuser (only managers read the log), then back as the caller. */
async function auditDiffs(c: pg.Client, table: string): Promise<{ action: string; diff: AuditDiff }[]> {
  await c.query("reset role");
  try {
    return (await c.query("select action, diff from audit_log where target_table = $1 and created_at = now() order by action", [table])).rows;
  } finally {
    await c.query("set local role authenticated");
  }
}

const save = (c: pg.Client, step: string | null, base: number | null, value: number | null) =>
  c.query("select public.save_capacity_factor($1, $2, $3, $4) as r", [person, step, base, value]);

describe("a per-person time's log entry names its step", () => {
  it("a step's time: insert, update and delete each carry step_id (the row's step) and never every_step", async () => {
    await db.as(editor.claims, async (c) => {
      await save(c, STEP, null, 0.8);
      await save(c, STEP, 0.8, 0.9);
      await save(c, STEP, 0.9, null);
      const rows = await auditDiffs(c, "person_capacity_factors");
      expect(rows.map((r) => r.action)).toEqual(["delete", "insert", "update"]);
      for (const r of rows) {
        expect(r.diff.step_id, r.action).toBe(STEP);
        expect(r.diff, r.action).not.toHaveProperty("every_step");
      }
      // The update changed only the factor yet names the step: it is read from the whole row.
      const update = rows.find((r) => r.action === "update")!;
      expect(update.diff.new).not.toHaveProperty("step_id");
      expect(update.diff.new!.factor).toBe(0.9);
      expect(update.diff.old!.factor).toBe(0.8);
    });
  });

  it("a person's time for every step: insert, update and delete each carry every_step: true and no step_id anywhere", async () => {
    await db.as(editor.claims, async (c) => {
      await save(c, null, null, 1.2);
      await save(c, null, 1.2, 1.3);
      await save(c, null, 1.3, null);
      const rows = await auditDiffs(c, "person_capacity_factors");
      expect(rows.map((r) => r.action)).toEqual(["delete", "insert", "update"]);
      for (const r of rows) {
        expect(r.diff.every_step, r.action).toBe(true);
        expect(r.diff, r.action).not.toHaveProperty("step_id");
        expect(r.diff.new ?? {}, r.action).not.toHaveProperty("step_id");
        expect(r.diff.old ?? {}, r.action).not.toHaveProperty("step_id");
      }
    });
  });

  it("an owner's write is logged the same way, and the target is still the person", async () => {
    await db.as(owner.claims, async (c) => {
      await save(c, STEP, null, 1.1);
      await c.query("reset role");
      const row = (await c.query("select target_id, diff from audit_log where target_table = 'person_capacity_factors' and created_at = now()")).rows[0];
      expect(row.target_id).toBe(person);
      expect(row.diff.step_id).toBe(STEP);
    });
  });
});

describe("nothing else moved: every other audited table keeps exactly today's diff keys", () => {
  const diffOf = async (c: pg.Client, table: string) => {
    const rows = await auditDiffs(c, table);
    expect(rows).toHaveLength(1);
    return rows[0]!.diff;
  };

  it("a person's FTE (people)", async () => {
    await db.as(editor.claims, async (c) => {
      await c.query("update people set fte = 0.6 where id = $1", [sam]);
      expect(await diffOf(c, "people")).toEqual({ old: expect.objectContaining({ fte: 1 }), new: expect.objectContaining({ fte: 0.6 }) });
    });
  });

  it("a role's name (roles)", async () => {
    await db.as(editor.claims, async (c) => {
      await c.query("update roles set name = 'Renamed' where id = $1", [northbeamRoleIds.seo]);
      expect(await diffOf(c, "roles")).toEqual({ old: expect.objectContaining({ name: expect.any(String) }), new: expect.objectContaining({ name: "Renamed" }) });
    });
  });

  it("a skill added (person_skills) still has step_id", async () => {
    await db.as(editor.claims, async (c) => {
      await c.query("insert into person_skills (person_id, step_id, workspace_id) values ($1, $2, $3)", [sam, STEP, ws]);
      const diff = await diffOf(c, "person_skills");
      expect(diff).toEqual({ new: expect.objectContaining({ person_id: sam, step_id: STEP }), step_id: STEP });
      expect(diff).not.toHaveProperty("every_step");
    });
  });

  it("a role given (person_roles) has role_id and nothing new", async () => {
    await db.as(editor.claims, async (c) => {
      await c.query("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [sam, northbeamRoleIds.ppc, ws]);
      expect(await diffOf(c, "person_roles")).toEqual({ new: expect.objectContaining({ person_id: sam, role_id: northbeamRoleIds.ppc }), role_id: northbeamRoleIds.ppc });
    });
  });

  it("a service added to a client (client_services) has service_id and nothing new", async () => {
    await db.as(editor.claims, async (c) => {
      await c.query("insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [northbeamClientIds.c01, northbeamServiceIds.ppc, ws]);
      expect(await diffOf(c, "client_services")).toEqual({
        new: expect.objectContaining({ client_id: northbeamClientIds.c01, service_id: northbeamServiceIds.ppc }),
        service_id: northbeamServiceIds.ppc,
      });
    });
  });

  it("a lead source's volume (lead_sources)", async () => {
    await db.as(editor.claims, async (c) => {
      await c.query("update lead_sources set volume_week = 15 where id = $1", [northbeamLeadSourceIds.ads]);
      expect(await diffOf(c, "lead_sources")).toEqual({ old: expect.objectContaining({ volume_week: 4 }), new: expect.objectContaining({ volume_week: 15 }) });
    });
  });

  it("a workspace setting saved with save_fields (workspaces)", async () => {
    await db.as(owner.claims, async (c) => {
      await c.query("select public.save_fields('workspaces', $1, $2, $3)", [
        JSON.stringify({ id: ws }),
        JSON.stringify({ "settings.overtime_cap": 0.1 }),
        JSON.stringify({ "settings.overtime_cap": 0.2 }),
      ]);
      const diff = await diffOf(c, "workspaces");
      expect(diff).toEqual({ old: expect.any(Object), new: expect.objectContaining({ settings: expect.objectContaining({ overtime_cap: 0.2 }) }) });
    });
  });

  it("the function is still called by 18 enabled triggers", async () => {
    const rows = (
      await db.client.query(
        "select c.relname, t.tgenabled::text as enabled from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgfoid = 'private.audit_company_write()'::regprocedure and not t.tgisinternal order by 1",
      )
    ).rows;
    expect(rows).toHaveLength(18);
    expect(new Set(rows.map((r) => r.enabled))).toEqual(new Set(["O"]));
  });
});

describe("the function and the migration", () => {
  it("is SECURITY DEFINER with an empty search_path, and neither anon nor authenticated can execute it", async () => {
    const [fn] = (await db.client.query("select prosecdef, proconfig from pg_proc where oid = 'private.audit_company_write()'::regprocedure")).rows;
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(['search_path=""']);
    const [priv] = (
      await db.client.query(
        "select has_function_privilege('anon', 'private.audit_company_write()', 'execute') a, has_function_privilege('authenticated', 'private.audit_company_write()', 'execute') b",
      )
    ).rows;
    expect(priv).toEqual({ a: false, b: false });
  });

  it("the live body's md5 is the migration's, and the header says so (and says the old md5 twice)", async () => {
    const sql = migrationSql(FILE);
    const live = (await db.client.query("select md5(prosrc) as m from pg_proc where oid = 'private.audit_company_write()'::regprocedure")).rows[0].m;
    expect(live).toBe(md5(bodyOf(sql)));
    const stated = /the new md5, ([0-9a-f]{32}):/.exec(sql)![1];
    expect(stated).toBe(live);
    expect(live).not.toBe(OLD_MD5);
    expect(sql.split(OLD_MD5).length - 1).toBeGreaterThanOrEqual(3);
    expect(sql).toContain("Expect 18 rows");
  });

  it("differs from the old body only by the two marked lines (and the comment above them)", () => {
    const old = bodyOf(migrationSql(OLD_FILE));
    expect(md5(old)).toBe(OLD_MD5);
    const next = bodyOf(migrationSql(FILE));
    const changed = next.split("\n");
    const at = changed.findIndex((l) => l.includes("-- #230"));
    expect(at).toBeGreaterThan(0);
    // The marked block: two comment lines, the widened step_id line, the every_step line.
    expect(changed.slice(at, at + 4).map((l) => l.trim().slice(0, 8))).toEqual(["-- #230:", "-- jsonb", "'step_id", "'every_s"]);
    const restored = [...changed.slice(0, at), "      'step_id', case when tg_table_name = 'person_skills' then target -> 'step_id' end,", ...changed.slice(at + 4)].join("\n");
    expect(restored).toBe(old);
    expect(changed.filter((l) => l.includes("#230")).length).toBe(1);
  });

  it("the header's rollback, run as written, puts the old body back and a factor's update logs no step_id again", async () => {
    const sql = headerRollback(FILE);
    expect(sql).toMatch(/^begin;/);
    expect(sql).toMatch(/commit;$/);
    const inner = sql.replace(/^begin;\n/, "").replace(/\ncommit;$/, "");
    const c = db.client;
    await c.query("begin");
    try {
      await c.query("create schema if not exists supabase_migrations");
      await c.query("create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[])");
      await c.query("insert into supabase_migrations.schema_migrations (version, name) values ('20261225000000', 'audit_factor_step') on conflict do nothing");
      await c.query(inner);
      expect((await c.query("select md5(prosrc) as m, prosecdef, proconfig from pg_proc where oid = 'private.audit_company_write()'::regprocedure")).rows).toEqual([
        { m: OLD_MD5, prosecdef: true, proconfig: ['search_path=""'] },
      ]);
      expect((await c.query("select version from supabase_migrations.schema_migrations where version = '20261225000000'")).rows).toEqual([]);
      expect((await c.query("select has_function_privilege('anon', 'private.audit_company_write()', 'execute') a, has_function_privilege('authenticated', 'private.audit_company_write()', 'execute') b")).rows).toEqual([{ a: false, b: false }]);
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(editor.claims)]);
      await save(c, STEP, null, 0.8);
      await save(c, STEP, 0.8, 0.9);
      const rows = await auditDiffs(c, "person_capacity_factors");
      expect(rows.map((r) => r.action)).toEqual(["insert", "update"]);
      // Today's (old) behaviour: the update's diff holds only the changed columns, no step; the insert has it only inside `new`.
      expect(rows.find((r) => r.action === "update")!.diff).not.toHaveProperty("step_id");
      expect(rows.find((r) => r.action === "update")!.diff).not.toHaveProperty("every_step");
      expect(rows.find((r) => r.action === "insert")!.diff).not.toHaveProperty("step_id");
      expect(rows.find((r) => r.action === "insert")!.diff.new!.step_id).toBe(STEP);
    } finally {
      await c.query("rollback");
    }
    // Rolled back: the new function is live again.
    expect((await c.query("select md5(prosrc) as m from pg_proc where oid = 'private.audit_company_write()'::regprocedure")).rows[0].m).toBe(md5(bodyOf(migrationSql(FILE))));
  });

  it("the migration is one statement and its revoke, and the apply file is the migration plus its row, in one transaction", () => {
    const sql = migrationSql(FILE);
    const code = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n");
    expect((code.match(/^create or replace function /gm) ?? []).length).toBe(1);
    expect((code.match(/^revoke all on function private\.audit_company_write\(\) from public, anon, authenticated;$/gm) ?? []).length).toBe(1);
    expect(code).not.toMatch(/^(create table|alter table|drop|insert|create trigger|grant)/m);
    const apply = readFileSync(new URL(`../scripts/apply/${FILE}`, import.meta.url), "utf8");
    const mig = sql.trimEnd();
    expect(apply).toContain("\nbegin;\nset local lock_timeout = '5s';\n");
    expect(apply.split(mig).length - 1).toBe(2);
    expect(apply).toContain(`insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261225000000', 'audit_factor_step', array[$mig$${mig}\n$mig$]);`);
    expect(apply.trimEnd().endsWith("$mig$]);\n\ncommit;")).toBe(true);
  });
});

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamPersonIds, northbeamRoleIds, northbeamStepIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";
import { headerRollback } from "./header-rollback";

// Deleting a workspace takes everything in it (bug found while scoping B21: every workspace delete failed on
// `steps_role_id_workspace_id_fkey`). Migration 20261220500000_workspace_delete_cascade.

let db: TestDb;
const ws = NORTHBEAM_WORKSPACE_ID;
const sam = northbeamPersonIds["Sam Patel"]!;
const MIGRATION = "20261220500000_workspace_delete_cascade.sql";

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

/**
 * Every public table with a `workspace_id` column, and how many of its rows belong to `workspace`. `audit_log` is left out: it
 * is history, has no foreign key, and keeps its entries (including the delete's own) after the workspace goes.
 */
async function leftovers(c: pg.Client, workspace: string) {
  const tables = (
    await c.query(
      `select c.table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
       where c.table_schema = 'public' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE' and c.table_name <> 'audit_log' order by 1`,
    )
  ).rows.map((r) => r.table_name as string);
  expect(tables.length).toBeGreaterThan(40);
  const out: Record<string, number> = {};
  for (const t of tables) {
    const n = (await c.query(`select count(*)::int as n from public.${t} where workspace_id = $1`, [workspace])).rows[0].n as number;
    if (n > 0) out[t] = n;
  }
  return out;
}

/** Fill Northbeam with a row for every composite foreign key that pointed at a sibling table without a cascade. */
async function fillTheGaps(c: pg.Client) {
  // A step with a person (steps.role_id is already set on most seeded steps).
  await c.query("update steps set person_id = $1 where workspace_id = $2 and id = $3", [sam, ws, northbeamStepIds.discovery]);
  // A market condition on the schedule.
  await c.query(
    "insert into market_schedule (workspace_id, from_month, to_month, condition_id) select $1, 1, 3, id from market_conditions where workspace_id = $1 limit 1",
    [ws],
  );
  // A solution on the published version.
  await c.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'S', '{\"steps\":[],\"edges\":[]}')", [
    ws,
    NORTHBEAM_PROCESS_ID,
    NORTHBEAM_REVISION_ID,
  ]);
  // An issue naming a role and a person.
  await c.query("insert into issues (workspace_id, type, severity, title, role_id, person_id) values ($1, 'delay', 'info', 'Slow audits', $2, $3)", [ws, northbeamRoleIds.seo, sam]);
}

describe("deleting a workspace", () => {
  it("works as an agency admin, and cascades everything away", async () => {
    const admin = await createUser(db, "agency@workspace-delete.example.com", { agency_admin: true });
    await fillTheGaps(db.client);
    const before = await leftovers(db.client, ws);
    expect(before.steps).toBeGreaterThan(0);
    expect(before.roles).toBeGreaterThan(0);
    expect(before.people).toBeGreaterThan(0);
    expect(before.processes).toBeGreaterThan(0);
    expect(before.market_schedule).toBe(1);
    expect(before.solutions).toBe(1);
    expect((await db.client.query("select count(*)::int as n from steps where workspace_id = $1 and role_id is not null", [ws])).rows[0].n).toBeGreaterThan(0);

    await db.as(admin.claims, async (c) => {
      expect((await c.query("delete from workspaces where id = $1", [ws])).rowCount).toBe(1);
      // Run the deferred checks now: the transaction is rolled back, which would skip them.
      await c.query("set constraints all immediate");
      await c.query("reset role");
      expect(await leftovers(c, ws)).toEqual({});
    });
  });

  it("works as a superuser, committed, and leaves no row behind", async () => {
    const other = (await db.client.query("select id from workspaces where slug = 'larkspur'")).rows[0].id as string;
    expect((await db.client.query("select count(*)::int as n from steps where workspace_id = $1 and role_id is not null and person_id is not null", [other])).rows[0].n).toBeGreaterThan(0);
    expect((await db.client.query("delete from workspaces where id = $1", [other])).rowCount).toBe(1);
    expect(await leftovers(db.client, other)).toEqual({});
    // Northbeam is untouched.
    expect((await db.client.query("select count(*)::int as n from steps where workspace_id = $1", [ws])).rows[0].n).toBeGreaterThan(0);
  });
});

/** Run `fn` in a transaction as the superuser, and roll it back. */
async function rolledBack(fn: (c: pg.Client) => Promise<void>) {
  await db.client.query("begin");
  try {
    await fn(db.client);
  } finally {
    await db.client.query("rollback");
  }
}

const stepsNaming = async (c: pg.Client, column: "role_id" | "person_id", id: string) =>
  (await c.query(`select count(*)::int as n from steps where ${column} = $1`, [id])).rows[0].n as number;

describe("deleting one role or person keeps its guards", () => {
  it("an unused role is deleted", async () => {
    await rolledBack(async (c) => {
      const id = (await c.query("insert into roles (workspace_id, name) values ($1, 'Spare') returning id", [ws])).rows[0].id;
      expect((await c.query("delete from roles where id = $1", [id])).rowCount).toBe(1);
      await c.query("set constraints all immediate");
    });
  });

  it("a role a step uses is refused at once by the in_use trigger, and the step keeps it", async () => {
    const role = northbeamRoleIds.seo;
    const before = await stepsNaming(db.client, "role_id", role);
    expect(before).toBeGreaterThan(0);
    await expect(db.client.query("delete from roles where id = $1", [role])).rejects.toMatchObject({ code: "23503", message: expect.stringMatching(/still used by steps/) });
    expect(await stepsNaming(db.client, "role_id", role)).toBe(before);
  });

  it("with in_use bypassed, the foreign key still refuses a role a step uses (at commit)", async () => {
    await rolledBack(async (c) => {
      await c.query("alter table roles disable trigger in_use");
      expect((await c.query("delete from roles where id = $1", [northbeamRoleIds.seo])).rowCount).toBe(1);
      await expect(c.query("set constraints all immediate")).rejects.toMatchObject({ code: "23503", constraint: "steps_role_id_workspace_id_fkey" });
    });
  });

  it("a person a step names is still refused, at commit, and the step keeps them", async () => {
    expect(await stepsNaming(db.client, "person_id", sam)).toBe(1);
    await expect(db.client.query("delete from people where id = $1", [sam])).rejects.toMatchObject({ code: "23503", constraint: "steps_person_id_workspace_id_fkey" });
    expect((await db.client.query("select count(*)::int as n from people where id = $1", [sam])).rows[0].n).toBe(1);
    expect(await stepsNaming(db.client, "person_id", sam)).toBe(1);
  });

  it("the two constraints are deferred, still NO ACTION and validated; the other two NO ACTION ones stay immediate", async () => {
    const rows = (
      await db.client.query(
        `select conname, confdeltype, condeferrable, condeferred, convalidated from pg_constraint
         where contype = 'f' and confdeltype in ('a', 'r') and connamespace = 'public'::regnamespace order by 1`,
      )
    ).rows;
    expect(rows).toEqual([
      { conname: "market_schedule_condition_id_workspace_id_fkey", confdeltype: "a", condeferrable: false, condeferred: false, convalidated: true },
      { conname: "solutions_base_revision_id_process_id_workspace_id_fkey", confdeltype: "a", condeferrable: false, condeferred: false, convalidated: true },
      { conname: "steps_person_id_workspace_id_fkey", confdeltype: "a", condeferrable: true, condeferred: true, convalidated: true },
      { conname: "steps_role_id_workspace_id_fkey", confdeltype: "a", condeferrable: true, condeferred: true, convalidated: true },
    ]);
  });
});

describe("the header", () => {
  it("rolls back: both constraints immediate again, and the workspace delete fails as before", async () => {
    // The ledger line needs Supabase's schema_migrations, which the plain database doesn't have.
    const sql = headerRollback(MIGRATION)
      .replace(/^begin;$/m, "")
      .replace(/^commit;$/m, "")
      .replace("delete from supabase_migrations.schema_migrations where version = '20261220500000';", "");
    await rolledBack(async (c) => {
      await c.query(sql);
      const flags = (
        await c.query(
          "select bool_or(condeferrable) as d from pg_constraint where conname in ('steps_role_id_workspace_id_fkey', 'steps_person_id_workspace_id_fkey')",
        )
      ).rows[0].d;
      expect(flags).toBe(false);
      await expect(c.query("delete from workspaces where id = $1", [ws])).rejects.toMatchObject({ code: "23503" });
    });
  });
});

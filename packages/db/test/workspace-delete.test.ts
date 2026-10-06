import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamPersonIds, northbeamRoleIds, northbeamStepIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Deleting a workspace takes everything in it (bug found while scoping B21: every workspace delete failed on
// `steps_role_id_workspace_id_fkey`). Migration 20261222000000_workspace_delete_cascade.

let db: TestDb;
const ws = NORTHBEAM_WORKSPACE_ID;
const sam = northbeamPersonIds["Sam Patel"]!;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

/** Every public table with a `workspace_id` column, and how many of its rows belong to `workspace`. */
async function leftovers(c: pg.Client, workspace: string) {
  const tables = (
    await c.query(
      `select c.table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
       where c.table_schema = 'public' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE' order by 1`,
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

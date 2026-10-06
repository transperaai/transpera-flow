import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamPersonIds, northbeamRoleIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Forecast plans (issue #36, B7): a named set of markers. Owners, editors and agency admins read and write; members and
// viewers see nothing; the trigger checks every marker with a plain message; the ids inside markers are not foreign keys.

const ws = NORTHBEAM_WORKSPACE_ID;
const role = northbeamRoleIds.ppc;
const person = northbeamPersonIds["Dan Okafor"]!;
let db: TestDb;
let otherWs: string;
let otherRole: string;
let otherPerson: string;
let otherSolution: string;
let solution: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const bundle = JSON.stringify({ steps: [], edges: [], entry_step_id: null });

const hire = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), kind: "hire", date: "2027-01-01", role_id: role, fte: 1, ...extra });
const leave = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), kind: "leave", date: "2027-03-01", person_id: person, weeks: 2, ...extra });
const sol = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), kind: "solution", date: "2027-04-01", solution_id: solution, ...extra });

const insert = (c: pg.Client, name: string, markers: unknown[] = [], workspace = ws) =>
  c.query("insert into forecast_plans (workspace_id, name, markers) values ($1, $2, $3::jsonb) returning id, created_by", [workspace, name, JSON.stringify(markers)]);

/** As the superuser, in a transaction that is rolled back: `run` must be refused with a message matching `pattern`. */
const refuses = async (run: (c: pg.Client) => Promise<unknown>, pattern: RegExp, code?: string) => {
  await db.client.query("begin");
  try {
    const err = await run(db.client).then(
      () => null,
      (e: unknown) => e as { message: string; code?: string },
    );
    expect(err, `expected a refusal matching ${pattern}`).not.toBeNull();
    expect(err!.message).toMatch(pattern);
    if (code) expect(err!.code).toBe(code);
  } finally {
    await db.client.query("rollback");
  }
};

beforeAll(async () => {
  db = await createTestDb();
  for (const r of ["owner", "editor", "member", "viewer"] as const) {
    users[r] = await createUser(db, `${r}@plans.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[r]!.id, r]);
  }
  users.stranger = await createUser(db, "stranger@plans.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-plans') returning id")).rows[0].id;
  otherRole = (await db.client.query("insert into roles (workspace_id, name) values ($1, 'Theirs') returning id", [otherWs])).rows[0].id;
  otherPerson = (await db.client.query("insert into people (workspace_id, name) values ($1, 'Them') returning id", [otherWs])).rows[0].id;
  const otherProcess = randomUUID();
  const otherRevision = randomUUID();
  await db.client.query("insert into processes (id, workspace_id, name) values ($1, $2, 'Theirs')", [otherProcess, otherWs]);
  await db.client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 1, 'draft')", [otherRevision, otherWs, otherProcess]);
  await db.client.query("update process_revisions set status = 'published' where id = $1", [otherRevision]);
  otherSolution = (await db.client.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'Theirs', $4::jsonb) returning id", [otherWs, otherProcess, otherRevision, bundle])).rows[0].id;
  solution = (await db.client.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'Ours', $4::jsonb) returning id", [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, bundle])).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

describe("forecast plans: editors", () => {
  it("insert a plan with one marker of each kind, read it back, rename it, replace its markers and delete it", async () => {
    for (const r of ["owner", "editor"]) {
      await db.as(users[r]!.claims, async (c) => {
        const markers = [hire({ name: "Jade" }), leave(), sol()];
        const id = (await insert(c, "Hire in January", markers)).rows[0].id;
        const row = (await c.query("select name, markers, workspace_id from forecast_plans where id = $1", [id])).rows[0];
        expect(row, r).toMatchObject({ name: "Hire in January", workspace_id: ws });
        expect(row.markers).toEqual(markers);
        expect((await c.query("update forecast_plans set name = 'Renamed' where id = $1", [id])).rowCount).toBe(1);
        const next = [hire({ date: "2027-03-01" })];
        expect((await c.query("update forecast_plans set markers = $2::jsonb where id = $1", [id, JSON.stringify(next)])).rowCount).toBe(1);
        expect((await c.query("select markers from forecast_plans where id = $1", [id])).rows[0].markers).toEqual(next);
        expect((await c.query("delete from forecast_plans where id = $1", [id])).rowCount).toBe(1);
      });
    }
  });

  it("have created_by set to themselves, whoever the insert names", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await c.query("insert into forecast_plans (workspace_id, name, created_by) values ($1, 'Mine', $2) returning created_by", [ws, users.owner!.id]);
      expect(r.rows[0].created_by).toBe(users.editor!.id);
    });
  });

  it("move updated_at on a change", async () => {
    await db.client.query("begin");
    try {
      const id = (await insert(db.client, "Clock")).rows[0].id;
      await db.client.query("update forecast_plans set updated_at = '2020-01-01' where id = $1", [id]);
      await db.client.query("update forecast_plans set name = 'Clock 2' where id = $1", [id]);
      const r = await db.client.query("select updated_at > '2021-01-01' as moved from forecast_plans where id = $1", [id]);
      expect(r.rows[0].moved).toBe(true);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("forecast plans: everyone else", () => {
  it("members and viewers read no plan and can't insert, update or delete one", async () => {
    const id = (await insert(db.client, "Seen by editors")).rows[0].id;
    try {
      for (const r of ["member", "viewer"]) {
        await db.as(users[r]!.claims, async (c) => {
          expect((await c.query("select id from forecast_plans")).rowCount, r).toBe(0);
          expect((await c.query("update forecast_plans set name = 'x' where id = $1", [id])).rowCount, r).toBe(0);
          expect((await c.query("delete from forecast_plans where id = $1", [id])).rowCount, r).toBe(0);
          await c.query("savepoint s");
          await expect(insert(c, "Nope"), r).rejects.toMatchObject({ code: "42501" });
          await c.query("rollback to savepoint s");
        });
      }
      await db.as(users.editor!.claims, async (c) => expect((await c.query("select id from forecast_plans where id = $1", [id])).rowCount).toBe(1));
    } finally {
      await db.client.query("delete from forecast_plans where id = $1", [id]);
    }
  });

  it("someone from another workspace can't read or write one, and an editor can't put one in another workspace or move it", async () => {
    const id = (await insert(db.client, "Ours only")).rows[0].id;
    try {
      await db.as(users.stranger!.claims, async (c) => {
        expect((await c.query("select id from forecast_plans")).rowCount).toBe(0);
        expect((await c.query("update forecast_plans set name = 'x' where id = $1", [id])).rowCount).toBe(0);
        expect((await c.query("delete from forecast_plans where id = $1", [id])).rowCount).toBe(0);
        await c.query("savepoint s");
        await expect(insert(c, "Nope")).rejects.toMatchObject({ code: "42501" });
        await c.query("rollback to savepoint s");
      });
      await db.as(users.editor!.claims, async (c) => {
        await c.query("savepoint s");
        await expect(insert(c, "Elsewhere", [], otherWs)).rejects.toMatchObject({ code: "42501" });
        await c.query("rollback to savepoint s");
        await expect(c.query("update forecast_plans set workspace_id = $2 where id = $1", [id, otherWs])).rejects.toMatchObject({ code: "42501" });
      });
      // Even the superuser, who is allowed to write any column, can't move a plan to another workspace.
      await refuses((c) => c.query("update forecast_plans set workspace_id = $2 where id = $1", [id, otherWs]), /stays in its workspace/, "23514");
    } finally {
      await db.client.query("delete from forecast_plans where id = $1", [id]);
    }
  });
});

describe("forecast plans: what the database refuses", () => {
  const cases: [string, () => unknown[], RegExp][] = [
    ["a role of another workspace", () => [hire({ role_id: otherRole })], /a hire needs a role of this workspace/],
    ["a role that isn't a uuid", () => [hire({ role_id: "nope" })], /a hire needs a role of this workspace/],
    ["a person of another workspace", () => [leave({ person_id: otherPerson })], /leave needs a person of this workspace/],
    ["a solution of another workspace", () => [sol({ solution_id: otherSolution })], /needs a solution of this workspace/],
    ["an unknown kind", () => [{ id: randomUUID(), kind: "fire", date: "2027-01-01" }], /a marker is not valid/],
    ["an extra key on a hire", () => [hire({ rate: 40 })], /a marker is not valid/],
    ["an extra key on a leave", () => [leave({ role_id: role })], /a marker is not valid/],
    ["an extra key on a solution", () => [sol({ weeks: 2 })], /a marker is not valid/],
    ["a marker that isn't an object", () => ["hire"], /a marker is not valid/],
    ["a marker with no id", () => [{ kind: "hire", date: "2027-01-01", role_id: role, fte: 1 }], /a marker is not valid/],
    ["a duplicate marker id", () => [hire({ id: "11111111-1111-4111-8111-111111111111" }), leave({ id: "11111111-1111-4111-8111-111111111111" })], /a marker is not valid/],
    ["a date that doesn't exist", () => [hire({ date: "2027-02-30" })], /date is not valid/],
    ["a short date", () => [hire({ date: "27-01-01" })], /date is not valid/],
    ["a date out of range", () => [hire({ date: "1999-12-31" })], /date is not valid/],
    ["FTE 0", () => [hire({ fte: 0 })], /FTE must be between 0.1 and 2/],
    ["FTE 2.5", () => [hire({ fte: 2.5 })], /FTE must be between 0.1 and 2/],
    ["FTE as a string", () => [hire({ fte: "1" })], /FTE must be between 0.1 and 2/],
    ["a name that isn't text", () => [hire({ name: 5 })], /a marker is not valid/],
    ["a name over 120 characters", () => [hire({ name: "x".repeat(121) })], /a marker is not valid/],
    ["0 weeks of leave", () => [leave({ weeks: 0 })], /1 to 52 whole weeks/],
    ["53 weeks of leave", () => [leave({ weeks: 53 })], /1 to 52 whole weeks/],
    ["1.5 weeks of leave", () => [leave({ weeks: 1.5 })], /1 to 52 whole weeks/],
    ["5 solution markers", () => Array.from({ length: 5 }, () => sol()), /at most 4 solutions/],
  ];
  for (const [what, markers, pattern] of cases) {
    it(`refuses ${what}`, async () => {
      await refuses((c) => insert(c, "Bad", markers()), pattern, "23514");
    });
  }

  it("refuses 41 markers (the check), a markers value that isn't an array, a blank name and a duplicate name", async () => {
    await refuses((c) => insert(c, "Many", Array.from({ length: 41 }, () => hire())), /violates check constraint/, "23514");
    // The trigger runs before the check, so an object (not an array) stops in the trigger's own array walk.
    await refuses((c) => c.query("insert into forecast_plans (workspace_id, name, markers) values ($1, 'Obj', '{}')", [ws]), /cannot extract elements from an object|violates check constraint/);
    await refuses((c) => insert(c, "   "), /violates check constraint/, "23514");
    await refuses((c) => insert(c, "x".repeat(121)), /violates check constraint/, "23514");
    await refuses(async (c) => {
      await insert(c, "Hire in March");
      await insert(c, "  hire IN march ");
    }, /forecast_plans_workspace_name_key/, "23505");
  });

  it("allows the same name in another workspace and accepts exactly 40 markers and 4 solutions", async () => {
    await db.client.query("begin");
    try {
      await insert(db.client, "Same");
      await insert(db.client, "Same", [], otherWs);
      await insert(db.client, "Full", [...Array.from({ length: 36 }, () => hire()), ...Array.from({ length: 4 }, () => sol())]);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("refuses the 51st plan of a workspace", async () => {
    await db.client.query("begin");
    try {
      for (let i = 0; i < 50; i++) await insert(db.client, `Plan ${i}`);
      await expect(insert(db.client, "Plan 50")).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/at most 50 plans/) });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("checks the markers again when they are replaced", async () => {
    await db.client.query("begin");
    try {
      const id = (await insert(db.client, "Ok", [hire()])).rows[0].id;
      await db.client.query("savepoint s");
      await expect(db.client.query("update forecast_plans set markers = $2::jsonb where id = $1", [id, JSON.stringify([hire({ fte: 9 })])])).rejects.toThrow(/FTE must be between/);
      await db.client.query("rollback to savepoint s");
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("forecast plans: ids inside markers aren't foreign keys", () => {
  it("deleting a role a hire marker uses succeeds and the plan keeps the marker", async () => {
    await db.client.query("begin");
    try {
      const spare = (await db.client.query("insert into roles (workspace_id, name) values ($1, 'Spare') returning id", [ws])).rows[0].id;
      const marker = hire({ role_id: spare });
      const id = (await insert(db.client, "Uses spare", [marker])).rows[0].id;
      await db.client.query("delete from roles where id = $1", [spare]);
      expect((await db.client.query("select markers from forecast_plans where id = $1", [id])).rows[0].markers).toEqual([marker]);
      // A save checks every marker again, so the stale one must be removed first (the app does that after a confirm).
      await db.client.query("savepoint s");
      await expect(db.client.query("update forecast_plans set name = 'Renamed' where id = $1", [id])).rejects.toThrow(/a hire needs a role/);
      await db.client.query("rollback to savepoint s");
    } finally {
      await db.client.query("rollback");
    }
  });

  it("deleting the user who made a plan leaves the plan with created_by null", async () => {
    const maker = await createUser(db, "maker@plans.example.com");
    const id = (await db.client.query("insert into forecast_plans (workspace_id, name, created_by) values ($1, 'Made by', $2) returning id", [ws, maker.id])).rows[0].id;
    try {
      expect((await db.client.query("select created_by from forecast_plans where id = $1", [id])).rows[0].created_by).toBe(maker.id);
      await db.client.query("delete from auth.users where id = $1", [maker.id]);
      expect((await db.client.query("select created_by from forecast_plans where id = $1", [id])).rows[0].created_by).toBeNull();
    } finally {
      await db.client.query("delete from forecast_plans where id = $1", [id]);
    }
  });
});

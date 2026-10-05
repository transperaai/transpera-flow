import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamClientIds, northbeamIssues, northbeamServiceIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Adding things by hand, part 1 (issue #182, B19; migration 20261201000000): clients are added, edited and made inactive by
// owners and editors but never deleted by anyone signed in (only the workspace's own deletion takes them); deleting a
// solution keeps its issue links in the audit log and on each issue's history; and an owner edits the workspace's name and
// currency, which the database checks.

const ws = NORTHBEAM_WORKSPACE_ID;
const first = northbeamClientIds.c01!;
const [openIssue, testingIssue] = northbeamIssues().map((i) => i.id) as [string, string, string];
let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};

const saveFields = async (c: pg.Client, target: string, key: object, base: object, changes: object) =>
  (await c.query("select public.save_fields($1, $2::jsonb, $3::jsonb, $4::jsonb) as r", [target, JSON.stringify(key), JSON.stringify(base), JSON.stringify(changes)])).rows[0].r as {
    status: string;
    row?: Record<string, unknown>;
  };
const fails = async (c: pg.Client, run: () => Promise<unknown>, pattern: RegExp) => {
  await c.query("savepoint s");
  try {
    await expect(run()).rejects.toThrow(pattern);
  } finally {
    await c.query("rollback to savepoint s");
  }
};

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@manual.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
});

afterAll(async () => {
  await db?.close();
});

describe("clients by hand", () => {
  it("lets owners and editors add a client, set its services and status, and never delete one", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        const id = (await c.query("insert into clients (workspace_id, name, mrr, start_date) values ($1, 'Hand Made Ltd', 1800, '2026-09-01') returning id", [ws])).rows[0].id;
        await c.query("insert into client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [id, northbeamServiceIds.seo, ws]);
        expect((await saveFields(c, "clients", { id }, { active: true }, { active: false })).status).toBe("saved");
        await fails(c, () => c.query("delete from clients where id = $1", [id]), /never deleted: mark them inactive/);
        await fails(c, () => c.query("delete from clients where id = $1", [first]), /never deleted/);
        expect((await c.query("select active from clients where id = $1", [id])).rows[0].active).toBe(false);
      });
    }
  });

  it("refuses viewers and members every write", async () => {
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        await fails(c, () => c.query("insert into clients (workspace_id, name) values ($1, 'Nope')", [ws]), /row-level security/);
        expect((await saveFields(c, "clients", { id: first }, { active: true }, { active: false })).status).toBe("not_found");
        // Row-level security hides the row from a delete, so nothing goes (and the rule never needs to speak).
        expect((await c.query("delete from clients where id = $1", [first])).rowCount).toBe(0);
      });
    }
    expect((await db.client.query("select active from clients where id = $1", [first])).rows[0].active).toBe(true);
  });

  it("still lets an agency admin delete a whole workspace, clients and all", async () => {
    const other = (await db.client.query("insert into workspaces (name, slug) values ('Short-lived', 'short-lived-clients') returning id")).rows[0].id;
    await db.client.query("insert into clients (workspace_id, name) values ($1, 'Gone with it')", [other]);
    const admin = await createUser(db, "agency@manual.example.com", { agency_admin: true });
    await db.client.query("begin");
    try {
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(admin.claims)]);
      expect((await db.client.query("delete from workspaces where id = $1", [other])).rowCount).toBe(1);
      await db.client.query("commit");
    } catch (e) {
      await db.client.query("rollback");
      throw e;
    }
    expect((await db.client.query("select count(*)::int as n from clients where workspace_id = $1", [other])).rows[0].n).toBe(0);
  });
});

describe("deleting a solution", () => {
  it("keeps its issue links in the audit log and adds a line to each issue's history", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const sol = (
        await c.query("select public.save_solution($1, $2, $3, 'Second check', $4::jsonb, '[]', '[]', $5::jsonb) as r", [
          ws,
          NORTHBEAM_PROCESS_ID,
          NORTHBEAM_REVISION_ID,
          JSON.stringify({ steps: [], edges: [], entry_step_id: null }),
          JSON.stringify([
            { issue_id: openIssue, auto_verdict: "pass", holds_pct: 90, auto_note: "Wait 3 h against under 4 hours" },
            { issue_id: testingIssue, auto_verdict: "fail", holds_pct: 20, auto_note: "" },
          ]),
        ])
      ).rows[0].r.id as string;
      await c.query("update solution_issues set user_verdict = 'pass', user_notes = 'Worked in the pilot' where solution_id = $1 and issue_id = $2", [sol, openIssue]);
      expect((await c.query("delete from solutions where id = $1", [sol])).rowCount).toBe(1);
      expect((await c.query("select count(*)::int as n from solution_issues where solution_id = $1", [sol])).rows[0].n).toBe(0);

      // The audit log is for owners to read: look as the superuser, still inside this transaction.
      await c.query("reset role");
      const audit = (await c.query("select actor_id, actor_kind, action, diff from audit_log where target_table = 'solutions' and target_id = $1", [sol])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: users.editor!.id, actor_kind: "user", action: "delete" });
      expect(audit[0].diff.old).toMatchObject({ name: "Second check", process_id: NORTHBEAM_PROCESS_ID, base_revision_id: NORTHBEAM_REVISION_ID });
      expect(audit[0].diff.old).not.toHaveProperty("steps");
      const links = audit[0].diff.issue_links as Record<string, unknown>[];
      expect(links.map((l) => [l.issue_id, l.auto_verdict, l.holds_pct, l.user_verdict, l.user_notes]).sort()).toEqual(
        [
          [openIssue, "pass", 90, "pass", "Worked in the pilot"],
          [testingIssue, "fail", 20, null, ""],
        ].sort(),
      );
      for (const issue of [openIssue, testingIssue]) {
        // Both were in Testing solutions with only this solution linked: back to Open, in ONE history entry with the deletion.
        expect((await c.query("select status from issues where id = $1", [issue])).rows[0].status).toBe("open");
        const last = (await c.query("select kind, actor, detail from issue_events where issue_id = $1 order by seq desc limit 2", [issue])).rows;
        expect(last[0]).toEqual({
          kind: "edited",
          actor: users.editor!.id,
          detail: { from: "testing", to: "open", solution_deleted: { solution_id: sol, solution: "Second check" } },
        });
        expect(last[1].detail).not.toHaveProperty("solution_deleted");
        // The earlier "started testing" entries keep the solution's name.
        const tested = (await c.query("select detail from issue_events where issue_id = $1 and kind = 'solution_tested' and detail ->> 'solution_id' = $2", [issue, sol])).rows;
        expect(tested.map((t) => t.detail.solution)).toEqual(["Second check"]);
      }
    });
  });

  it("leaves an issue still testing another solution, and a resolved one, as they were", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const steps = JSON.stringify({ steps: [], edges: [], entry_step_id: null });
      const saveOne = async (name: string, issues: string[]) =>
        (
          await c.query("select public.save_solution($1, $2, $3, $4, $5::jsonb, '[]', '[]', $6::jsonb) as r", [
            ws,
            NORTHBEAM_PROCESS_ID,
            NORTHBEAM_REVISION_ID,
            name,
            steps,
            JSON.stringify(issues.map((issue_id) => ({ issue_id, auto_verdict: "pass", holds_pct: 90, auto_note: "" }))),
          ])
        ).rows[0].r.id as string;
      const first = await saveOne("First idea", [openIssue, testingIssue]);
      await saveOne("Second idea", [openIssue]);
      // testingIssue is resolved by the first solution; openIssue is still testing the second.
      await c.query("select public.resolve_issue($1, $2, 'solution', 'Shipped', 'resolved', $3)", [ws, testingIssue, first]);
      const before = (await c.query("select status from issues where id = $1", [testingIssue])).rows[0].status;
      expect(before).toBe("done"); // stored "done": shown as Resolved
      expect((await c.query("delete from solutions where id = $1", [first])).rowCount).toBe(1);
      expect((await c.query("select status from issues where id = $1", [openIssue])).rows[0].status).toBe("in_progress");
      expect((await c.query("select status from issues where id = $1", [testingIssue])).rows[0].status).toBe(before);
      for (const issue of [openIssue, testingIssue]) {
        const last = (await c.query("select kind, detail from issue_events where issue_id = $1 order by seq desc limit 1", [issue])).rows[0];
        expect(last).toEqual({ kind: "edited", detail: { solution_deleted: { solution_id: first, solution: "First idea" } } });
      }
    });
  });

  it("refuses a viewer, who deletes nothing and logs nothing", async () => {
    const sol = (
      await db.client.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'Keep me', $4::jsonb) returning id", [
        ws,
        NORTHBEAM_PROCESS_ID,
        NORTHBEAM_REVISION_ID,
        JSON.stringify({ steps: [], edges: [] }),
      ])
    ).rows[0].id;
    try {
      await db.as(users.viewer!.claims, async (c) => {
        expect((await c.query("delete from solutions where id = $1", [sol])).rowCount).toBe(0);
      });
      expect((await db.client.query("select count(*)::int as n from solutions where id = $1", [sol])).rows[0].n).toBe(1);
      expect((await db.client.query("select count(*)::int as n from audit_log where target_id = $1", [sol])).rows[0].n).toBe(0);
    } finally {
      await db.client.query("delete from solutions where id = $1", [sol]);
      await db.client.query("delete from audit_log where target_id = $1", [sol]);
    }
  });

  it("logs nothing when the whole workspace goes", async () => {
    await db.client.query("begin");
    try {
      const other = (await db.client.query("insert into workspaces (name, slug) values ('Gone', 'gone-solutions') returning id")).rows[0].id;
      const proc = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'P') returning id", [other])).rows[0].id;
      const rev = (await db.client.query("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'draft') returning id", [other, proc])).rows[0].id;
      await db.client.query("update process_revisions set status = 'published' where id = $1", [rev]);
      await db.client.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'S', '{\"steps\":[],\"edges\":[]}')", [other, proc, rev]);
      await db.client.query("delete from workspaces where id = $1", [other]);
      expect((await db.client.query("select count(*)::int as n from audit_log where workspace_id = $1 and target_table = 'solutions'", [other])).rows[0].n).toBe(0);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("the workspace's name and currency", () => {
  it("lets an owner change both, and refuses editors and viewers", async () => {
    await db.as(users.owner!.claims, async (c) => {
      const before = (await c.query("select name, settings ->> 'currency' as currency from workspaces where id = $1", [ws])).rows[0];
      expect((await saveFields(c, "workspaces", { id: ws }, { name: before.name }, { name: "Northbeam Digital" })).status).toBe("saved");
      expect((await saveFields(c, "workspaces", { id: ws }, { "settings.currency": before.currency }, { "settings.currency": "AUD" })).status).toBe("saved");
      expect((await c.query("select name, settings ->> 'currency' as currency from workspaces where id = $1", [ws])).rows[0]).toEqual({ name: "Northbeam Digital", currency: "AUD" });
    });
    for (const role of ["editor", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await saveFields(c, "workspaces", { id: ws }, { "settings.currency": "GBP" }, { "settings.currency": "USD" })).status).toBe("not_found");
        expect((await c.query("update workspaces set name = 'Mine now' where id = $1", [ws])).rowCount).toBe(0);
      });
    }
  });

  it("refuses a blank or over-long name and a currency that isn't a three-letter code", async () => {
    await db.as(users.owner!.claims, async (c) => {
      const cur = (await c.query("select settings ->> 'currency' as v from workspaces where id = $1", [ws])).rows[0].v;
      await fails(c, () => c.query("update workspaces set name = '   ' where id = $1", [ws]), /workspaces_name_length/);
      await fails(c, () => c.query("update workspaces set name = repeat('x', 201) where id = $1", [ws]), /workspaces_name_length/);
      for (const bad of ["pounds", "gbp", "GB", 12]) {
        await fails(c, () => saveFields(c, "workspaces", { id: ws }, { "settings.currency": cur }, { "settings.currency": bad }), /workspaces_currency_code/);
      }
    });
  });
});

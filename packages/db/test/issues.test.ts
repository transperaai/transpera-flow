import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { absenceTest, detectIssues, simulate } from "@transpera-flow/engine";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamBundle,
  northbeamIssues,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamScenarios,
  northbeamStepIds,
  toEngineModel,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Issues register (issue #17): row-level security, constraints, the trigger
// that fixes source/detected_key and keeps resolved_at, per-field saves, and
// one tracked row per detection.

let db: TestDb;
let other: string;
let otherScenario: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const audit = northbeamStepIds.audit;

beforeAll(async () => {
  db = await createTestDb();
  other = (await db.client.query("insert into workspaces (name, slug) values ('Other Co', 'other-co') returning id")).rows[0].id;
  otherScenario = (await db.client.query("select id from scenarios where workspace_id = $1 limit 1", [other])).rows[0].id;
  await db.client.query(
    "insert into issues (workspace_id, type, severity, title) values ($1, 'idea', 'info', 'Other workspace idea')",
    [other],
  );
  users.admin = await createUser(db, "admin@agency.example", { agency_admin: true });
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@northbeam.example`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@example.com");
});

afterAll(async () => {
  await db?.close();
});

const titles = async (c: pg.Client, workspace: string) =>
  (await c.query("select title from issues where workspace_id = $1 order by title", [workspace])).rows.map((r) => r.title as string);

const logIssue = (c: pg.Client, workspace: string, fields: Record<string, unknown> = {}) => {
  const row = { workspace_id: workspace, type: "manual", severity: "warning", title: "Reports copied by hand", ...fields };
  const cols = Object.keys(row);
  return c.query(
    `insert into issues (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    Object.values(row).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)),
  );
};

describe("seed", () => {
  it("gives Northbeam its three issues, linked to steps, people and scenarios", async () => {
    const rows = (await db.client.query("select id, title, source, detected_key, scenario_id, status, resolved_at from issues where workspace_id = $1 order by id", [ws])).rows;
    const fixture = northbeamIssues();
    expect(rows.map((r) => r.title)).toEqual(fixture.map((i) => i.title));
    expect(rows.map((r) => r.source)).toEqual(["manual", "promoted", "manual"]);
    expect(rows[1].detected_key).toBe(`spof:step:${audit}`);
    expect(rows[0].scenario_id).toBe(northbeamScenarios()[1]!.id);
    expect(rows.every((r) => r.resolved_at === null)).toBe(true);
  });

  it("the promoted issue's key is one the engine detects on Northbeam", () => {
    const model = toEngineModel(northbeamBundle(), { startDate: "2026-10-05" });
    const keys = detectIssues(model, simulate(model, 30, 1), {}, { absence: absenceTest(model) }).map((i) => i.key);
    for (const issue of northbeamIssues().filter((i) => i.detected_key)) expect(keys).toContain(issue.detected_key);
  });
});

describe("row-level security", () => {
  it("every member of the workspace can read its register; strangers and other workspaces see none", async () => {
    for (const role of ["admin", "owner", "editor", "member", "viewer"]) {
      expect(await db.as(users[role]!.claims, (c) => titles(c, ws)), role).toHaveLength(3);
    }
    expect(await db.as(users.stranger!.claims, (c) => c.query("select count(*) from issues").then((r) => Number(r.rows[0].count)))).toBe(0);
    expect(await db.as(users.editor!.claims, (c) => titles(c, other))).toEqual([]);
  });

  it("editors, owners and agency admins can log, edit, close and delete; members and viewers can't", async () => {
    for (const role of ["admin", "owner", "editor"]) {
      const result = await db.as(users[role]!.claims, async (c) => {
        const row = (await logIssue(c, ws, { step_id: audit, process_id: NORTHBEAM_PROCESS_ID })).rows[0];
        const closed = (await c.query("update issues set status = 'done' where id = $1 returning resolved_at", [row.id])).rows[0];
        const deleted = (await c.query("delete from issues where id = $1", [row.id])).rowCount;
        return { createdBy: row.created_by, resolved: closed.resolved_at !== null, deleted };
      });
      expect(result, role).toEqual({ createdBy: users[role]!.id, resolved: true, deleted: 1 });
    }
    for (const role of ["member", "viewer", "stranger"]) {
      await expect(db.as(users[role]!.claims, (c) => logIssue(c, ws)), role).rejects.toThrow(/row-level security/);
      const changed = await db.as(users[role]!.claims, async (c) => ({
        updated: (await c.query("update issues set status = 'dismissed' where workspace_id = $1", [ws])).rowCount,
        deleted: (await c.query("delete from issues where workspace_id = $1", [ws])).rowCount,
      }));
      expect(changed, role).toEqual({ updated: 0, deleted: 0 });
    }
  });

  it("an editor of one workspace can't write into another, or move an issue there", async () => {
    await expect(db.as(users.editor!.claims, (c) => logIssue(c, other))).rejects.toThrow(/row-level security/);
    await expect(
      db.as(users.editor!.claims, (c) => c.query("update issues set workspace_id = $1 where workspace_id = $2", [other, ws])),
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it("detected rows are the engine's: nobody can insert, edit or delete them through the API", async () => {
    await expect(
      db.as(users.admin!.claims, (c) => logIssue(c, ws, { source: "detected", detected_key: `wait:step:${audit}` })),
    ).rejects.toThrow(/row-level security/);
    const id = (await db.client.query("insert into issues (workspace_id, type, title, source, detected_key) values ($1, 'delay', 'Stored detection', 'detected', $2) returning id", [ws, `wait:step:${audit}`])).rows[0].id;
    try {
      const changed = await db.as(users.admin!.claims, async (c) => ({
        visible: (await c.query("select count(*) from issues where id = $1", [id])).rows[0].count,
        updated: (await c.query("update issues set title = 'x' where id = $1", [id])).rowCount,
        deleted: (await c.query("delete from issues where id = $1", [id])).rowCount,
      }));
      expect(changed).toEqual({ visible: "1", updated: 0, deleted: 0 });
    } finally {
      await db.client.query("delete from issues where id = $1", [id]);
    }
  });

  it("gives the anon role no access", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select * from issues")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("constraints", () => {
  const as = <T>(fn: (c: pg.Client) => Promise<T>) => db.as(users.editor!.claims, fn);

  it("accepts every field the register lists", async () => {
    const row = await as(async (c) =>
      (
        await logIssue(c, ws, {
          process_id: NORTHBEAM_PROCESS_ID,
          step_id: audit,
          role_id: northbeamRoleIds.strat,
          person_id: northbeamPersonIds["Maya Collins"],
          type: "bottleneck",
          severity: "critical",
          evidence: "Seen in the audit.",
          evidence_metrics: { utilisation: 0.97 },
          owner_person_id: northbeamPersonIds["Rosa Diaz"],
          status: "in_progress",
          scenario_id: northbeamScenarios()[0]!.id,
        })
      ).rows[0],
    );
    expect(row).toMatchObject({ type: "bottleneck", severity: "critical", status: "in_progress", source: "manual", evidence_metrics: { utilisation: 0.97 } });
  });

  it.each([
    [{ type: "gremlins" }, /issues_type/],
    [{ severity: "urgent" }, /issues_severity/],
    [{ status: "closed" }, /issues_status/],
    [{ title: "   " }, /issues_title_length/],
    [{ title: "x".repeat(201) }, /issues_title_length/],
    [{ evidence: "x".repeat(5001) }, /issues_evidence_length/],
    [{ evidence_metrics: [1] }, /issues_evidence_metrics_shape/],
    [{ source: "promoted" }, /issues_detected_key_source/],
    [{ detected_key: `spof:step:${audit}` }, /issues_detected_key_source/],
    [{ source: "promoted", detected_key: "not a key" }, /issues_detected_key_shape/],
    [{ source: "imported", detected_key: "a:b:c" }, /issues_source/],
  ])("rejects %j", async (fields, error) => {
    await expect(as((c) => logIssue(c, ws, fields))).rejects.toThrow(error);
  });

  it("links only to a scenario, person, role or process in the same workspace", async () => {
    const otherRole = (await db.client.query("insert into roles (workspace_id, name) values ($1, 'X') returning id", [other])).rows[0].id;
    for (const fields of [{ scenario_id: otherScenario }, { role_id: otherRole }]) {
      await expect(as((c) => logIssue(c, ws, fields))).rejects.toThrow(/foreign key/);
    }
  });

  it("a detection is tracked once: promoting it again is refused", async () => {
    // The seed already promoted Northbeam's audit single point of failure.
    await expect(
      as((c) => logIssue(c, ws, { type: "spof", source: "promoted", detected_key: `spof:step:${audit}` })),
    ).rejects.toThrow(/issues_workspace_detected_key/);
    // Another workspace can track the same key.
    await expect(
      db.as(users.admin!.claims, (c) => logIssue(c, other, { type: "spof", source: "promoted", detected_key: `spof:step:${audit}` })),
    ).resolves.toBeTruthy();
  });

  it("source and detected_key are fixed once written", async () => {
    await as(async (c) => {
      const row = (await logIssue(c, ws, { source: "promoted", detected_key: `rework:step:${audit}` })).rows[0];
      await expect(c.query("update issues set detected_key = $2 where id = $1", [row.id, `wait:step:${audit}`])).rejects.toThrow(
        /cannot be changed/,
      );
    });
    await as(async (c) => {
      const row = (await logIssue(c, ws)).rows[0];
      await expect(c.query("update issues set source = 'promoted', detected_key = $2 where id = $1", [row.id, `wait:step:${audit}`])).rejects.toThrow(
        /cannot be changed/,
      );
    });
  });

  it("resolved_at is set when an issue is done or dismissed, kept while it stays closed, and cleared on reopening", async () => {
    await as(async (c) => {
      const row = (await logIssue(c, ws, { resolved_at: "2020-01-01T00:00:00Z" })).rows[0];
      expect(row.resolved_at).toBeNull();
      const done = (await c.query("update issues set status = 'done' where id = $1 returning resolved_at", [row.id])).rows[0].resolved_at;
      expect(done).toBeInstanceOf(Date);
      const dismissed = (await c.query("update issues set status = 'dismissed', resolved_at = null where id = $1 returning resolved_at", [row.id])).rows[0].resolved_at;
      expect(dismissed).toEqual(done);
      const reopened = (await c.query("update issues set status = 'open' where id = $1 returning resolved_at", [row.id])).rows[0].resolved_at;
      expect(reopened).toBeNull();
      const closedOnInsert = (await logIssue(c, ws, { status: "done" })).rows[0].resolved_at;
      expect(closedOnInsert).toBeInstanceOf(Date);
    });
  });

  it("a deleted scenario or person unlinks from the issue instead of blocking the delete", async () => {
    const { scenario, person } = await db.as(users.admin!.claims, async (c) => {
      const s = (await c.query("insert into scenarios (workspace_id, name) values ($1, 'Temp') returning id", [ws])).rows[0].id;
      const p = (await c.query("insert into people (workspace_id, name) values ($1, 'Temp') returning id", [ws])).rows[0].id;
      const i = (await logIssue(c, ws, { scenario_id: s, owner_person_id: p, person_id: p })).rows[0].id;
      await c.query("delete from scenarios where id = $1", [s]);
      await c.query("delete from people where id = $1", [p]);
      return (await c.query("select scenario_id as scenario, owner_person_id as person, workspace_id from issues where id = $1", [i])).rows[0];
    });
    expect({ scenario, person }).toEqual({ scenario: null, person: null });
  });
});

describe("per-field saves", () => {
  const save = (c: pg.Client, id: string, base: object, changes: object) =>
    c
      .query("select public.save_fields('issues', $1::jsonb, $2::jsonb, $3::jsonb) as r", [JSON.stringify({ id }), JSON.stringify(base), JSON.stringify(changes)])
      .then((r) => r.rows[0].r);
  const seeded = northbeamIssues()[0]!;

  it("saves a field whose base matches, and reports a same-field conflict", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const saved = await save(c, seeded.id, { status: "open" }, { status: "in_progress" });
      expect(saved.status).toBe("saved");
      expect(saved.row.status).toBe("in_progress");
      const conflict = await save(c, seeded.id, { status: "open" }, { status: "done" });
      expect(conflict).toMatchObject({ status: "conflict", conflicts: { status: "in_progress" } });
      // A different field of the same row merges.
      expect((await save(c, seeded.id, { severity: "serious" }, { severity: "critical" })).status).toBe("saved");
    });
  });

  it("closing through save_fields sets resolved_at", async () => {
    const row = await db.as(users.owner!.claims, (c) => save(c, seeded.id, { status: "open" }, { status: "done" }));
    expect(row.row.resolved_at).not.toBeNull();
  });

  it("a viewer's save finds nothing to update", async () => {
    expect(await db.as(users.viewer!.claims, (c) => save(c, seeded.id, { title: seeded.title }, { title: "Hacked" }))).toEqual({ status: "not_found" });
  });

  it("can't change the key, the workspace or the source", async () => {
    const editor = users.editor!.claims;
    await expect(db.as(editor, (c) => save(c, seeded.id, { workspace_id: ws }, { workspace_id: other }))).rejects.toThrow(/cannot be saved/);
    await expect(db.as(editor, (c) => save(c, seeded.id, { source: "manual" }, { source: "promoted" }))).rejects.toThrow(/cannot be changed/);
    const promoted = northbeamIssues()[1]!;
    await expect(
      db.as(editor, (c) => save(c, promoted.id, { detected_key: promoted.detected_key }, { detected_key: `wait:step:${audit}` })),
    ).rejects.toThrow(/cannot be changed/);
  });
});

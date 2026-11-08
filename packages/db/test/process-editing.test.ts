import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamStepIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The canvas editor's write paths (issue #8, apps/web/src/app/w/[slug]/actions.ts),
// run as the signed-in user under RLS: steps and edges created with ids made
// in the browser, fields saved with save_fields (keyed by revision and id),
// deletes, and undo re-inserting what was deleted. Step ids never change.
// Edits go into the process's draft (issue #9), opened here with open_draft.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const ids = northbeamStepIds;
/** The draft revision the current test edits (set by openDraft). */
let rev = NORTHBEAM_REVISION_ID;

const openDraft = async (c: pg.Client) => {
  const r = (await c.query("select public.open_draft($1) as r", [NORTHBEAM_PROCESS_ID])).rows[0].r;
  expect(r.status).toBe("ok");
  rev = r.revision_id;
  return rev;
};

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["editor", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@canvas.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
});

afterAll(async () => {
  await db?.close();
});

const saveFields = async (c: pg.Client, target: string, id: string, base: object, changes: object) =>
  (
    await c.query("select public.save_fields($1, $2::jsonb, $3::jsonb, $4::jsonb) as r", [
      target,
      JSON.stringify({ revision_id: rev, id }),
      JSON.stringify(base),
      JSON.stringify(changes),
    ])
  ).rows[0].r as { status: string; conflicts?: Record<string, unknown>; row?: Record<string, unknown> };

const insertStep = (c: pg.Client, id: string, fields: Record<string, unknown> = {}) => {
  const row = { id, revision_id: rev, workspace_id: ws, process_id: NORTHBEAM_PROCESS_ID, name: "New task", kind: "task", x: 10, y: 20, ...fields };
  const cols = Object.keys(row);
  return c.query(`insert into steps (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
};

const insertEdge = (c: pg.Client, id: string, from: string, to: string, probability = 1) =>
  c.query(
    "insert into edges (id, revision_id, workspace_id, process_id, from_step_id, to_step_id, probability) values ($1, $2, $3, $4, $5, $6, $7)",
    [id, rev, ws, NORTHBEAM_PROCESS_ID, from, to, probability],
  );

const stepIds = async (c: pg.Client) => (await c.query("select id from steps where revision_id = $1 order by id", [rev])).rows.map((r) => r.id);

describe("editing a process on the canvas", () => {
  it("creates a step and edges with the browser's ids, edits them, deletes and restores them, and never changes ids", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await openDraft(c);
      const before = await stepIds(c);
      const step = randomUUID();
      const inbound = randomUUID();
      const outbound = randomUUID();
      await insertStep(c, step);
      await insertEdge(c, inbound, ids.onboard, step, 0);
      await insertEdge(c, outbound, step, ids.kickoff);

      // Field saves keyed by (revision_id, id), including one key of the params jsonb.
      expect((await saveFields(c, "steps", step, { name: "New task" }, { name: "Send welcome pack" })).status).toBe("saved");
      expect((await saveFields(c, "steps", step, { "work_params.cv": null }, { "work_params.cv": 0.5 })).status).toBe("saved");
      expect((await saveFields(c, "steps", step, { x: 10, y: 20 }, { x: 300, y: 400 })).status).toBe("saved");
      expect((await saveFields(c, "edges", inbound, { probability: 0 }, { probability: 0.4 })).status).toBe("saved");
      // Kind and outcome change together, as the check constraint needs.
      expect((await saveFields(c, "steps", ids.lost, { kind: "end", outcome: "lost" }, { kind: "task", outcome: null })).status).toBe("saved");
      const saved = (await c.query("select name, work_params, x::float8 as x from steps where id = $1", [step])).rows[0];
      expect(saved).toEqual({ name: "Send welcome pack", work_params: { cv: 0.5 }, x: 300 });

      // A stale save is a conflict, not an overwrite.
      const stale = await saveFields(c, "steps", step, { name: "New task" }, { name: "Other" });
      expect(stale.status).toBe("conflict");
      expect(stale.conflicts).toEqual({ name: "Send welcome pack" });

      // Deleting the step takes its edges; undo inserts the same rows again.
      const edgesBefore = (await c.query("select * from edges where id in ($1, $2) order by id", [inbound, outbound])).rows;
      const stepBefore = (await c.query("select * from steps where id = $1", [step])).rows[0];
      await c.query("delete from steps where revision_id = $1 and id = $2", [rev, step]);
      expect((await c.query("select count(*)::int as n from edges where id in ($1, $2)", [inbound, outbound])).rows[0].n).toBe(0);
      const { created_at: _c, updated_at: _u, created_by: _b, ...restored } = stepBefore;
      await insertStep(c, step, restored);
      for (const e of edgesBefore) await insertEdge(c, e.id, e.from_step_id, e.to_step_id, e.probability);

      // Reload: the same ids, the new one included.
      expect(await stepIds(c)).toEqual([...before, step].sort());
      expect((await c.query("select name from steps where id = $1", [step])).rows[0].name).toBe("Send welcome pack");
      expect((await c.query("select count(*)::int as n from edges where id in ($1, $2)", [inbound, outbound])).rows[0].n).toBe(2);
    });
  });

  it("saves current WIP with its provenance as one compare-and-set, keyed per column in the provenance jsonb", async () => {
    // Onboarding: a step whose provenance the seed leaves empty.
    await db.as(users.editor!.claims, async (c) => {
      await openDraft(c);
      const entered = { source: "entered", at: "2026-09-29T10:00:00.000Z", by: users.editor!.id };
      // What the editor sends: the value and `provenance.current_wip`, each with the base it last saw.
      const saved = await saveFields(
        c,
        "steps",
        ids.onboard,
        { current_wip: null, "provenance.current_wip": null },
        { current_wip: 7, "provenance.current_wip": entered },
      );
      expect(saved.status).toBe("saved");
      const row = (await c.query("select current_wip, provenance from steps where revision_id = $1 and id = $2", [rev, ids.onboard])).rows[0];
      expect(row).toEqual({ current_wip: 7, provenance: { current_wip: entered } });

      // Another column's provenance merges into the same jsonb.
      const work = { source: "entered", at: "2026-09-29T11:00:00.000Z", by: users.editor!.id };
      expect((await saveFields(c, "steps", ids.onboard, { "provenance.work_hours": null }, { "provenance.work_hours": work })).status).toBe("saved");

      // Someone who loaded before the first save conflicts on both, and learns the stored entry.
      const stale = await saveFields(
        c,
        "steps",
        ids.onboard,
        { current_wip: null, "provenance.current_wip": null },
        { current_wip: 3, "provenance.current_wip": { ...entered, at: "2026-09-29T12:00:00.000Z" } },
      );
      expect(stale.status).toBe("conflict");
      expect(stale.conflicts).toEqual({ current_wip: 7, "provenance.current_wip": entered });

      // Undo: both go back to what they were.
      expect(
        (await saveFields(c, "steps", ids.onboard, { current_wip: 7, "provenance.current_wip": entered }, { current_wip: null, "provenance.current_wip": null }))
          .status,
      ).toBe("saved");
      const undone = (await c.query("select current_wip, provenance from steps where revision_id = $1 and id = $2", [rev, ids.onboard])).rows[0];
      expect(undone).toEqual({ current_wip: null, provenance: { current_wip: null, work_hours: work } });
    });
  });

  it("rejects an end step without an outcome", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await openDraft(c);
      await expect(insertStep(c, randomUUID(), { kind: "end" })).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("gives viewers a read-only process", async () => {
    // An editor has a draft open; the viewer can't write to it.
    const asViewerWithDraft = (fn: (c: pg.Client) => Promise<void>) =>
      db.as(users.editor!.claims, async (c) => {
        await openDraft(c);
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(users.viewer!.claims)]);
        await fn(c);
      });
    await asViewerWithDraft(async (c) => {
      await expect(insertStep(c, randomUUID())).rejects.toMatchObject({ code: "42501" });
    });
    await asViewerWithDraft(async (c) => {
      expect((await saveFields(c, "steps", ids.audit, { name: "Audit & proposal" }, { name: "Hacked" })).status).toBe("not_found");
      const deleted = await c.query("delete from steps where revision_id = $1 and id = $2 returning id", [rev, ids.audit]);
      expect(deleted.rowCount).toBe(0);
      expect(await stepIds(c)).toContain(ids.audit);
    });
  });
});

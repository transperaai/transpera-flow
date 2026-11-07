import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { northbeamStepIds as ids, type ProcessBundle } from "@transpera-flow/db";
import { DEMO_GROUP_IDS, withDemoGroups } from "@/lib/demo/nested";
import { addAfter, groupSteps, ungroup } from "@/lib/editor/groups";
import { applyEdit, invertEdit, saveUnits, type Edit } from "@/lib/editor/ops";
import { demoBundle } from "@/lib/sources/demo";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";

// The Editor's grouping edits, saved the way the app saves them: one row at a time, each its own transaction (so no
// deferred check can wait for the next statement). The database must accept every step of the order the edits use,
// and end up holding what the editor showed (issue #104, on migration 20261108000000).

let db: TestDb;

type Row = Record<string, unknown>;

/** Put the demo's steps and edges into a fresh draft revision, and return the bundle as the editor would hold it. */
async function seedDraft(source: ProcessBundle): Promise<ProcessBundle> {
  const process_id = randomUUID();
  const revision_id = randomUUID();
  const workspace_id = source.workspace.id;
  await db.client.query("insert into processes (id, workspace_id, name) values ($1, $2, 'Editor test')", [process_id, workspace_id]);
  await db.client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 1, 'draft')", [revision_id, workspace_id, process_id]);
  const owner = { revision_id, process_id, workspace_id };
  const steps = source.steps.map((s) => ({ ...s, ...owner }));
  const edges = source.edges.map((e) => ({ ...e, ...owner }));
  // Every step in one statement, as a whole process is written; a group's first step is set after.
  await insert("steps", steps.map((s) => ({ ...s, entry_step_id: null })));
  for (const s of steps.filter((x) => x.kind === "group")) {
    await db.client.query("update steps set entry_step_id = $1 where revision_id = $2 and id = $3", [s.entry_step_id, revision_id, s.id]);
  }
  await insert("edges", edges);
  return { ...source, revision: { ...source.revision, id: revision_id, process_id }, process: { ...source.process, id: process_id }, steps, edges };
}

/** One multi-row INSERT, as one request to the database is: a group and its steps arrive in the same statement. */
async function insert(table: "steps" | "edges", rows: Row[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]!).filter((c) => c !== "replaced_by");
  const values = rows.map((_, r) => `(${cols.map((__, i) => `$${r * cols.length + i + 1}`).join(", ")})`).join(", ");
  await db.client.query(`insert into ${table} (${cols.join(", ")}) values ${values}`, rows.flatMap((row) => cols.map((c) => row[c])));
}

/** Save an edit one row at a time, as the app does. */
async function save(bundle: ProcessBundle, edit: Edit): Promise<void> {
  const revision = bundle.revision.id;
  for (const unit of saveUnits(edit)) {
    if (unit.kind === "insert") {
      await insert("steps", unit.steps as unknown as Row[]);
      await insert("edges", unit.edges as unknown as Row[]);
    } else if (unit.kind === "remove") {
      for (const e of unit.edges) await db.client.query("delete from edges where revision_id = $1 and id = $2", [revision, e.id]);
      for (const s of unit.steps) await db.client.query("delete from steps where revision_id = $1 and id = $2", [revision, s.id]);
    } else {
      const table = unit.change.table;
      for (const [field, value] of Object.entries(unit.change.after)) {
        await db.client.query(`update ${table} set ${field} = $1 where revision_id = $2 and id = $3`, [value, revision, unit.change.id]);
      }
    }
  }
}

async function stored(bundle: ProcessBundle) {
  const steps = (await db.client.query("select id, kind, parent_step_id, entry_step_id, x, y from steps where revision_id = $1 order by id", [bundle.revision.id])).rows;
  const edges = (await db.client.query("select id, from_step_id, to_step_id from edges where revision_id = $1 order by id", [bundle.revision.id])).rows;
  return {
    steps: steps.map((r) => ({ id: r.id, kind: r.kind, parent: r.parent_step_id, entry: r.entry_step_id, x: Number(r.x), y: Number(r.y) })),
    edges: edges.map((r) => ({ id: r.id, from: r.from_step_id, to: r.to_step_id })),
  };
}

const expected = (b: ProcessBundle) => ({
  steps: b.steps
    .map((s) => ({ id: s.id, kind: s.kind, parent: s.parent_step_id ?? null, entry: s.entry_step_id ?? null, x: Number(s.x), y: Number(s.y) }))
    .sort((a, c) => (a.id < c.id ? -1 : 1)),
  edges: b.edges.map((e) => ({ id: e.id, from: e.from_step_id, to: e.to_step_id })).sort((a, c) => (a.id < c.id ? -1 : 1)),
});

/** Run an edit (then its undo and redo) through the editor's model and through the database; both must end in the same place. */
async function checks(start: ProcessBundle, build: (b: ProcessBundle) => Edit): Promise<ProcessBundle> {
  const edit = build(start);
  const after = applyEdit(start, edit);
  const before = expected(start);
  await save(start, edit);
  expect(await stored(start)).toEqual(expected(after));
  // Undo, then redo, are saved the same way and must land back in the same two places.
  await save(start, invertEdit(edit));
  expect(await stored(start)).toEqual(before);
  await save(start, edit);
  expect(await stored(start)).toEqual(expected(after));
  return after;
}

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("the Editor's group edits against the database", () => {
  it("groups steps, in a group, and ungroups them again", async () => {
    let b = await seedDraft(demoBundle());
    let made = "";
    b = await checks(b, (cur) => {
      const g = groupSteps(cur, [ids.seo, ids.ppc, ids.live])!;
      made = g.id;
      return g.edit;
    });
    // A group inside a group, taking the outer group's first step with it.
    const nested = await seedDraft(withDemoGroups(demoBundle()));
    let inner = "";
    const withInner = await checks(nested, (cur) => {
      const g = groupSteps(cur, [ids.qualify])!;
      inner = g.id;
      return g.edit;
    });
    await checks(withInner, (cur) => ungroup(cur, inner)!);
    await checks(b, (cur) => ungroup(cur, made)!);
  });

  it("ungroups a group the process enters and leaves, and one that is another group's first step", async () => {
    const b = await seedDraft(withDemoGroups(demoBundle()));
    await checks(b, (cur) => ungroup(cur, DEMO_GROUP_IDS.setup)!);
    const c = await seedDraft(withDemoGroups(demoBundle()));
    await checks(c, (cur) => ungroup(cur, DEMO_GROUP_IDS.conversation)!);
  });

  it("adds steps after the selected step, at any depth", async () => {
    let b = await seedDraft(withDemoGroups(demoBundle()));
    b = await checks(b, (cur) => addAfter(cur, ids.seo, "task").edit);
    b = await checks(b, (cur) => addAfter(cur, ids.qualify, "decision").edit);
    b = await checks(b, (cur) => addAfter(cur, ids.audit, "wait").edit);
    // And a step inside a group inside a group.
    b = await checks(b, (cur) => groupSteps(cur, [ids.seo])!.edit);
    await checks(b, (cur) => addAfter(cur, ids.seo, "wait").edit);
  });
});

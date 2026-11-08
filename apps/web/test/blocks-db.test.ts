import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { northbeamStepIds as ids, type ProcessBundle } from "@transpera-flow/db";
import { DEMO_GROUP_IDS, withDemoGroups } from "@/lib/demo/nested";
import { blockFromGroup, insertBlock, readBlock, replaceWithBlock } from "@/lib/blocks/blocks";
import { groupSteps } from "@/lib/editor/groups";
import { applyEdit, invertEdit, saveUnits, type Edit } from "@/lib/editor/ops";
import { demoBundle } from "@/lib/sources/demo";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";

// The block library's edits (issue #116), saved the way the app saves them: one row at a time, each its own transaction (so no
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

describe("block inserts and replacements against the database", () => {
  it("inserts a block after a step, inside a group, and inside a group in a group", async () => {
    const block = blockFromGroup(withDemoGroups(demoBundle()), DEMO_GROUP_IDS.conversation)!;
    const b = await seedDraft(demoBundle());
    await checks(b, (cur) => insertBlock(cur, ids.audit, block, "Sales conversation")!.edit);
    const nested = await seedDraft(withDemoGroups(demoBundle()));
    const inGroup = await checks(nested, (cur) => insertBlock(cur, ids.seo, block, "Sales conversation")!.edit);
    // A block that holds a group, put inside a group inside a group.
    const deep = await checks(inGroup, (cur) => groupSteps(cur, [ids.ppc])!.edit);
    const holder = blockFromGroup(deep, DEMO_GROUP_IDS.setup)!;
    await checks(deep, (cur) => insertBlock(cur, ids.ppc, holder, "Set-up again")!.edit);
  });

  it("replaces a step, a group and a group's first step with a block", async () => {
    const block = blockFromGroup(withDemoGroups(demoBundle()), DEMO_GROUP_IDS.conversation)!;
    const flat = await seedDraft(demoBundle());
    await checks(flat, (cur) => replaceWithBlock(cur, ids.discovery, block, "Sales conversation")!.edit);
    const nested = await seedDraft(withDemoGroups(demoBundle()));
    await checks(nested, (cur) => replaceWithBlock(cur, DEMO_GROUP_IDS.setup, block, "Sales conversation")!.edit);
    const first = await seedDraft(withDemoGroups(demoBundle()));
    await checks(first, (cur) => replaceWithBlock(cur, ids.qualify, block, "Sales conversation")!.edit);
  });
  it("a block saved with base values stores them, and the steps it puts in are written with them (capacity P8)", async () => {
    const split = { automatable: 0.4, augmentable: 0.35, manual: 0.25 };
    const source = withDemoGroups(demoBundle());
    const withBase = { ...source, steps: source.steps.map((s) => (s.id === ids.qualify ? { ...s, split, tier_multiplier: { T1: 1.5 }, to_client_manager: true } : s)) };
    const bundle = blockFromGroup(withBase, DEMO_GROUP_IDS.conversation)!;
    const row = (
      await db.client.query("insert into blocks (workspace_id, name, description, type, steps) values ($1, 'Base values', '', 'manual', $2::jsonb) returning id, steps", [source.workspace.id, JSON.stringify(bundle)])
    ).rows[0];
    const block = readBlock(row.steps);
    expect(block.steps.find((s) => s.id === ids.qualify)!.split).toEqual(split);
    const draft = await seedDraft(demoBundle());
    const made = insertBlock(draft, ids.audit, block, "Base values", row.id)!;
    await save(draft, made.edit);
    const stored = (await db.client.query("select split, tier_multiplier, to_client_manager from steps where revision_id = $1 and name = 'Qualify lead' and id <> $2", [draft.revision.id, ids.qualify])).rows;
    expect(stored).toEqual([{ split, tier_multiplier: { T1: 1.5 }, to_client_manager: true }]);
    const group = (await db.client.query("select provenance from steps where revision_id = $1 and id = $2", [draft.revision.id, made.id])).rows[0];
    expect(group.provenance).toEqual({ block: row.id });
  });
});

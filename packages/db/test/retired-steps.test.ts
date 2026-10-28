import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkScenario } from "@transpera-flow/engine";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  NORTHBEAM_WORKSPACE_ID,
  isRetiredStep,
  northbeamBundle,
  northbeamScenarios,
  northbeamStepIds,
  partitionSteps,
  toEngineModel,
  type EdgeRow,
  type StepRow,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Retired steps (issue #16): splitting a step in a draft keeps the old row
// with `replaced_by`, as the editor's Server Actions write it (delete the
// step, insert its halves and the retired row). Publishing isn't blocked by
// it, the next draft copies it, and loaders keep it apart from the steps in
// use, so saved scenarios aimed at it can suggest what replaced it. No
// migration: `steps.replaced_by` has been there since the first one.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
const proc = NORTHBEAM_PROCESS_ID;
const ids = northbeamStepIds;

type Reply = Record<string, unknown> & { status: string };

async function commitAs<T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = db.client;
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

const rpc = async (c: pg.Client, fn: string, ...args: unknown[]): Promise<Reply> =>
  (await c.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r as Reply;

const rowsOf = async (revision: string) => ({
  steps: (await db.client.query("select * from steps where revision_id = $1", [revision])).rows as StepRow[],
  edges: (await db.client.query("select * from edges where revision_id = $1", [revision])).rows as EdgeRow[],
});

const insertRows = async (c: pg.Client, table: "steps" | "edges", rows: object[]) => {
  for (const row of rows) {
    const cols = Object.keys(row);
    const values = cols.map((k) => {
      const v = (row as Record<string, unknown>)[k];
      return v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v;
    });
    await c.query(`insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, values);
  }
};

beforeAll(async () => {
  db = await createTestDb();
  editor = await createUser(db, "editor@retired.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [NORTHBEAM_WORKSPACE_ID, editor.id]);
});

afterAll(async () => {
  await db?.close();
});

describe("retired steps", () => {
  const [a, b] = [randomUUID(), randomUUID()];

  it("split in a draft, published without being taken for an estimate, and copied into the next draft", async () => {
    const live = await rowsOf(NORTHBEAM_REVISION_ID);
    const old = live.steps.find((s) => s.id === ids.audit)!;
    const draft = (await commitAs(editor.claims, (c) => rpc(c, "open_draft", proc))).revision_id as string;
    const owner = { revision_id: draft, workspace_id: old.workspace_id, process_id: old.process_id };
    const pick = ({ created_at: _c, updated_at: _u, created_by: _b, ...rest }: Record<string, unknown>) => rest;
    const touching = live.edges.filter((e) => e.from_step_id === ids.audit || e.to_step_id === ids.audit);

    await commitAs(editor.claims, async (c) => {
      await c.query("delete from steps where revision_id = $1 and id = $2", [draft, ids.audit]);
      const half = { ...pick(old as unknown as Record<string, unknown>), ...owner, work_hours: 3 };
      await insertRows(c, "steps", [
        { ...half, id: a, name: "Audit" },
        { ...half, id: b, name: "Proposal" },
        { ...pick(old as unknown as Record<string, unknown>), ...owner, replaced_by: [a, b], assumption: false, conflict: false },
      ]);
      await insertRows(c, "edges", [
        ...touching.map((e) => ({
          ...pick(e as unknown as Record<string, unknown>),
          ...owner,
          from_step_id: e.from_step_id === ids.audit ? b : e.from_step_id,
          to_step_id: e.to_step_id === ids.audit ? a : e.to_step_id,
        })),
        { ...owner, id: randomUUID(), from_step_id: a, to_step_id: b, probability: 1 },
      ]);
    });

    expect(await commitAs(editor.claims, (c) => rpc(c, "publish_process", proc, false))).toMatchObject({ status: "published" });
    const next = (await commitAs(editor.claims, (c) => rpc(c, "open_draft", proc))).revision_id as string;
    const copied = (await rowsOf(next)).steps.find((s) => s.id === ids.audit)!;
    expect(copied.replaced_by).toEqual([a, b]);
    expect(isRetiredStep(copied)).toBe(true);
    expect(await commitAs(editor.claims, (c) => rpc(c, "discard_draft", proc))).toMatchObject({ status: "discarded" });
  });

  it("is kept apart by loaders, and names what replaced it for a scenario aimed at it", async () => {
    const { live_revision_id: liveId } = (await db.client.query("select live_revision_id from processes where id = $1", [proc])).rows[0];
    const stored = await rowsOf(liveId as string);
    const { steps, retired } = partitionSteps(stored.steps);
    expect(retired.map((s) => s.id)).toEqual([ids.audit]);
    expect(steps.every((s) => (s.replaced_by ?? []).length === 0)).toBe(true);
    const bundle = { ...northbeamBundle(), steps, edges: stored.edges, retired };
    const model = toEngineModel(bundle, { startDate: "2026-10-05" });
    const automate = northbeamScenarios().find((s) => s.name === "Automate proposals")!;
    const check = checkScenario(model, automate.patch, { [ids.audit]: { name: "Audit & proposal", replacedBy: [a, b] } });
    expect(check.status).toBe("needs_attention");
    expect(check.broken[0]!.replacements.map((r) => r.name)).toEqual(["Audit", "Proposal"]);
  });
});

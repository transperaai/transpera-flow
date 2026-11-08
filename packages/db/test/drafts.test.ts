import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamBundle,
  northbeamStepIds,
  toEngineModel,
  type EdgeRow,
  type ProcessBundle,
  type StepRow,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Draft mode (issue #9, migration 20261006000000_drafts.sql), as signed-in
// users under RLS: open_draft copies live into one draft with the same ids,
// edits go to the draft only, publish_process and discard_draft, and the
// audit log. Tests in this file build on each other (they commit), so they
// run in order against their own database.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
const ids = northbeamStepIds;
const START = "2026-10-05";

type Reply = Record<string, unknown> & { status: string };

/** Run `fn` as a user and commit (unlike db.as, which rolls back). */
async function commitAs<T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>, client: pg.Client = db.client): Promise<T> {
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

const saveFields = (c: pg.Client, revision: string, table: string, id: string, base: object, changes: object) =>
  rpc(c, "save_fields", table, JSON.stringify({ revision_id: revision, id }), JSON.stringify(base), JSON.stringify(changes));

const processRow = async () =>
  (await db.client.query("select live_revision_id, draft_revision_id from processes where id = $1", [proc])).rows[0] as {
    live_revision_id: string;
    draft_revision_id: string | null;
  };

/** A revision's rows without bookkeeping columns, for comparing contents. */
async function revisionRows(revision: string) {
  const strip = ({ revision_id: _r, created_at: _c, updated_at: _u, created_by: _b, ...rest }: Record<string, unknown>) => rest;
  const steps = (await db.client.query("select * from steps where revision_id = $1 order by id", [revision])).rows.map(strip);
  const edges = (await db.client.query("select * from edges where revision_id = $1 order by id", [revision])).rows.map(strip);
  return { steps, edges };
}

/** What the simulation loads for a process's live model: the revision processes.live_revision_id points at. */
async function liveBundle(): Promise<ProcessBundle> {
  const { live_revision_id } = await processRow();
  const base = northbeamBundle();
  const steps = (await db.client.query("select * from steps where revision_id = $1", [live_revision_id])).rows as StepRow[];
  const edges = (await db.client.query("select * from edges where revision_id = $1", [live_revision_id])).rows as EdgeRow[];
  return { ...base, steps, edges };
}

const audit = async (action: string) =>
  (await db.client.query("select * from audit_log where action = $1 and target_id = $2 order by created_at, id", [action, proc])).rows;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["editor", "other", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@drafts.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [
      ws,
      users[role]!.id,
      role === "other" ? "editor" : role,
    ]);
  }
});

afterAll(async () => {
  await db?.close();
});

describe("draft mode", () => {
  let draft: string;

  it("refuses edits to the live revision", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await expect(saveFields(c, NORTHBEAM_REVISION_ID, "steps", ids.audit, { work_hours: 6 }, { work_hours: 9 })).rejects.toMatchObject({
        code: "55000",
      });
    });
    await db.as(users.editor!.claims, async (c) => {
      await expect(c.query("delete from edges where revision_id = $1", [NORTHBEAM_REVISION_ID])).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("gives viewers no draft", async () => {
    await db.as(users.viewer!.claims, async (c) => {
      expect(await rpc(c, "open_draft", proc)).toEqual({ status: "not_found" });
      expect(await rpc(c, "publish_process", proc, true)).toEqual({ status: "not_found" });
      expect(await rpc(c, "discard_draft", proc)).toEqual({ status: "not_found" });
    });
  });

  it("opens a draft as a copy of live with the same ids, and the next call continues it", async () => {
    const liveBefore = await revisionRows(NORTHBEAM_REVISION_ID);
    const opened = await commitAs(users.editor!.claims, (c) => rpc(c, "open_draft", proc));
    expect(opened).toMatchObject({ status: "ok", number: 2, created: true });
    draft = opened.revision_id as string;
    expect(await processRow()).toEqual({ live_revision_id: NORTHBEAM_REVISION_ID, draft_revision_id: draft });
    expect(await revisionRows(draft)).toEqual(liveBefore);
    const again = await commitAs(users.other!.claims, (c) => rpc(c, "open_draft", proc));
    expect(again).toEqual({ status: "ok", revision_id: draft, number: 2, created: false });

    const [entry] = await audit("open_draft");
    expect(entry).toMatchObject({ workspace_id: ws, actor_id: users.editor!.id, actor_kind: "user", target_table: "processes" });
    expect(entry.diff).toMatchObject({ revision_id: draft, number: 2, from_revision_id: NORTHBEAM_REVISION_ID, from_number: 1 });
  });

  it("edits go to the draft; the live revision and live runs are unchanged", async () => {
    const liveRows = await revisionRows(NORTHBEAM_REVISION_ID);
    const liveModel = toEngineModel(await liveBundle(), { startDate: START });
    const liveRun = simulate(liveModel, 5, 1);
    const added = randomUUID();

    await commitAs(users.editor!.claims, async (c) => {
      expect((await saveFields(c, draft, "steps", ids.audit, { work_hours: 6 }, { work_hours: 12 })).status).toBe("saved");
      await c.query(
        "insert into steps (id, revision_id, workspace_id, process_id, name, kind, role_id, work_hours, x, y) values ($1, $2, $3, $4, 'Send welcome pack', 'task', null, 1, 0, 0)",
        [added, draft, ws, proc],
      );
      await c.query("delete from steps where revision_id = $1 and id = $2", [draft, ids.ppc]);
    });

    expect(await revisionRows(NORTHBEAM_REVISION_ID)).toEqual(liveRows);
    expect(toEngineModel(await liveBundle(), { startDate: START })).toEqual(liveModel);
    expect(simulate(toEngineModel(await liveBundle(), { startDate: START }), 5, 1).kpi).toEqual(liveRun.kpi);
    // The draft itself simulates differently (a slower audit), so the check above means something.
    const draftSteps = (await db.client.query("select * from steps where revision_id = $1", [draft])).rows as StepRow[];
    expect(draftSteps.find((s) => s.id === ids.audit)!.work_hours).toBe("12");
    expect(draftSteps.some((s) => s.id === ids.ppc)).toBe(false);
  });

  it("publishing is refused while steps are unresolved assumptions, unless accepted as estimates", async () => {
    await commitAs(users.editor!.claims, async (c) => {
      expect((await saveFields(c, draft, "steps", ids.seo, { assumption: false }, { assumption: true })).status).toBe("saved");
    });
    const refused = await commitAs(users.editor!.claims, (c) => rpc(c, "publish_process", proc, false));
    expect(refused).toEqual({
      status: "unresolved",
      steps: [{ id: ids.seo, name: "SEO campaign setup", assumption: true, conflict: false }],
    });
    expect(await processRow()).toEqual({ live_revision_id: NORTHBEAM_REVISION_ID, draft_revision_id: draft });
    expect(await audit("publish")).toEqual([]);

    const published = await commitAs(users.other!.claims, (c) => rpc(c, "publish_process", proc, true));
    expect(published).toMatchObject({ status: "published", revision_id: draft, number: 2, previous_revision_id: NORTHBEAM_REVISION_ID });
    const revisions = (
      await db.client.query("select id, number, status, published_by from process_revisions where process_id = $1 order by number", [proc])
    ).rows;
    expect(revisions).toEqual([
      { id: NORTHBEAM_REVISION_ID, number: 1, status: "superseded", published_by: null },
      { id: draft, number: 2, status: "published", published_by: users.other!.id },
    ]);
    expect(await processRow()).toEqual({ live_revision_id: draft, draft_revision_id: null });

    const [entry] = await audit("publish");
    expect(entry).toMatchObject({ actor_id: users.other!.id, actor_kind: "user", target_table: "processes", target_id: proc });
    expect(entry.diff).toMatchObject({
      revision_id: draft,
      number: 2,
      previous_revision_id: NORTHBEAM_REVISION_ID,
      previous_number: 1,
      accept_estimates: true,
      estimates: [{ id: ids.seo, name: "SEO campaign setup", assumption: true, conflict: false }],
    });
    const changes = entry.diff.changes;
    expect(changes.steps.added).toHaveLength(1);
    expect(changes.steps.removed).toEqual([ids.ppc]);
    expect(changes.steps.changed).toEqual([ids.audit, ids.seo].sort());
    // The PPC step's edges went with it.
    expect(changes.edges.removed.length).toBeGreaterThan(0);

    // Live runs now use the published revision.
    expect((await liveBundle()).steps.find((s) => s.id === ids.audit)!.work_hours).toBe("12");
    // The superseded revision is fixed too.
    await db.as(users.editor!.claims, async (c) => {
      await expect(saveFields(c, draft, "steps", ids.audit, { work_hours: 12 }, { work_hours: 1 })).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("the next draft is numbered 3; discarding it leaves live as it was", async () => {
    const liveRows = await revisionRows(draft);
    const opened = await commitAs(users.editor!.claims, (c) => rpc(c, "open_draft", proc));
    expect(opened).toMatchObject({ status: "ok", number: 3, created: true });
    const next = opened.revision_id as string;
    await commitAs(users.editor!.claims, async (c) => {
      expect((await saveFields(c, next, "steps", ids.audit, { name: "Audit & proposal" }, { name: "Audit" })).status).toBe("saved");
    });
    expect(await commitAs(users.editor!.claims, (c) => rpc(c, "discard_draft", proc))).toEqual({ status: "discarded", revision_id: next });
    expect(await processRow()).toEqual({ live_revision_id: draft, draft_revision_id: null });
    expect((await db.client.query("select count(*)::int as n from steps where revision_id = $1", [next])).rows[0].n).toBe(0);
    expect(await revisionRows(draft)).toEqual(liveRows);
    expect((await audit("discard_draft")).map((e) => e.diff)).toEqual([{ revision_id: next, number: 3 }]);
    expect(await commitAs(users.editor!.claims, (c) => rpc(c, "discard_draft", proc))).toEqual({ status: "no_draft" });
    expect(await commitAs(users.editor!.claims, (c) => rpc(c, "publish_process", proc, false))).toEqual({ status: "no_draft" });
  });

  it("two editors opening a draft at once end up in the same one", async () => {
    const a = new pg.Client({ connectionString: db.url });
    const b = new pg.Client({ connectionString: db.url });
    await Promise.all([a.connect(), b.connect()]);
    try {
      await a.query("begin");
      await a.query("set local role authenticated");
      await a.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(users.editor!.claims)]);
      const first = await rpc(a, "open_draft", proc);
      // B blocks on the process row until A commits, then finds A's draft.
      const second = commitAs(users.other!.claims, (c) => rpc(c, "open_draft", proc), b);
      await new Promise((r) => setTimeout(r, 100));
      await a.query("commit");
      expect(first).toMatchObject({ status: "ok", created: true });
      expect(await second).toEqual({ ...first, created: false });
      const drafts = await db.client.query("select count(*)::int as n from process_revisions where process_id = $1 and status = 'draft'", [
        proc,
      ]);
      expect(drafts.rows[0].n).toBe(1);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it("allows at most one draft per process even without open_draft", async () => {
    await expect(
      db.client.query("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 99, 'draft')", [ws, proc]),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

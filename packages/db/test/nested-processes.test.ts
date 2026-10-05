import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Processes inside processes (issue #102, migration 20261108000000): groups
// (a step holding steps), child processes (a step holding a process), the
// process tree, and the rules that keep both acyclic, as the database enforces
// them. The tree rules are checked when a transaction commits, so a group and
// its steps can be written in any order.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let viewer: { id: string; claims: Record<string, unknown> };
const ws = NORTHBEAM_WORKSPACE_ID;
let otherWs: string;

type Row = Record<string, unknown>;

/** Run `fn` as the admin connection in one transaction that commits at the end (so deferred checks run). */
async function commit<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = db.client;
  await c.query("begin");
  try {
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback").catch(() => undefined);
    throw err;
  }
}

async function commitAs<T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = db.client;
  await c.query("begin");
  try {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback").catch(() => undefined);
    throw err;
  }
}

async function newProcess(workspace = ws, parent: string | null = null, name = "Nested"): Promise<{ proc: string; rev: string }> {
  const proc = randomUUID();
  const rev = randomUUID();
  await db.client.query("insert into processes (id, workspace_id, name, parent_process_id) values ($1, $2, $3, $4)", [proc, workspace, name, parent]);
  await db.client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 1, 'draft')", [rev, workspace, proc]);
  return { proc, rev };
}

interface StepInput {
  id?: string;
  kind?: string;
  name?: string;
  parent?: string | null;
  entry?: string | null;
  child?: string | null;
  work?: number;
  outcome?: string | null;
  x?: number;
  y?: number;
}

async function addStep(c: pg.Client, p: { proc: string; rev: string }, s: StepInput, workspace = ws): Promise<string> {
  const id = s.id ?? randomUUID();
  await c.query(
    `insert into steps (id, revision_id, workspace_id, process_id, name, kind, outcome, work_hours, parent_step_id, entry_step_id, child_process_id, x, y)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, p.rev, workspace, p.proc, s.name ?? "Step", s.kind ?? "task", s.outcome ?? null, s.work ?? 0, s.parent ?? null, s.entry ?? null, s.child ?? null, s.x ?? 0, s.y ?? 0],
  );
  return id;
}

const stepRow = async (rev: string, id: string) => (await db.client.query("select * from steps where revision_id = $1 and id = $2", [rev, id])).rows[0] as Row | undefined;

beforeAll(async () => {
  db = await createTestDb();
  editor = await createUser(db, "editor@nested.example.com");
  viewer = await createUser(db, "viewer@nested.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ws, editor.id, viewer.id]);
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Elsewhere', 'elsewhere-nested') returning id")).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

describe("existing processes are untouched", () => {
  it("has no parent on any seeded process or step", async () => {
    const p = await db.client.query("select count(*)::int n from processes where parent_process_id is not null");
    const s = await db.client.query("select count(*)::int n from steps where (parent_step_id is not null or entry_step_id is not null or child_process_id is not null) and process_id not in (select id from processes where is_company)");
    expect(p.rows[0].n).toBe(0);
    expect(s.rows[0].n).toBe(0);
  });
});

describe("groups", () => {
  it("holds steps, at any depth, written in any order", async () => {
    const p = await newProcess();
    const [outer, inner, a, b] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await commit(async (c) => {
      // Children before their groups, and a group's entry before the step exists.
      await addStep(c, p, { id: a, name: "A", parent: inner, x: 10, y: 10 });
      await addStep(c, p, { id: b, name: "B", parent: inner, x: 150, y: 10 });
      await addStep(c, p, { id: inner, name: "Inner", kind: "group", parent: outer, entry: a });
      await addStep(c, p, { id: outer, name: "Outer", kind: "group", entry: inner });
    });
    const rows = (await db.client.query("select name, parent_step_id, entry_step_id from steps where revision_id = $1 order by name", [p.rev])).rows;
    expect(rows).toEqual([
      { name: "A", parent_step_id: inner, entry_step_id: null },
      { name: "B", parent_step_id: inner, entry_step_id: null },
      { name: "Inner", parent_step_id: outer, entry_step_id: a },
      { name: "Outer", parent_step_id: null, entry_step_id: inner },
    ]);
  });

  it("refuses a step inside something that is not a group", async () => {
    const p = await newProcess();
    const task = await addStep(db.client, p, { name: "Task" });
    await expect(commit((c) => addStep(c, p, { name: "Child", parent: task }))).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("only sit inside a group") });
  });

  it("refuses a loop of groups, however long", async () => {
    const p = await newProcess();
    const [a, b, c3] = [randomUUID(), randomUUID(), randomUUID()];
    await expect(
      commit(async (c) => {
        await addStep(c, p, { id: a, name: "GA", kind: "group", parent: c3 });
        await addStep(c, p, { id: b, name: "GB", kind: "group", parent: a });
        await addStep(c, p, { id: c3, name: "GC", kind: "group", parent: b });
      }),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("inside itself") });
    // Closing a loop with an update is refused too.
    const ok = await newProcess();
    const [x, y] = [randomUUID(), randomUUID()];
    await commit(async (c) => {
      await addStep(c, ok, { id: x, name: "GX", kind: "group" });
      await addStep(c, ok, { id: y, name: "GY", kind: "group", parent: x });
    });
    await expect(commit((c) => c.query("update steps set parent_step_id = $3 where revision_id = $1 and id = $2", [ok.rev, x, y]))).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a step inside itself", async () => {
    const p = await newProcess();
    const id = randomUUID();
    await expect(commit((c) => addStep(c, p, { id, kind: "group", parent: id }))).rejects.toMatchObject({ code: "23514", constraint: "steps_nesting_shape" });
  });

  it("refuses a parent in another revision", async () => {
    const p = await newProcess();
    const q = await newProcess();
    const g = await addStep(db.client, q, { kind: "group", name: "Elsewhere" });
    // The foreign key and the tree check both refuse it at commit; either may report first.
    await expect(commit((c) => addStep(c, p, { name: "Child", parent: g }))).rejects.toThrow();
  });

  it("keeps start and end steps at the top level", async () => {
    const p = await newProcess();
    const g = await addStep(db.client, p, { kind: "group", name: "Box" });
    await expect(addStep(db.client, p, { kind: "start", name: "Start", parent: g })).rejects.toMatchObject({ code: "23514", constraint: "steps_nesting_shape" });
    await expect(addStep(db.client, p, { kind: "end", name: "Won", outcome: "won", parent: g })).rejects.toMatchObject({ code: "23514", constraint: "steps_nesting_shape" });
  });

  it("needs the entry to be one of the group's own steps", async () => {
    const p = await newProcess();
    const g = randomUUID();
    const mine = randomUUID();
    const stranger = await addStep(db.client, p, { name: "Not inside" });
    await expect(
      commit(async (c) => {
        await addStep(c, p, { id: g, kind: "group", name: "Box", entry: stranger });
        await addStep(c, p, { id: mine, name: "Mine", parent: g });
      }),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("first step of group") });
    // A step that doesn't exist at all is a foreign key violation.
    await expect(commit((c) => addStep(c, p, { kind: "group", name: "Ghost entry", entry: randomUUID() }))).rejects.toThrow();
    // And only groups have an entry.
    await expect(addStep(db.client, p, { name: "Task with entry", entry: mine })).rejects.toMatchObject({ code: "23514", constraint: "steps_nesting_shape" });
  });

  it("has no work of its own: the engine would ignore it", async () => {
    const p = await newProcess();
    await expect(addStep(db.client, p, { kind: "group", name: "Box", work: 2 })).rejects.toMatchObject({ code: "23514", constraint: "steps_holder_has_no_work" });
    await expect(db.client.query("insert into steps (revision_id, workspace_id, process_id, name, kind, wait_hours) values ($1, $2, $3, 'Box', 'group', 1)", [p.rev, ws, p.proc])).rejects.toMatchObject({
      constraint: "steps_holder_has_no_work",
    });
  });

  it("can't stop being a group while it holds steps", async () => {
    const p = await newProcess();
    const g = randomUUID();
    await commit(async (c) => {
      await addStep(c, p, { id: g, kind: "group", name: "Box" });
      await addStep(c, p, { name: "In", parent: g });
    });
    await expect(commit((c) => c.query("update steps set kind = 'task' where revision_id = $1 and id = $2", [p.rev, g]))).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("must stay a group"),
    });
  });

  it("takes its steps with it when deleted", async () => {
    const p = await newProcess();
    const g = randomUUID();
    await commit(async (c) => {
      await addStep(c, p, { id: g, kind: "group", name: "Box" });
      await addStep(c, p, { name: "In", parent: g });
    });
    await db.client.query("delete from steps where revision_id = $1 and id = $2", [p.rev, g]);
    expect((await db.client.query("select count(*)::int n from steps where revision_id = $1", [p.rev])).rows[0].n).toBe(0);
  });

  it("lets edges reach a group and leave steps inside it", async () => {
    const p = await newProcess();
    const g = randomUUID();
    const a = randomUUID();
    const after = randomUUID();
    await commit(async (c) => {
      await addStep(c, p, { id: g, kind: "group", name: "Box", entry: a });
      await addStep(c, p, { id: a, name: "In", parent: g });
      await addStep(c, p, { id: after, name: "After" });
    });
    await db.client.query("insert into edges (revision_id, workspace_id, process_id, from_step_id, to_step_id) values ($1, $2, $3, $4, $5), ($1, $2, $3, $6, $7)", [p.rev, ws, p.proc, after, g, a, after]);
    expect((await db.client.query("select count(*)::int n from edges where revision_id = $1", [p.rev])).rows[0].n).toBe(2);
  });
});

describe("child processes", () => {
  it("hangs a process from a step of its parent, to any depth", async () => {
    const top = await newProcess(ws, null, "Company: Sales");
    const mid = await newProcess(ws, top.proc, "Sales: Qualify");
    const leaf = await newProcess(ws, mid.proc, "Qualify: Check fit");
    await commit(async (c) => {
      await addStep(c, top, { name: "Qualify", kind: "subprocess", child: mid.proc });
      await addStep(c, mid, { name: "Check fit", kind: "subprocess", child: leaf.proc });
    });
    const tree = await db.client.query(
      `with recursive t(id, name, depth) as (
         select id, name, 0 from processes where id = $1
         union all select p.id, p.name, t.depth + 1 from processes p join t on p.parent_process_id = t.id)
       select name, depth from t order by depth`,
      [top.proc],
    );
    expect(tree.rows.map((r) => `${r.depth}:${r.name}`)).toEqual(["0:Company: Sales", "1:Sales: Qualify", "2:Qualify: Check fit"]);
  });

  it("refuses a process inside itself, or inside its own descendant", async () => {
    const a = await newProcess(ws, null, "Loop A");
    const b = await newProcess(ws, a.proc, "Loop B");
    const c = await newProcess(ws, b.proc, "Loop C");
    await expect(db.client.query("update processes set parent_process_id = id where id = $1", [a.proc])).rejects.toMatchObject({ code: "23514" });
    await expect(db.client.query("update processes set parent_process_id = $2 where id = $1", [a.proc, c.proc])).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("cannot sit inside itself"),
    });
    await expect(db.client.query("update processes set parent_process_id = $2 where id = $1", [a.proc, b.proc])).rejects.toMatchObject({ code: "23514" });
    // Moving down the tree without a loop is fine.
    await db.client.query("update processes set parent_process_id = null where id = $1", [c.proc]);
  });

  it("keeps a child in its parent's workspace", async () => {
    const a = await newProcess(ws, null, "Home");
    const stranger = await newProcess(otherWs, null, "Away");
    await expect(db.client.query("update processes set parent_process_id = $2 where id = $1", [stranger.proc, a.proc])).rejects.toMatchObject({ code: "23503" });
    await expect(commit((c) => addStep(c, a, { kind: "subprocess", name: "Holds a stranger", child: stranger.proc }))).rejects.toMatchObject({ code: "23503" });
  });

  it("makes a child top-level again when its parent is deleted", async () => {
    const parent = await newProcess(ws, null, "Doomed");
    const child = await newProcess(ws, parent.proc, "Survivor");
    await db.client.query("delete from processes where id = $1", [parent.proc]);
    const row = (await db.client.query("select parent_process_id, workspace_id from processes where id = $1", [child.proc])).rows[0];
    expect(row).toEqual({ parent_process_id: null, workspace_id: ws });
  });

  it("lets a draft link any other process (B12), but never itself", async () => {
    const top = await newProcess(ws, null, "Holder");
    const unrelated = await newProcess(ws, null, "Unrelated");
    // Its parent column is not this process: a link is still allowed in a draft (publishing checks where it already sits).
    await expect(commit((c) => addStep(c, top, { kind: "subprocess", name: "Linked", child: unrelated.proc }))).resolves.toBeDefined();
    await expect(commit((c) => addStep(c, top, { kind: "subprocess", name: "Self", child: top.proc }))).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("can't hold itself or the company map"),
    });
  });

  it("is held by one step per revision, and only by a subprocess step", async () => {
    const top = await newProcess(ws, null, "One holder");
    const child = await newProcess(ws, top.proc, "Held once");
    await addStep(db.client, top, { kind: "subprocess", name: "First", child: child.proc });
    await expect(addStep(db.client, top, { kind: "subprocess", name: "Second", child: child.proc })).rejects.toMatchObject({ code: "23505" });
    await expect(addStep(db.client, top, { kind: "task", name: "Task", child: child.proc })).rejects.toMatchObject({ code: "23514", constraint: "steps_nesting_shape" });
    // A holder has no work of its own.
    const other = await newProcess(ws, top.proc, "Other child");
    await expect(addStep(db.client, top, { kind: "subprocess", name: "Busy", child: other.proc, work: 3 })).rejects.toMatchObject({ constraint: "steps_holder_has_no_work" });
  });

  it("can't be moved away from the step that holds it", async () => {
    const top = await newProcess(ws, null, "Anchored");
    const child = await newProcess(ws, top.proc, "Anchored child");
    await commit((c) => addStep(c, top, { kind: "subprocess", name: "Holds it", child: child.proc }));
    await expect(db.client.query("update processes set parent_process_id = null where id = $1", [child.proc])).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("held by a step"),
    });
  });

  it("leaves a holder step as a plain subprocess step when its child is deleted", async () => {
    const top = await newProcess(ws, null, "Keeps holder");
    const child = await newProcess(ws, top.proc, "Goes away");
    const holder = await commit((c) => addStep(c, top, { kind: "subprocess", name: "Holder", child: child.proc }));
    await db.client.query("delete from processes where id = $1", [child.proc]);
    expect(await stepRow(top.rev, holder)).toMatchObject({ kind: "subprocess", child_process_id: null });
  });
});

describe("drafts of nested processes", () => {
  it("open_draft copies groups, entries and child links with the same ids", async () => {
    const top = await newProcess(ws, null, "Draft me");
    const child = await newProcess(ws, top.proc, "Draft child");
    const [g, a, b, holder] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await commit(async (c) => {
      await addStep(c, top, { id: g, kind: "group", name: "Box", entry: a, x: 20, y: 20 });
      await addStep(c, top, { id: a, name: "A", parent: g, work: 1, x: 5, y: 5 });
      await addStep(c, top, { id: b, name: "B", parent: g, work: 2, x: 150, y: 5 });
      await addStep(c, top, { id: holder, kind: "subprocess", name: "Child here", child: child.proc });
    });
    // Publish it (as the table owner, the way the seed does), then open a draft as an editor.
    await db.client.query("update process_revisions set status = 'published', published_at = now() where id = $1", [top.rev]);
    await db.client.query("update processes set live_revision_id = $2 where id = $1", [top.proc, top.rev]);

    const opened = await commitAs(editor.claims, async (c) => (await c.query("select public.open_draft($1) as r", [top.proc])).rows[0].r as { status: string; revision_id: string });
    expect(opened.status).toBe("ok");
    const copied = (await db.client.query("select id, kind, parent_step_id, entry_step_id, child_process_id from steps where revision_id = $1 order by name", [opened.revision_id])).rows;
    expect(copied).toEqual(
      expect.arrayContaining([
        { id: g, kind: "group", parent_step_id: null, entry_step_id: a, child_process_id: null },
        { id: a, kind: "task", parent_step_id: g, entry_step_id: null, child_process_id: null },
        { id: b, kind: "task", parent_step_id: g, entry_step_id: null, child_process_id: null },
        { id: holder, kind: "subprocess", parent_step_id: null, entry_step_id: null, child_process_id: child.proc },
      ]),
    );
    expect(copied).toHaveLength(4);

    // Publishing the draft reports a changed group, not the whole process.
    const published = await commitAs(editor.claims, async (c) => (await c.query("select public.publish_process($1) as r", [top.proc])).rows[0].r as { status: string; changes: { steps: { changed: string[] } } });
    expect(published.status).toBe("published");
    expect(published.changes.steps.changed).toEqual([]);
  });
});

describe("row-level security", () => {
  it("lets an editor write groups and child processes, and a viewer only read them", async () => {
    const p = await newProcess();
    const g = randomUUID();
    await commitAs(editor.claims, async (c) => {
      await addStep(c, p, { id: g, kind: "group", name: "Editor's box" });
      await addStep(c, p, { name: "Editor's step", parent: g });
      await c.query("insert into processes (workspace_id, name, parent_process_id) values ($1, 'Editor child', $2)", [ws, p.proc]);
    });
    await expect(commitAs(viewer.claims, (c) => addStep(c, p, { name: "Viewer's step", parent: g }))).rejects.toMatchObject({ code: "42501" });
    await expect(commitAs(viewer.claims, (c) => c.query("insert into processes (workspace_id, name, parent_process_id) values ($1, 'Viewer child', $2)", [ws, p.proc]))).rejects.toMatchObject({ code: "42501" });
    const seen = await db.as(viewer.claims, async (c) => (await c.query("select count(*)::int n from steps where revision_id = $1 and parent_step_id = $2", [p.rev, g])).rows[0].n);
    expect(seen).toBe(1);
    const children = await db.as(viewer.claims, async (c) => (await c.query("select name from processes where parent_process_id = $1", [p.proc])).rows);
    expect(children).toEqual([{ name: "Editor child" }]);
  });

  it("hides nested steps and child processes from other workspaces' members", async () => {
    const stranger = await createUser(db, "stranger@nested.example.com");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [otherWs, stranger.id]);
    const p = await newProcess();
    const g = randomUUID();
    await commit(async (c) => {
      await addStep(c, p, { id: g, kind: "group", name: "Private box" });
      await addStep(c, p, { name: "Private step", parent: g });
    });
    const steps = await db.as(stranger.claims, async (c) => (await c.query("select id from steps where revision_id = $1", [p.rev])).rows);
    expect(steps).toEqual([]);
    // Nor can they write into it by pointing at its group.
    await expect(commitAs(stranger.claims, (c) => addStep(c, p, { name: "Intruder", parent: g }))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("deleting a parent process", () => {
  it("frees its child even when a step of the parent holds it", async () => {
    const top = await newProcess(ws, null, "Held parent");
    const child = await newProcess(ws, top.proc, "Held child");
    await commit((c) => addStep(c, top, { kind: "subprocess", name: "Holds child", child: child.proc }));
    await db.client.query("delete from processes where id = $1", [top.proc]);
    const row = (await db.client.query("select parent_process_id from processes where id = $1", [child.proc])).rows[0];
    expect(row).toEqual({ parent_process_id: null });
  });
});

describe("rules checked at commit see the final rows", () => {
  it("lets a group and its step be inserted and the group deleted in one transaction", async () => {
    const p = await newProcess();
    const g = randomUUID();
    await commit(async (c) => {
      await addStep(c, p, { id: g, kind: "group", name: "Short-lived" });
      await addStep(c, p, { name: "Inside", parent: g });
      await c.query("delete from steps where revision_id = $1 and id = $2", [p.rev, g]);
    });
    expect((await db.client.query("select count(*)::int n from steps where revision_id = $1", [p.rev])).rows[0].n).toBe(0);
  });

  it("lets a step move into a group, out again, and the group become a task, in one transaction", async () => {
    const p = await newProcess();
    const g = randomUUID();
    const s = randomUUID();
    await commit(async (c) => {
      await addStep(c, p, { id: g, kind: "group", name: "Box" });
      await addStep(c, p, { id: s, name: "Mover" });
    });
    await commit(async (c) => {
      await c.query("update steps set parent_step_id = $3 where revision_id = $1 and id = $2", [p.rev, s, g]);
      await c.query("update steps set parent_step_id = null where revision_id = $1 and id = $2", [p.rev, s]);
      await c.query("update steps set kind = 'task' where revision_id = $1 and id = $2", [p.rev, g]);
    });
    expect(await stepRow(p.rev, g)).toMatchObject({ kind: "task" });
  });

  it("refuses to move a group's first step out of it", async () => {
    const p = await newProcess();
    const g = randomUUID();
    const a = randomUUID();
    await commit(async (c) => {
      await addStep(c, p, { id: g, kind: "group", name: "Box", entry: a });
      await addStep(c, p, { id: a, name: "First", parent: g });
    });
    await expect(commit((c) => c.query("update steps set parent_step_id = null where revision_id = $1 and id = $2", [p.rev, a]))).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("first step of a group"),
    });
    // Changing the group's first step in the same transaction is fine.
    const b = randomUUID();
    await commit(async (c) => {
      await addStep(c, p, { id: b, name: "Second", parent: g });
      await c.query("update steps set entry_step_id = $3 where revision_id = $1 and id = $2", [p.rev, g, b]);
      await c.query("update steps set parent_step_id = null where revision_id = $1 and id = $2", [p.rev, a]);
    });
    expect(await stepRow(p.rev, g)).toMatchObject({ entry_step_id: b });
  });

  it("lets a child process move out once only a superseded revision holds it", async () => {
    const top = await newProcess(ws, null, "History parent");
    const child = await newProcess(ws, top.proc, "History child");
    await commit((c) => addStep(c, top, { kind: "subprocess", name: "Held then", child: child.proc }));
    await db.client.query("update process_revisions set status = 'published', published_at = now() where id = $1", [top.rev]);
    await expect(db.client.query("update processes set parent_process_id = null where id = $1", [child.proc])).rejects.toMatchObject({ code: "23514" });
    await db.client.query("update process_revisions set status = 'superseded' where id = $1", [top.rev]);
    await db.client.query("update processes set parent_process_id = null where id = $1", [child.proc]);
    expect((await db.client.query("select parent_process_id from processes where id = $1", [child.proc])).rows[0]).toEqual({ parent_process_id: null });
  });

  it("takes the holder's process from its revision, not from the step's own process_id", async () => {
    const top = await newProcess(ws, null, "Real owner");
    const other = await newProcess(ws, null, "Some other process");
    const child = await newProcess(ws, top.proc, "Real child");
    // The step says it belongs to another process, but its revision is the real owner's: fine.
    await commit((c) => addStep(c, { proc: other.proc, rev: top.rev }, { kind: "subprocess", name: "Right revision", child: child.proc }));
    // The step says it belongs to the real owner, but its revision is the child's own: the child would hold itself, refused.
    await expect(commit((c) => addStep(c, { proc: top.proc, rev: child.rev }, { kind: "subprocess", name: "Wrong revision", child: child.proc }))).rejects.toMatchObject({ code: "23514" });
  });
});

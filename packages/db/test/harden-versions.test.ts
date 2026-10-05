import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Versions and provenance hardened for every process (issue #171, migration 20261128500000): a signed-in editor, writing the
// tables directly as PostgREST would, can't rewrite history or provenance; the functions the app calls still work. Made with
// Supabase's default table privileges, as production is.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;

type Reply = Record<string, unknown> & { status: string };

const rpc = async (c: pg.Client, fn: string, ...args: unknown[]): Promise<Reply> =>
  (await c.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r as Reply;

async function commitAs<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(editor.claims)]);
    const out = await fn(db.client);
    await db.client.query("commit");
    return out;
  } catch (err) {
    await db.client.query("rollback");
    throw err;
  }
}

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;
const asEditor = <T>(fn: (c: pg.Client) => Promise<T>) => db.as(editor.claims, fn);

/** The statement is refused for the editor: nothing changes (the transaction is rolled back after the check). */
const refused = (sql: string, params: unknown[] = [], message?: RegExp) =>
  expect(asEditor((c) => c.query(sql, params))).rejects.toThrow(message ?? /./);

let v1: string; // superseded
let v2: string; // published, live
let v3: string; // the open draft

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@harden.example.com");
  await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [ws, editor.id]);
  v1 = NORTHBEAM_REVISION_ID;
  v2 = (await commitAs((c) => rpc(c, "open_draft", proc))).revision_id as string;
  expect((await commitAs((c) => rpc(c, "publish_process", proc, true))).status).toBe("published");
  v3 = (await commitAs((c) => rpc(c, "open_draft", proc))).revision_id as string;
});

afterAll(async () => {
  await db?.close();
});

describe("the flows the app uses still work for an editor", () => {
  it("opened, published and left v1 superseded, v2 live, v3 as the draft", async () => {
    const [p] = await q("select live_revision_id, draft_revision_id from processes where id = $1", [proc]);
    expect(p).toEqual({ live_revision_id: v2, draft_revision_id: v3 });
    const status = Object.fromEntries((await q("select id, status from process_revisions where process_id = $1", [proc])).map((r) => [r.id, r.status]));
    expect(status).toEqual({ [v1]: "superseded", [v2]: "published", [v3]: "draft" });
  });

  it("discards a draft, restores a version and duplicates one", async () => {
    expect((await commitAs((c) => rpc(c, "discard_draft", proc))).status).toBe("discarded");
    expect((await q("select draft_revision_id from processes where id = $1", [proc]))[0].draft_revision_id).toBeNull();
    const restored = await commitAs((c) => rpc(c, "restore_version", proc, v1));
    expect(restored.status).toBe("restored");
    const copy = await commitAs((c) => rpc(c, "duplicate_version", v1, "Northbeam copy"));
    expect(copy.status).toBe("duplicated");
    const [dup] = await q("select draft_revision_id, live_revision_id from processes where id = $1", [copy.process_id]);
    expect(dup.draft_revision_id).toBe(copy.revision_id);
    // v3's draft was discarded and restore opened a new one: put the world back as the later tests expect (v2 live, one draft).
    v3 = (await q("select draft_revision_id from processes where id = $1", [proc]))[0].draft_revision_id as string;
    expect(v3).toBeTruthy();
  });

  it("publishes the restored draft, which supersedes v2", async () => {
    expect((await commitAs((c) => rpc(c, "publish_process", proc, true))).status).toBe("published");
    const [p] = await q("select live_revision_id, draft_revision_id from processes where id = $1", [proc]);
    expect(p.live_revision_id).toBe(v3);
    expect((await q("select status from process_revisions where id = $1", [v2]))[0].status).toBe("superseded");
    v2 = v3; // live now
    v3 = (await commitAs((c) => rpc(c, "open_draft", proc))).revision_id as string;
  });
});

describe("versions: history is kept (direct writes by an editor)", () => {
  it("refuses deleting a superseded or a published version", async () => {
    await refused("delete from public.process_revisions where id = $1", [v1], /Published versions are kept/);
    await refused("delete from public.process_revisions where id = $1", [v2], /Published versions are kept/);
  });

  it("refuses setting a published or superseded version back to a draft", async () => {
    await refused("update public.process_revisions set status = 'draft' where id = $1", [v2], /can't change status/);
    await refused("update public.process_revisions set status = 'draft' where id = $1", [v1], /can't change status/);
    await refused("update public.process_revisions set status = 'published' where id = $1", [v1], /can't change status/);
  });

  it("refuses editing a published version in place", async () => {
    await refused("update public.process_revisions set layout = '{}'::jsonb where id = $1", [v2], /can't change status/);
  });

  it("refuses inserting a version that is not a draft", async () => {
    for (const status of ["published", "superseded"]) {
      await refused(
        "insert into public.process_revisions (workspace_id, process_id, number, status) values ($1, $2, 99, $3)",
        [ws, proc, status],
        /starts as a draft/,
      );
    }
  });

  it("refuses publishing a draft directly while another version is published", async () => {
    await refused("update public.process_revisions set status = 'published' where id = $1", [v3], /one published version/);
  });

  it("still lets an editor insert, edit and delete a draft, and move a published version to superseded", async () => {
    const extra = randomUUID();
    const [scratch] = await q("insert into processes (workspace_id, name) values ($1, 'Scratch') returning id", [ws]);
    await asEditor(async (c) => {
      await c.query("insert into public.process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 99, 'draft')", [extra, ws, scratch.id]);
      await c.query("update public.process_revisions set layout = '{}'::jsonb where id = $1", [extra]);
      await c.query("delete from public.process_revisions where id = $1", [extra]);
      expect((await c.query("update public.process_revisions set status = 'superseded' where id = $1", [v2])).rowCount).toBe(1);
    });
  });
});

describe("processes: version pointers", () => {
  it("refuses pointing live at a superseded version or at a draft", async () => {
    await refused("update public.processes set live_revision_id = $1 where id = $2", [v1, proc], /published version/);
    await refused("update public.processes set live_revision_id = $1 where id = $2", [v3, proc], /published version/);
  });

  it("refuses clearing the live version", async () => {
    await refused("update public.processes set live_revision_id = null where id = $1", [proc], /keeps its live version/);
  });

  it("refuses pointing live or the draft at another process's version", async () => {
    const [other] = await q("insert into processes (workspace_id, name) values ($1, 'Other') returning id", [ws]);
    const [pub] = await q("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'draft') returning id", [ws, other.id]);
    await refused("update public.processes set draft_revision_id = $1 where id = $2", [pub.id, proc], /own drafts/);
    await q("update process_revisions set status = 'published' where id = $1", [pub.id]);
    await refused("update public.processes set live_revision_id = $1 where id = $2", [pub.id, proc], /published version/);
    await refused("update public.processes set draft_revision_id = $1 where id = $2", [pub.id, proc], /own drafts/);
  });

  it("refuses pointing the draft at a published version", async () => {
    await refused("update public.processes set draft_revision_id = $1 where id = $2", [v2, proc], /own drafts/);
  });

  it("allows what open_draft and discard_draft do: the draft pointer to its own draft, or cleared", async () => {
    await asEditor(async (c) => {
      await c.query("update public.processes set draft_revision_id = null where id = $1", [proc]);
      await c.query("update public.processes set draft_revision_id = $1 where id = $2", [v3, proc]);
    });
  });
});

describe("processes: provenance", () => {
  it("refuses changing created_by, created_at or source", async () => {
    await q("update processes set created_by = $1 where id = $2", [editor.id, proc]);
    await refused("update public.processes set created_by = $1 where id = $2", [randomUUID(), proc], /Who made a process/);
    await refused("update public.processes set created_by = null where id = $1", [proc], /Who made a process/);
    await refused("update public.processes set created_at = now() - interval '1 year' where id = $1", [proc], /Who made a process/);
    await refused("update public.processes set source = 'import' where id = $1", [proc], /Who made a process/);
  });

  it("refuses them together with an allowed change", async () => {
    await refused("update public.processes set name = 'Renamed', source = 'mcp' where id = $1", [proc], /Who made a process/);
  });

  it("still lets an editor edit the other columns", async () => {
    await asEditor(async (c) => {
      const r = await c.query("update public.processes set description = 'Edited' where id = $1", [proc]);
      expect(r.rowCount).toBe(1);
      await c.query("update public.processes set source = source, created_by = created_by where id = $1", [proc]);
    });
  });

  it("does not stop the system, the table owner or a deleted user's set null", async () => {
    await q("update processes set source = 'import' where id = $1", [proc]);
    await q("update processes set source = 'manual' where id = $1", [proc]);
    const user = await createUser(db, "leaver@harden.example.com");
    const [p] = await q("insert into processes (workspace_id, name, created_by) values ($1, 'Leaver', $2) returning id", [ws, user.id]);
    await q("delete from auth.users where id = $1", [user.id]);
    expect((await q("select created_by from processes where id = $1", [p.id]))[0].created_by).toBeNull();
  });
});

describe("the system is not refused", () => {
  it("lets the owner role delete a published version and cascade a process delete", async () => {
    const [p] = await q("insert into processes (workspace_id, name) values ($1, 'Doomed') returning id", [ws]);
    const [r] = await q("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'superseded') returning id", [ws, p.id]);
    expect((await q("select status from process_revisions where id = $1", [r.id]))[0].status).toBe("superseded");
    await q("delete from process_revisions where id = $1", [r.id]);
    const [r2] = await q("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'published') returning id", [ws, p.id]);
    await q("delete from processes where id = $1", [p.id]);
    expect(await q("select id from process_revisions where id = $1", [r2.id])).toHaveLength(0);
  });

  it("the guards are not executable by signed-in roles", async () => {
    const rows = await q(
      `select routine_name from information_schema.routine_privileges where routine_schema = 'private' and grantee in ('anon', 'authenticated', 'PUBLIC')
         and routine_name in ('version_rules_guard', 'process_rules_guard')`,
    );
    expect(rows).toEqual([]);
  });
});

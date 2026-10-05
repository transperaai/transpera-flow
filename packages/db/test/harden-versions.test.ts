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
let other: { id: string; claims: Record<string, unknown> };
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

/** Run the statements in one transaction as the editor and commit: the commit is refused (the deferred check or a guard). */
async function refusedChain(statements: [string, unknown[]][], message: RegExp) {
  await expect(
    commitAs(async (c) => {
      for (const [sql, params] of statements) await c.query(sql, params);
    }),
  ).rejects.toThrow(message);
}

let v1: string; // superseded
let v2: string; // published, live
let v3: string; // the open draft

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@harden.example.com");
  other = await createUser(db, "other@harden.example.com");
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
    // Even with the fields publish_process would write, the unique index allows one published version.
    await refused("update public.process_revisions set status = 'published', published_by = auth.uid(), published_at = now(), number = 99 where id = $1", [v3], /./);
  });

  it("refuses superseding a published version and changing anything else in the same update", async () => {
    const someone = other.id;
    await refused("update public.process_revisions set status = 'superseded', layout = '{\"x\":1}'::jsonb where id = $1", [v2], /kept as it was/);
    await refused("update public.process_revisions set status = 'superseded', number = 999 where id = $1", [v2], /kept as it was/);
    await refused("update public.process_revisions set status = 'superseded', published_by = $2 where id = $1", [v2, someone], /kept as it was/);
    await refused("update public.process_revisions set status = 'superseded', published_at = now() - interval '1 year' where id = $1", [v2], /kept as it was/);
    await refused("update public.process_revisions set status = 'superseded', created_by = $2 where id = $1", [v2, someone], /kept as it was/);
  });

  it("refuses a bare supersede of the live version when the transaction commits (the live pointer must follow)", async () => {
    await expect(commitAs((c) => c.query("update public.process_revisions set status = 'superseded' where id = $1", [v2]))).rejects.toThrow(/live version of a process is its published version/);
    expect((await q("select status from process_revisions where id = $1", [v2]))[0].status).toBe("published");
  });

  it("refuses publishing a draft with forged published_by, published_at or number, after superseding live", async () => {
    const someone = other.id;
    const publish = (set: string, params: unknown[] = []) =>
      refusedChain(
        [
          ["update public.process_revisions set status = 'superseded' where id = $1", [v2]],
          [`update public.process_revisions set status = 'published', ${set} where id = $1`, [v3, ...params]],
          ["update public.processes set live_revision_id = $1 where id = $2", [v3, proc]],
        ],
        /A draft is published by publishing it/,
      );
    await publish("published_by = $2, published_at = now(), number = 99", [someone]);
    await publish("published_by = auth.uid(), published_at = now() - interval '1 year', number = 99");
    await publish("published_by = auth.uid(), published_at = now(), number = 999");
    await publish("published_by = null, published_at = now(), number = 99");
  });

  it("refuses a draft's number, author and dates changing, and a forged draft insert", async () => {
    const someone = other.id;
    await refused("update public.process_revisions set number = 77 where id = $1", [v3], /number, author and dates/);
    await refused("update public.process_revisions set created_by = $2 where id = $1", [v3, someone], /number, author and dates/);
    await refused("update public.process_revisions set created_at = now() - interval '1 year' where id = $1", [v3], /number, author and dates/);
    await refused("update public.process_revisions set published_by = auth.uid() where id = $1", [v3], /number, author and dates/);
    const [scratch] = await q("insert into processes (workspace_id, name) values ($1, 'Scratch 2') returning id", [ws]);
    await refused("insert into public.process_revisions (workspace_id, process_id, number, created_by) values ($1, $2, 1, $3)", [ws, scratch.id, someone], /made by the person saving it/);
    await refused("insert into public.process_revisions (workspace_id, process_id, number, published_at) values ($1, $2, 1, now())", [ws, scratch.id], /made by the person saving it/);
    await refused("insert into public.process_revisions (workspace_id, process_id, number, created_at) values ($1, $2, 1, now() - interval '1 day')", [ws, scratch.id], /made by the person saving it/);
  });

  it("allows the whole of a publish written by hand (the audit trigger still records it): it is what publish_process does", async () => {
    // Documented, not a hole: the same writes publish_process makes. The version and pointer stay consistent and the audit entry is written.
    await commitAs(async (c) => {
      await c.query("update public.process_revisions set status = 'superseded' where id = $1", [v2]);
      await c.query(
        "update public.process_revisions set status = 'published', published_by = auth.uid(), published_at = now(), number = (select max(number) + 1 from public.process_revisions where process_id = $2 and id <> $1) where id = $1",
        [v3, proc],
      );
      await c.query("update public.processes set live_revision_id = $1, draft_revision_id = null where id = $2", [v3, proc]);
    });
    expect((await q("select live_revision_id from processes where id = $1", [proc]))[0].live_revision_id).toBe(v3);
    const [audit] = await q("select count(*)::int as n from audit_log where target_id = $1 and action = 'publish'", [proc]);
    expect(audit.n).toBeGreaterThan(0);
    // Put the world back: v2 live again as a new draft published by the function, v3 superseded.
    v2 = v3;
    v3 = (await commitAs((c) => rpc(c, "open_draft", proc))).revision_id as string;
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

describe("processes: insert", () => {
  it("refuses a process made with version pointers, or with a forged created_by or created_at", async () => {
    const someone = other.id;
    await refused("insert into public.processes (workspace_id, name, live_revision_id) values ($1, 'Forged', $2)", [ws, v2], /no versions yet/);
    await refused("insert into public.processes (workspace_id, name, draft_revision_id) values ($1, 'Forged', $2)", [ws, v3], /no versions yet/);
    await refused("insert into public.processes (workspace_id, name, created_by) values ($1, 'Forged', $2)", [ws, someone], /no versions yet/);
    await refused("insert into public.processes (workspace_id, name, created_at) values ($1, 'Forged', now() - interval '1 year')", [ws], /no versions yet/);
  });

  it("lets an editor make a process the ordinary way, and a version of it", async () => {
    await commitAs(async (c) => {
      const r = await c.query("insert into public.processes (workspace_id, name, source) values ($1, 'Fresh', 'mcp') returning id, created_by", [ws]);
      expect(r.rows[0].created_by).toBe(editor.id);
      await c.query("insert into public.process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'draft')", [ws, r.rows[0].id]);
    });
  });

  it("lets an editor delete a process with a published version (the cascade is the system's)", async () => {
    const [p] = await q("insert into processes (workspace_id, name) values ($1, 'To delete') returning id", [ws]);
    const [r] = await q("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'published') returning id", [ws, p.id]);
    await q("update processes set live_revision_id = $1 where id = $2", [r.id, p.id]);
    await commitAs((c) => c.query("delete from public.processes where id = $1", [p.id]));
    expect(await q("select id from process_revisions where id = $1", [r.id])).toHaveLength(0);
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
         and routine_name in ('version_rules_guard', 'version_pointer_check', 'process_rules_guard')`,
    );
    expect(rows).toEqual([]);
  });
});

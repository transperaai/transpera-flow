import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// B13 follow-ups (issue #166, migration 20261128000000): `import_new_process` writes a new process, its draft, steps and edges
// in one transaction, and `take_link_fetch` limits link fetches per user. Made with Supabase's default privileges, as production.

const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let viewer: { id: string; claims: Record<string, unknown> };
let other: { id: string; claims: Record<string, unknown> };

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@import-atomic.example.com");
  viewer = await createUser(db, "viewer@import-atomic.example.com");
  other = await createUser(db, "other@import-atomic.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ws, editor.id, viewer.id]);
});

afterAll(async () => {
  await db?.close();
});

// Every column the app's plan sets: rows are inserted like a bulk PostgREST insert, so a key one row lacks is null for it.
const step = (id: string, name: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind,
  outcome: kind === "end" ? "done" : null,
  work_hours: 0,
  wait_hours: 0,
  rework_rate: 0,
  x: 0,
  y: 0,
  provenance: {},
  assumption: false,
  conflict: false,
  ...extra,
});

/** A node for one process: start → task → end. `badEdge` points an edge at a step that doesn't exist. */
function node(name: string, opts: { id?: string; parent?: string | null; badEdge?: boolean } = {}) {
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  return {
    id: opts.id ?? randomUUID(),
    parent_id: opts.parent ?? null,
    name,
    kind: "pipeline",
    entity_name: "lead",
    description: "From a file",
    steps: [step(a, "Start", "start", { x: 0, y: 0 }), step(b, "Review", "task", { x: 200, y: 0, work_hours: 2, assumption: true, provenance: { work_hours: { source: "assumption" } } }), step(c, "Done", "end", { x: 400, y: 0 })],
    edges: [
      { id: randomUUID(), from_step_id: a, to_step_id: b, probability: 1, condition_tag: null, label: null },
      { id: randomUUID(), from_step_id: b, to_step_id: opts.badEdge ? randomUUID() : c, probability: 1, condition_tag: null, label: "go" },
    ],
  };
}

const count = async (sql: string, params: unknown[] = []) => Number((await db.client.query(sql, params)).rows[0].n);
const named = (name: string) => count("select count(*) n from processes where workspace_id = $1 and name = $2", [ws, name]);

describe("import_new_process", () => {
  it("writes the process, its draft, steps and edges, as the signed-in editor", async () => {
    const n = node("Atomic import ok");
    await db.as(editor.claims, async (c) => {
      const { rows } = await c.query("select public.import_new_process($1, $2, '[]') r", [ws, JSON.stringify([n])]);
      const [r] = rows[0].r;
      expect(r.process_id).toBe(n.id);
      const p = (await c.query("select name, source, created_by, draft_revision_id, live_revision_id, parent_process_id from processes where id = $1", [n.id])).rows[0];
      expect(p).toMatchObject({ name: "Atomic import ok", source: "import", created_by: editor.id, draft_revision_id: r.revision_id, live_revision_id: null, parent_process_id: null });
      const steps = (await c.query("select name, revision_id, process_id, workspace_id, work_hours::float8 w, assumption, created_by from steps where revision_id = $1 order by x", [r.revision_id])).rows;
      expect(steps.map((s) => s.name)).toEqual(["Start", "Review", "Done"]);
      expect(steps.every((s) => s.process_id === n.id && s.workspace_id === ws && s.created_by === editor.id)).toBe(true);
      expect(steps[1]).toMatchObject({ w: 2, assumption: true });
      expect((await c.query("select count(*)::int n from edges where revision_id = $1", [r.revision_id])).rows[0].n).toBe(2);
      expect((await c.query("select status, number from process_revisions where id = $1", [r.revision_id])).rows[0]).toEqual({ status: "draft", number: 1 });
    });
  });

  it("writes child processes inside their parent, and moves an existing process inside a step", async () => {
    const existing = randomUUID();
    await db.client.query("insert into processes (id, workspace_id, name) values ($1, $2, 'Existing child')", [existing, ws]);
    const parent = node("Atomic parent");
    const child = node("Atomic child", { parent: parent.id });
    await db.as(editor.claims, async (c) => {
      await c.query("select public.import_new_process($1, $2, $3)", [ws, JSON.stringify([parent, child]), JSON.stringify([{ id: existing, parent_id: parent.id }])]);
      const rows = (await c.query("select id, parent_process_id from processes where id = any($1)", [[parent.id, child.id, existing]])).rows;
      expect(Object.fromEntries(rows.map((r) => [r.id, r.parent_process_id]))).toEqual({ [parent.id]: null, [child.id]: parent.id, [existing]: parent.id });
    });
  });

  it("leaves nothing behind when the edges fail, and the same name can be imported afterwards", async () => {
    const bad = node("Atomic failing", { badEdge: true });
    await db.as(editor.claims, async (c) => {
      // The process, its draft and its steps are written before the edges fail: all of it must go.
      await c.query("savepoint s");
      await expect(c.query("select public.import_new_process($1, $2, '[]')", [ws, JSON.stringify([bad])])).rejects.toThrow(/foreign key/);
      await c.query("rollback to savepoint s");
      expect((await c.query("select count(*)::int n from processes where name = 'Atomic failing'")).rows[0].n).toBe(0);
      const good = node("Atomic failing");
      await c.query("select public.import_new_process($1, $2, '[]')", [ws, JSON.stringify([good])]);
      expect((await c.query("select count(*)::int n from processes where name = 'Atomic failing'")).rows[0].n).toBe(1);
    });
  });

  it("leaves nothing behind when it fails in a child process, or on a process to move that isn't there", async () => {
    const parent = node("Atomic half parent");
    const child = node("Atomic half child", { parent: parent.id, badEdge: true });
    await db.as(editor.claims, async (c) => {
      await c.query("savepoint s");
      await expect(c.query("select public.import_new_process($1, $2, '[]')", [ws, JSON.stringify([parent, child])])).rejects.toThrow();
      await c.query("rollback to savepoint s");
      const two = node("Atomic half two");
      await expect(c.query("select public.import_new_process($1, $2, $3)", [ws, JSON.stringify([two]), JSON.stringify([{ id: randomUUID(), parent_id: two.id }])])).rejects.toThrow(/not found/);
      await c.query("rollback to savepoint s");
      expect((await c.query("select count(*)::int n from processes where name like 'Atomic half%'")).rows[0].n).toBe(0);
    });
  });

  it("runs as the caller: a viewer, a stranger and anon can't make a process", async () => {
    for (const who of [viewer, other]) {
      await db.as(who.claims, async (c) => {
        await expect(c.query("select public.import_new_process($1, $2, '[]')", [ws, JSON.stringify([node("Atomic nope")])])).rejects.toThrow(/row-level security|violates/);
      });
    }
    await db.as(null, async (c) => {
      await expect(c.query("select public.import_new_process($1, $2, '[]')", [ws, JSON.stringify([node("Atomic nope")])])).rejects.toThrow();
    });
    await db.as(editor.claims, async (c) => {
      // Not in an editor's workspace either.
      const nowhere = (await c.query("select id from workspaces where id <> $1 limit 1", [ws])).rows[0]?.id;
      if (nowhere) await expect(c.query("select public.import_new_process($1, $2, '[]')", [nowhere, JSON.stringify([node("Atomic nope")])])).rejects.toThrow();
    });
    expect(await named("Atomic nope")).toBe(0);
  });

  it("refuses a malformed request", async () => {
    await db.as(editor.claims, async (c) => {
      await c.query("savepoint s");
      await expect(c.query("select public.import_new_process($1, '[]', '[]')", [ws])).rejects.toThrow(/p_nodes must be/);
      await c.query("rollback to savepoint s");
      await expect(c.query("select public.import_new_process($1, '{}', '[]')", [ws])).rejects.toThrow(/p_nodes must be/);
    });
  });
});

describe("import_new_process is not a general move or create-under call", () => {
  const call = (c: { query: (s: string, p?: unknown[]) => Promise<unknown> }, nodes: unknown[], adopt: unknown[] = []) =>
    c.query("select public.import_new_process($1, $2, $3)", [ws, JSON.stringify(nodes), JSON.stringify(adopt)]);
  const refused = async (nodes: unknown[], adopt: unknown[], message: RegExp) => {
    await db.as(editor.claims, async (c) => {
      await expect(call(c, nodes, adopt)).rejects.toThrow(message);
    });
  };

  it("refuses a new process under an existing one, or a parent that comes later or is missing", async () => {
    const existing = randomUUID();
    await db.client.query("insert into processes (id, workspace_id, name) values ($1, $2, 'Guard existing')", [existing, ws]);
    await refused([node("Guard under existing", { parent: existing })], [], /sit inside an earlier one/);
    const first = node("Guard first");
    const second = node("Guard second", { parent: first.id });
    await refused([second, first], [], /(only the first process has no parent|sit inside an earlier one)/);
    await refused([first, node("Guard second parentless")], [], /only the first process has no parent/);
  });

  it("moves only processes that have no parent, and only under a new process of the call", async () => {
    const top = randomUUID();
    const nested = randomUUID();
    const loose = randomUUID();
    await db.client.query("insert into processes (id, workspace_id, name) values ($1, $2, 'Guard top'), ($3, $2, 'Guard loose')", [top, ws, loose]);
    await db.client.query("insert into processes (id, workspace_id, name, parent_process_id) values ($1, $2, 'Guard nested', $3)", [nested, ws, top]);
    const mine = node("Guard mine");
    await refused([mine], [{ id: nested, parent_id: mine.id }], /not found, or already sits inside one/);
    await refused([mine], [{ id: loose, parent_id: top }], /inside a new one of this import/);
    await db.as(editor.claims, async (c) => {
      await call(c, [mine], [{ id: loose, parent_id: mine.id }]);
      expect((await c.query("select parent_process_id from processes where id = $1", [loose])).rows[0].parent_process_id).toBe(mine.id);
      expect((await c.query("select parent_process_id from processes where id = $1", [nested])).rows[0].parent_process_id).toBe(top);
    });
  });

  it("makes created_by the caller whatever the rows say", async () => {
    const n = node("Guard created by");
    (n.steps[0] as Record<string, unknown>).created_by = other.id;
    (n.edges[0] as Record<string, unknown>).created_by = other.id;
    await db.as(editor.claims, async (c) => {
      const r = (await call(c, [n])) as { rows: { import_new_process: { revision_id: string }[] }[] };
      const rev = r.rows[0]!.import_new_process[0]!.revision_id;
      expect((await c.query("select distinct created_by from steps where revision_id = $1", [rev])).rows).toEqual([{ created_by: editor.id }]);
      expect((await c.query("select distinct created_by from edges where revision_id = $1", [rev])).rows).toEqual([{ created_by: editor.id }]);
    });
  });

  it("refuses more than 1000 steps in all, and accepts 1000", async () => {
    const big = (name: string, steps: number) => {
      const n = node(name);
      n.steps = Array.from({ length: steps }, (_, i) => step(randomUUID(), `S${i}`, "task"));
      n.edges = [];
      return n;
    };
    await refused([big("Guard big a", 600), { ...big("Guard big b", 401), parent_id: null }], [], /at most 1000 steps in all \(this one has 1001\)/);
    await db.as(editor.claims, async (c) => {
      await call(c, [big("Guard big ok", 1000)]);
      expect((await c.query("select count(*)::int n from steps s join processes p on p.id = s.process_id where p.name = 'Guard big ok'")).rows[0].n).toBe(1000);
    });
  });

  it("refuses a name that is taken, ignoring case and punctuation, but not the company map's", async () => {
    await db.client.query("insert into processes (workspace_id, name) values ($1, 'Guard Sales & Co.')", [ws]);
    await refused([node("guard sales and co")], [], /already have a process called 'Guard Sales & Co\.'/);
    const a = node("Guard twin");
    await refused([a, node("GUARD twin!", { parent: a.id })], [], /already have a process called 'Guard twin'/);
    const company = (await db.client.query("select name from processes where workspace_id = $1 and is_company", [ws])).rows[0].name as string;
    await db.as(editor.claims, async (c) => {
      await call(c, [node(company)]);
    });
  });

  it("lets only one of two concurrent imports with the same name win", async () => {
    const other2 = new pg.Client({ connectionString: db.url });
    await other2.connect();
    const run = async (client: pg.Client, n: unknown) => {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(editor.claims)]);
      await call(client, [n]);
    };
    try {
      await run(db.client, node("Guard race"));
      // The second import waits for the first (same workspace lock) and then finds the name taken.
      const second = run(other2, node("Guard race")).then(
        () => "ok",
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 300));
      await db.client.query("commit");
      expect(await second).toMatch(/already have a process called 'Guard race'/);
      expect(await named("Guard race")).toBe(1);
    } finally {
      await other2.query("rollback").catch(() => {});
      await db.client.query("rollback").catch(() => {});
      await other2.end();
    }
  });
});

describe("take_link_fetch", () => {
  it("allows 10 a minute per user, then says how long to wait", async () => {
    await db.as(editor.claims, async (c) => {
      const got: number[] = [];
      for (let i = 0; i < 12; i++) got.push((await c.query("select public.take_link_fetch() w")).rows[0].w);
      expect(got.slice(0, 10)).toEqual(Array(10).fill(0));
      for (const wait of got.slice(10)) {
        expect(wait).toBeGreaterThanOrEqual(1);
        expect(wait).toBeLessThanOrEqual(60);
      }
    });
  });

  it("counts each person on their own, and opens a new minute after the window", async () => {
    await db.as(editor.claims, async (c) => {
      for (let i = 0; i < 11; i++) await c.query("select public.take_link_fetch()");
      expect((await c.query("select public.take_link_fetch() w")).rows[0].w).toBeGreaterThan(0);
      await c.query("reset role");
      await c.query("update private.link_fetch_limits set window_start = now() - interval '61 seconds' where user_id = $1", [editor.id]);
      await c.query("set local role authenticated");
      expect((await c.query("select public.take_link_fetch() w")).rows[0].w).toBe(0);
    });
    await db.as(other.claims, async (c) => {
      expect((await c.query("select public.take_link_fetch() w")).rows[0].w).toBe(0);
    });
  });

  it("is for signed-in users, and the counter table is out of reach for clients", async () => {
    await db.as(null, async (c) => {
      await expect(c.query("select public.take_link_fetch()")).rejects.toThrow(/sign in/);
    });
    await db.as(editor.claims, async (c) => {
      await c.query("savepoint s");
      await expect(c.query("select * from private.link_fetch_limits")).rejects.toThrow(/permission denied/);
      await c.query("rollback to savepoint s");
      await expect(c.query("update private.link_fetch_limits set hits = 0")).rejects.toThrow(/permission denied/);
    });
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select public.take_link_fetch()")).rejects.toThrow(/permission denied/);
      await db.client.query("rollback");
      await db.client.query("begin");
      await db.client.query("set local role anon");
      await expect(db.client.query("select public.import_new_process($1, '[]', '[]')", [ws])).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("gives execute to authenticated only, as the migration's header says", async () => {
    const rows = (
      await db.client.query(
        "select routine_name, grantee from information_schema.routine_privileges where routine_schema = 'public' and routine_name in ('import_new_process', 'take_link_fetch') and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1, 2",
      )
    ).rows;
    expect(rows).toEqual([
      { routine_name: "import_new_process", grantee: "authenticated" },
      { routine_name: "take_link_fetch", grantee: "authenticated" },
    ]);
    const table = (await db.client.query("select grantee from information_schema.role_table_grants where table_schema = 'private' and table_name = 'link_fetch_limits' and grantee in ('anon', 'authenticated', 'PUBLIC')")).rows;
    expect(table).toEqual([]);
  });
});

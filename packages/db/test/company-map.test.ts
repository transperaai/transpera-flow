import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCompanyPart, larkspurBundle, northbeamBundle, partOf, toEngineModel, type ProcessBundle, type ProcessPart } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The company map is a stored process (issue #163, B11 slice 1, migration 20261126000000): one per workspace, a holder
// step per top-level process at a stored position, a handoff edge from each pipeline to each servicing process. Made
// with Supabase's default table privileges, as production is.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
const migration = readFileSync(new URL("../supabase/migrations/20261126000000_company_map.sql", import.meta.url), "utf8");
const editing = readFileSync(new URL("../supabase/migrations/20261127500000_company_map_editing.sql", import.meta.url), "utf8");
const everywhere = readFileSync(new URL("../supabase/migrations/20261130000000_process_library_everywhere.sql", import.meta.url), "utf8");

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

/** The company map of a workspace: its process, and holders as process id → position, and the handoff pairs. */
async function stored(ws: string) {
  const [process] = await q("select * from processes where workspace_id = $1 and is_company", [ws]);
  const holders = await q(
    "select s.child_process_id as pid, s.x::float8 as x, s.y::float8 as y, s.name from steps s where s.revision_id = $1 and s.child_process_id is not null order by s.child_process_id",
    [process.live_revision_id],
  );
  const edges = await q(
    `select a.child_process_id as f, b.child_process_id as t from edges e
     join steps a on a.revision_id = e.revision_id and a.id = e.from_step_id join steps b on b.revision_id = e.revision_id and b.id = e.to_step_id
     where e.revision_id = $1 order by 1, 2`,
    [process.live_revision_id],
  );
  return { process, holders, edges };
}

/** What the Overview used to compute for `bundle`, in the order the workspace lists its processes (creation, then id). */
function computed(bundle: ProcessBundle) {
  const parts: ProcessPart[] = [partOf(bundle), ...(bundle.otherProcesses ?? [])].sort((a, b) => (a.process.id < b.process.id ? -1 : 1));
  const company = defaultCompanyPart(bundle.workspace.id, parts);
  const byHolder = new Map(company.steps.map((s) => [s.id, s.child_process_id!]));
  return {
    holders: company.steps.map((s) => ({ pid: s.child_process_id!, x: Number(s.x), y: Number(s.y), name: parts.find((p) => p.process.id === s.child_process_id)!.process.name })).sort((a, b) => (a.pid < b.pid ? -1 : 1)),
    edges: company.edges.map((e) => ({ f: byHolder.get(e.from_step_id)!, t: byHolder.get(e.to_step_id)! })).sort((a, b) => (a.f + a.t < b.f + b.t ? -1 : 1)),
  };
}

const sorted = <T extends { f: string; t: string }>(edges: T[]) => [...edges].sort((a, b) => (a.f + a.t < b.f + b.t ? -1 : 1));

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@company-map.example.com");
});

afterAll(async () => {
  await db?.close();
});

describe("the seeded workspaces", () => {
  for (const [name, bundle] of [["Northbeam", northbeamBundle()], ["Larkspur", larkspurBundle()]] as const) {
    it(`${name} has exactly one company map, laid out as the Overview computed it`, async () => {
      const ws = bundle.workspace.id;
      const got = await stored(ws);
      expect((await q("select count(*)::int n from processes where workspace_id = $1 and is_company", [ws]))[0].n).toBe(1);
      expect(got.process).toMatchObject({ name: "Company map", parent_process_id: null });
      expect((await q("select status, number from process_revisions where id = $1", [got.process.live_revision_id]))[0]).toEqual({ status: "published", number: 1 });
      const want = computed(bundle);
      expect(got.holders).toEqual(want.holders);
      expect(sorted(got.edges)).toEqual(want.edges);
      // The company map is the root: its holders hold the top-level processes, which keep no parent.
      expect((await q("select count(*)::int n from processes where workspace_id = $1 and not is_company and parent_process_id is not null", [ws]))[0].n).toBe(0);
    });
  }

  it("is not simulated: the engine refuses a bundle of the company map, and the seeded model is unchanged", async () => {
    const [company] = await q("select * from processes where workspace_id = $1 and is_company", [northbeamBundle().workspace.id]);
    const base = northbeamBundle();
    expect(() => toEngineModel({ ...base, process: company, steps: [], edges: [] })).toThrow(/company map/);
    // Its holders and edges are not part of the model: otherProcesses are the processes, never the map.
    const model = toEngineModel(base, { startDate: "2026-10-05" });
    expect(JSON.stringify(model)).not.toContain("Company map");
  });
});

describe("keeping the map in step with the processes", () => {
  it("makes a company map for a new workspace, and puts new processes on it without writing to them", async () => {
    const ws = (await q("insert into workspaces (name, slug) values ('Fresh', 'fresh-company-map') returning id"))[0].id;
    const empty = await stored(ws);
    expect(empty.holders).toEqual([]);
    const sales = randomUUID();
    const service = randomUUID();
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Sales', 'pipeline'), ($3, $2, 'Delivery', 'servicing')", [sales, ws, service]);
    const before = (await q("select * from processes where id = any($1) order by id", [[sales, service]]));
    const after = await stored(ws);
    expect(after.holders.map((h) => [h.pid, h.x, h.y]).sort()).toEqual(
      [
        [sales, 0, 0],
        [service, 288, 0],
      ].sort(),
    );
    expect(after.edges).toEqual([{ f: sales, t: service }]);
    // Placing a process on the map is a link held by the map: the process rows are exactly as they were inserted.
    expect(await q("select * from processes where id = any($1) order by id", [[sales, service]])).toEqual(before);
    expect((await q("select count(*)::int n from processes where workspace_id = $1 and parent_process_id is not null", [ws]))[0].n).toBe(0);

    // A second pipeline goes below the first.
    const second = randomUUID();
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Partnerships', 'pipeline')", [second, ws]);
    expect((await stored(ws)).holders.find((h) => h.pid === second)).toMatchObject({ x: 0, y: 160 });

    // Renaming renames the holder; nesting a process takes it off the map; deleting one does too.
    await q("update processes set name = 'Sales v2' where id = $1", [sales]);
    expect((await stored(ws)).holders.find((h) => h.pid === sales)!.name).toBe("Sales v2");
    await q("update processes set parent_process_id = $1 where id = $2", [sales, second]);
    // Nested under another process, it is no longer held by the company map.
    expect((await stored(ws)).holders.map((h) => h.pid)).not.toContain(second);
    await q("update processes set parent_process_id = null where id = $1", [second]);
    expect((await stored(ws)).holders.map((h) => h.pid)).toContain(second);
    await q("delete from processes where id = $1", [second]);
    expect((await stored(ws)).holders.map((h) => h.pid)).not.toContain(second);

    // Deleting the workspace takes the company map with it.
    await q("delete from workspaces where id = $1", [ws]);
    expect((await q("select count(*)::int n from processes where workspace_id = $1", [ws]))[0].n).toBe(0);
  });
});

describe("the map follows a process's kind, and fixed columns", () => {
  it("moves a process to the other column when its kind changes, and keeps every handoff line (they belong to the people who drew them)", async () => {
    const ws = (await q("insert into workspaces (name, slug) values ('Kinds', 'kinds-company-map') returning id"))[0].id;
    const [a, b] = [randomUUID(), randomUUID()];
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Sales', 'pipeline'), ($3, $2, 'Delivery', 'servicing')", [a, ws, b]);
    expect((await stored(ws)).edges).toEqual([{ f: a, t: b }]);
    await q("update processes set kind = 'servicing' where id = $1", [a]);
    const got = await stored(ws);
    expect(got.holders.find((h) => h.pid === a)).toMatchObject({ x: 288 });
    // The line stays where it was: sync moves the card, and leaves lines to the people who draw them.
    expect(got.edges).toEqual([{ f: a, t: b }]);
    await q("update processes set kind = 'pipeline' where id = $1", [b]);
    const back = await stored(ws);
    expect(back.holders.find((h) => h.pid === b)).toMatchObject({ x: 0 });
    expect(back.edges).toEqual([{ f: a, t: b }]);
  });

  it("keeps pipelines in column 0 and servicing in column 1 when the first processes were servicing", async () => {
    const ws = (await q("insert into workspaces (name, slug) values ('Columns', 'columns-company-map') returning id"))[0].id;
    const [s, p] = [randomUUID(), randomUUID()];
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Delivery', 'servicing')", [s, ws]);
    await q("select private.relayout_company_map($1)", [ws]);
    expect((await stored(ws)).holders[0]).toMatchObject({ x: 288, y: 0 });
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Sales', 'pipeline')", [p, ws]);
    const got = await stored(ws);
    expect(got.holders.find((h) => h.pid === p)).toMatchObject({ x: 0, y: 0 });
    expect(got.edges).toEqual([{ f: p, t: s }]);
  });

  it("gives processes made at the same moment their own place and lines", async () => {
    const ws = (await q("insert into workspaces (name, slug) values ('Together', 'together-company-map') returning id"))[0].id;
    await q("insert into processes (workspace_id, name, kind) values ($1, 'Seed pipeline', 'pipeline')", [ws]);
    const other = new (await import("pg")).default.Client({ connectionString: db.url });
    await other.connect();
    try {
      await db.client.query("begin");
      const first = randomUUID();
      await db.client.query("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'First', 'pipeline')", [first, ws]);
      // A second connection inserts while the first is still open: it waits for the first's sync, then adds below it.
      const second = randomUUID();
      const racing = other.query("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Second', 'pipeline')", [second, ws]);
      await new Promise((r) => setTimeout(r, 300));
      await db.client.query("commit");
      await racing;
      const ys = (await stored(ws)).holders.map((h) => h.y);
      expect(new Set(ys).size).toBe(ys.length);
    } finally {
      await other.end();
    }
  });
});

describe("who may touch the company map", () => {
  const ws = northbeamBundle().workspace.id;

  async function asEditor<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor') on conflict do nothing", [ws, editor.id]);
    return db.as(editor.claims, fn);
  }
  const rejects = async (fn: (c: pg.Client) => Promise<unknown>, message: RegExp) => {
    await asEditor(async (c) => {
      await c.query("savepoint s");
      await expect(fn(c)).rejects.toThrow(message);
      await c.query("rollback to savepoint s");
    });
  };

  it("lets members read it, but nobody signed in creates, renames or deletes one", async () => {
    const [company] = await q("select id from processes where workspace_id = $1 and is_company", [ws]);
    await asEditor(async (c) => {
      expect((await c.query("select count(*)::int n from processes where is_company")).rows[0].n).toBe(1);
    });
    await rejects((c) => c.query("insert into processes (workspace_id, name, is_company) values ($1, 'Second', true)", [ws]), /made by the system/);
    await rejects((c) => c.query("update processes set is_company = false where id = $1", [company.id]), /become, or stop being/);
    await rejects((c) => c.query("update processes set is_company = true where id = (select id from processes where workspace_id = $1 and not is_company limit 1)", [ws]), /become, or stop being/);
    await rejects((c) => c.query("delete from processes where id = $1", [company.id]), /can't be deleted/);
    await rejects((c) => c.query("update processes set parent_process_id = (select id from processes where workspace_id = $1 and not is_company limit 1) where id = $2", [ws, company.id]), /can.t be renamed|processes_company_is_top/);
  });

  it("refuses a company map as a process's parent, a rename, kind or parent change, a null live version or a version of another process", async () => {
    const [company] = await q("select id, live_revision_id from processes where workspace_id = $1 and is_company", [ws]);
    const [svc] = await q("select id, live_revision_id from processes where workspace_id = $1 and kind = 'servicing' order by id limit 1", [ws]);
    await rejects((c) => c.query("update processes set parent_process_id = $1 where id = $2", [company.id, svc.id]), /can't be a process's parent/);
    await rejects((c) => c.query("insert into processes (workspace_id, name, parent_process_id) values ($1, 'Under the map', $2)", [ws, company.id]), /can't be a process's parent/);
    await rejects((c) => c.query("update processes set name = 'Renamed' where id = $1", [company.id]), /can't be renamed/);
    await rejects((c) => c.query("update processes set kind = 'servicing' where id = $1", [company.id]), /can't be renamed/);
    await rejects((c) => c.query("update processes set live_revision_id = null where id = $1", [company.id]), /must keep a live version/);
    await rejects((c) => c.query("update processes set draft_revision_id = $2 where id = $1", [company.id, svc.live_revision_id]), /only point at its own versions/);
    await rejects((c) => c.query("update processes set live_revision_id = $2 where id = $1", [company.id, svc.live_revision_id]), /only point at its own versions/);
    // A copy of it is refused (a copy of a map is not a process), and restoring the live version has nothing to do.
    await asEditor(async (c) => {
      expect((await c.query("select duplicate_version($1, $2) as r", [company.live_revision_id, "Copy"])).rows[0].r).toEqual({ status: "not_found" });
      expect((await c.query("select count(*)::int n from processes where name = $1", ["Copy"])).rows[0].n).toBe(0);
      expect((await c.query("select restore_version($1, $2, true) as r", [company.id, company.live_revision_id])).rows[0].r).toEqual({ status: "already_live" });
    });
    // Nothing changed, and every seeded process is still held.
    expect((await stored(ws)).holders).toHaveLength(3);
    expect((await q("select name, kind, parent_process_id from processes where id = $1", [company.id]))[0]).toEqual({ name: "Company map", kind: "pipeline", parent_process_id: null });
  });

  it("is not fooled by an editor setting the system flag themselves", async () => {
    const [company] = await q("select id, live_revision_id from processes where workspace_id = $1 and is_company", [ws]);
    const flagged = async (sql: string, params: unknown[], message: RegExp) => {
      await rejects(async (c) => {
        await c.query("select set_config('transpera.company_system', 'on', true)");
        await c.query(sql, params);
      }, message);
    };
    await flagged("update processes set name = 'Renamed' where id = $1", [company.id], /can't be renamed/);
    await flagged("update processes set live_revision_id = null where id = $1", [company.id], /must keep a live version/);
    await flagged("delete from steps where revision_id = $1 and child_process_id is not null", [company.live_revision_id], /taken off the company map by removing its card in a draft/);
    await flagged("insert into processes (workspace_id, name, is_company) values ($1, 'Second', true)", [ws], /made by the system/);
  });

  it("lets a draft link any process (B12: publishing is where a second place is refused), but never the company map", async () => {
    const [company] = await q("select id, live_revision_id from processes where workspace_id = $1 and is_company", [ws]);
    const top = await q("select id from processes where workspace_id = $1 and not is_company and parent_process_id is null order by id", [ws]);
    const draft = randomUUID();
    const child = randomUUID();
    const parent = top[0].id as string;
    await q("insert into processes (id, workspace_id, name, parent_process_id) values ($1, $2, 'Child', $3)", [child, ws, parent]);
    await q("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 2, 'draft')", [draft, ws, company.id]);
    // The child's (legacy) parent column plays no part: a draft of the company map may link it.
    await db.client.query("begin");
    await db.client.query("insert into steps (revision_id, workspace_id, process_id, name, kind, child_process_id) values ($1, $2, $3, 'Child', 'subprocess', $4)", [draft, ws, company.id, child]);
    await expect(db.client.query("set constraints all immediate")).resolves.toBeDefined();
    await db.client.query("rollback");
    // A parent-less process may sit in an ordinary process's draft too (the library in every editor).
    const [other] = await q("select id from processes where workspace_id = $1 and not is_company and parent_process_id is null and id <> $2 order by id limit 1", [ws, parent]);
    await db.client.query("begin");
    await db.client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 9, 'draft')", [randomUUID(), ws, parent]);
    await db.client.query("insert into steps (revision_id, workspace_id, process_id, name, kind, child_process_id) values ((select id from process_revisions where process_id = $1 and number = 9), $2, $1, 'Other', 'subprocess', $3)", [parent, ws, other.id]);
    await expect(db.client.query("set constraints all immediate")).resolves.toBeDefined();
    await db.client.query("rollback");
    // Nor itself.
    await db.client.query("begin");
    await db.client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 9, 'draft')", [randomUUID(), ws, parent]);
    await db.client.query("insert into steps (revision_id, workspace_id, process_id, name, kind, child_process_id) values ((select id from process_revisions where process_id = $1 and number = 9), $2, $1, 'Self', 'subprocess', $1)", [parent, ws]);
    await expect(db.client.query("set constraints all immediate")).rejects.toThrow(/can't hold itself or the company map/);
    await db.client.query("rollback");
    // And the company map is never held.
    await db.client.query("begin");
    await db.client.query("insert into steps (revision_id, workspace_id, process_id, name, kind, child_process_id) values ($1, $2, $3, 'Itself', 'subprocess', $3)", [draft, ws, company.id]);
    await expect(db.client.query("set constraints all immediate")).rejects.toThrow();
    await db.client.query("rollback");
    await q("delete from processes where id = $1", [child]);
    await q("delete from process_revisions where id = $1", [draft]);
  });

  it("keeps the helper functions away from anon and authenticated, except the one the nesting check calls", async () => {
    const fns = await q(
      `select p.proname, p.oid::regprocedure::text as sig, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth
       from pg_proc p where p.pronamespace = 'private'::regnamespace
         and p.proname in ('ensure_company_map', 'company_layout_insert', 'relayout_company_map', 'company_map_before_delete', 'company_map_membership', 'company_map_new_workspace', 'holder_allows', 'company_process_guard', 'company_revision_guard', 'company_holder_guard', 'company_new_version', 'company_add_holder', 'company_map_edit', 'company_map_apply')
       order by 1`,
    );
    expect(fns).toHaveLength(14);
    for (const f of fns) expect(f.anon, f.sig).toBe(false);
    expect(fns.filter((f) => f.auth).map((f) => f.proname)).toEqual(["holder_allows"]);
  });
});

describe("the backfill", () => {
  it("gives workspaces that already exist a company map laid out as the Overview computed it, and rolls back cleanly", async () => {
    // The rollbacks written in the two migrations' headers (slice 2's first), then both migrations again over the workspaces
    // that are there.
    const rollback = (sql: string, until: string, version: string, from = "-- Rollback") =>
      sql
        .slice(sql.indexOf(from), sql.indexOf(until))
        .split("\n")
        .filter((l) => l.startsWith("--   ") && !l.startsWith("--   --"))
        .map((l) => l.slice(5))
        .join("\n")
        .replace(`delete from supabase_migrations.schema_migrations where version = '${version}';`, "");
    const defn = (sql: string, name: string) => sql.match(new RegExp(`^create (?:or replace )?function ${name}\\([\\s\\S]*?\\n\\$\\$;`, "m"))![0].replace(/^create function/, "create or replace function");
    const nested = readFileSync(new URL("../supabase/migrations/20261108000000_nested_processes.sql", import.meta.url), "utf8");
    const restored = defn(nested, "private\\.check_step_nesting");
    const history = readFileSync(new URL("../supabase/migrations/20261118000000_process_history.sql", import.meta.url), "utf8");
    const duplicate = defn(history, "public\\.duplicate_version");
    // Slice 2's rollback: what its header says to re-create, from the files it names.
    const rollBackEditing = [
      ...["revision_history", "restore_version"].map((n) => defn(history, `public\\.${n}`)),
      ...["company_process_guard", "company_revision_guard", "company_map_before_delete", "company_map_membership", "relayout_company_map", "sync_company_map", "check_step_nesting"].map((n) => defn(migration, `private\\.${n}`)),
      "revoke all on function private.sync_company_map(uuid) from public, anon, authenticated;",
      "grant execute on function public.revision_history(uuid) to authenticated;",
    ].join("\n");
    // B12 part 2's rollback first (it is the newest of the three that redefine these functions): what its header says to re-create.
    const rollBackEverywhere = [
      defn(migration, "private\\.holder_allows"),
      ...["check_step_nesting", "company_add_holder", "company_map_apply", "company_map_membership"].map((n) => defn(editing, `private\\.${n}`)),
      defn(editing, "public\\.restore_version"),
    ].join("\n");
    await db.client.query(
      rollback(everywhere, "-- ---------------------------------------------------------------------------\n-- Where a process sits", "20261130000000", "-- ROLLBACK").replace(
        "drop function private.live_holder",
        () => `${rollBackEverywhere}\ndrop function private.live_holder`,
      ),
    );
    expect((await q("select count(*)::int n from pg_proc where proname in ('live_holder', 'check_live_placements', 'create_library_process')"))[0].n).toBe(0);
    await db.client.query(duplicate);
    await db.client.query(rollback(editing, "-- ---------------------------------------------------------------------------\n-- Who may change", "20261127500000").replace("commit;", () => `${rollBackEditing}\ncommit;`));
    expect((await q("select count(*)::int n from pg_proc where proname = 'company_map_apply'"))[0].n).toBe(0);
    await db.client.query(
      rollback(migration, "-- ---------------------------------------------------------------------------\n-- The marker", "20261126000000").replace("commit;", () => `${restored}\ncommit;`),
    );
    expect((await q("select count(*)::int n from information_schema.columns where table_name = 'processes' and column_name = 'is_company'"))[0].n).toBe(0);
    expect((await q("select count(*)::int n from steps where child_process_id is not null"))[0].n).toBe(0);
    await db.client.query(migration);
    await db.client.query(editing);
    await db.client.query(everywhere);
    for (const bundle of [northbeamBundle(), larkspurBundle()]) {
      const got = await stored(bundle.workspace.id);
      const want = computed(bundle);
      expect(got.holders).toEqual(want.holders);
      expect(sorted(got.edges)).toEqual(want.edges);
    }
    // Exactly one per workspace, including the ones tests made.
    expect(await q("select w.id from workspaces w where (select count(*) from processes p where p.workspace_id = w.id and p.is_company) <> 1")).toEqual([]);
  });
});

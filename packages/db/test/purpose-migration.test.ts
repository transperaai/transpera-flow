import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import {
  BUNDLE_TABLES,
  DEFAULT_PURPOSES,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  SHARE_NON_TEXT_KEYS,
  exportWorkspaceBundle,
  northbeamStepIds,
  planWorkspaceImport,
  type ImportPlan,
  type Row,
  type TableReader,
  type WorkspaceBundle,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// What a step achieves (sandbox phase 4, migration 20270114000000_step_purpose.sql): the migration runs on a database full of real
// rows. It is built as it was before it (every migration up to 20270112000000), given published, superseded and draft versions of
// Northbeam's pipeline and workspaces whose settings.purposes holds every kind of value a restore could have written, and then
// migrated. It writes no step row; the column is checked, the list's check, the draft/publish/restore paths and the share and
// restore twins.

const BASE = "20270112000000";
const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
let db: TestDb;
type User = { id: string; claims: Record<string, unknown> };
let editor: User;
let admin: User;
let before: { steps: Record<string, unknown>[]; revisions: Record<string, unknown>[] };
const wsIds: Record<string, string> = {};

const list = (drop?: string) => DEFAULT_PURPOSES.filter((c) => c.key !== drop).map((c) => ({ ...c }));
const SETTINGS: [string, unknown][] = [
  ["valid", list()],
  ["renamed", list().map((c) => (c.key === "winning" ? { ...c, name: "Sales" } : c))],
  ["null", null],
  ["junk", "junk"],
  ["noFixing", list("fixing")],
  ["object", { key: "winning" }],
];

/** Run as a signed-in user and COMMIT (the harness's `db.as` rolls back): what one request does. */
async function as<T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const r = await fn(db.client);
    await db.client.query("commit");
    return r;
  } catch (e) {
    await db.client.query("rollback");
    throw e;
  }
}
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows as Row[];
const rpc = (c: pg.Client, fn: string, ...args: unknown[]) => c.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args).then((r) => r.rows[0].r);
const allSteps = () => q("select to_jsonb(s) - 'purpose' as j, to_jsonb(s) -> 'purpose' as purpose, updated_at from public.steps s order by revision_id, id");

async function failure(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("expected the call to fail");
}

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  editor = await createUser(db, "purpose-editor@example.com");
  admin = await createUser(db, "purpose-admin@example.com", { agency_admin: true });
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, editor.id]);
  // Published (v1), superseded (v1 after v2 goes live), and a draft (v3) of the pipeline.
  await as(editor.claims, async (c) => {
    await rpc(c, "open_draft", proc);
    expect((await rpc(c, "publish_process", proc, true)).status).toBe("published");
    await rpc(c, "open_draft", proc);
  });
  for (const [name, settings] of SETTINGS) {
    wsIds[name] = (await db.client.query("insert into workspaces (name, slug, settings) values ($1, $2, jsonb_build_object('currency', 'GBP', 'purposes', $3::jsonb)) returning id", [name, `purpose-${name.toLowerCase()}`, JSON.stringify(settings)])).rows[0].id;
  }
  wsIds.absent = (await db.client.query("insert into workspaces (name, slug, settings) values ('absent', 'purpose-absent', '{\"currency\": \"GBP\"}') returning id")).rows[0].id;
  before = { steps: await allSteps(), revisions: await q("select status, count(*) from public.process_revisions where process_id = $1 group by status order by status", [proc]) };
  const applied = await applyMigrations(db.client, {});
  expect(applied.files[0]).toBe("20270114000000_step_purpose.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("what the migration does to stored rows", () => {
  it("has published, superseded and draft versions to test on", () => {
    expect(before.revisions.map((r) => r.status)).toEqual(["draft", "published", "superseded"]);
    expect(before.steps.length).toBeGreaterThan(20);
  });

  it("writes no step row: every step is as it was, purpose is null, updated_at is unchanged", async () => {
    const after = await allSteps();
    expect(after).toHaveLength(before.steps.length);
    for (const [i, s] of after.entries()) {
      expect(s.purpose).toBeNull();
      expect(before.steps[i]!.purpose).toBeNull();
      expect(s.j).toEqual(before.steps[i]!.j);
      expect(s.updated_at).toEqual(before.steps[i]!.updated_at);
    }
  });

  it("keeps a valid list, null and an absent key; removes junk, an object and a list missing a fixed category", async () => {
    const stored = async (name: string) => (await q("select settings -> 'purposes' as v, settings ? 'purposes' as has, settings ->> 'currency' as currency from workspaces where id = $1", [wsIds[name]]))[0]!;
    expect((await stored("valid")).v).toEqual(list());
    expect((await stored("renamed")).v).toEqual(SETTINGS[1]![1]);
    expect(await stored("null")).toMatchObject({ v: null, has: true });
    expect((await stored("absent")).has).toBe(false);
    for (const name of ["junk", "object", "noFixing"]) expect(await stored(name), name).toMatchObject({ has: false, currency: "GBP" });
  });

  it("the constraints are validated and the check function is there", async () => {
    const rows = await q("select conname, convalidated from pg_constraint where conname in ('steps_purpose_key', 'workspaces_purposes') order by conname");
    expect(rows).toEqual([{ conname: "steps_purpose_key", convalidated: true }, { conname: "workspaces_purposes", convalidated: true }]);
    expect((await q("select count(*) from workspaces where settings ? 'purposes' and jsonb_typeof(settings -> 'purposes') <> 'null' and not private.is_purpose_list(settings -> 'purposes')"))[0]!.count).toBe("0");
  });
});

describe("saving a purpose", () => {
  const draftOf = async () => (await q("select draft_revision_id from processes where id = $1", [proc]))[0]!.draft_revision_id as string;
  const liveOf = async () => (await q("select live_revision_id from processes where id = $1", [proc]))[0]!.live_revision_id as string;
  const save = (c: pg.Client, revision: string, id: string, base: unknown, value: unknown) =>
    rpc(c, "save_fields", "steps", JSON.stringify({ revision_id: revision, id }), JSON.stringify({ purpose: base }), JSON.stringify({ purpose: value }));
  const audit = northbeamStepIds.audit;

  it("refuses a word that isn't a key (23514), a short c key, and client upkeep", async () => {
    const draft = await draftOf();
    for (const bad of ["Sales", "c123", "client_upkeep", "WINNING", ""]) {
      const e = await failure(() => as(editor.claims, (c) => save(c, draft, audit, null, bad)));
      expect(e.code, bad).toBe("23514");
    }
  });

  it("accepts a default key and a c + 8 hex key on a draft, and clears it back to Automatic", async () => {
    const draft = await draftOf();
    expect((await as(editor.claims, (c) => save(c, draft, audit, null, "winning"))).status).toBe("saved");
    expect((await q("select purpose from steps where revision_id = $1 and id = $2", [draft, audit]))[0]!.purpose).toBe("winning");
    expect((await as(editor.claims, (c) => save(c, draft, audit, "winning", "c0a1b2c3d"))).status).toBe("saved");
    expect((await as(editor.claims, (c) => save(c, draft, audit, "c0a1b2c3d", "winning"))).status).toBe("saved");
    expect((await as(editor.claims, (c) => save(c, draft, audit, "winning", null))).status).toBe("saved");
  });

  it("a stale base is a conflict, not a write", async () => {
    const draft = await draftOf();
    await as(editor.claims, (c) => save(c, draft, audit, null, "coordination"));
    const r = await as(editor.claims, (c) => save(c, draft, audit, null, "fixing"));
    expect(r.status).toBe("conflict");
    expect(r.conflicts).toEqual({ purpose: "coordination" });
    await as(editor.claims, (c) => save(c, draft, audit, "coordination", null));
  });

  it("is refused on a published or superseded version (55000)", async () => {
    const live = await liveOf();
    const e = await failure(() => as(editor.claims, (c) => save(c, live, audit, null, "winning")));
    expect(e.code).toBe("55000");
    const [old] = await q("select id from process_revisions where process_id = $1 and status = 'superseded'", [proc]);
    const e2 = await failure(() => as(editor.claims, (c) => save(c, old!.id as string, audit, null, "winning")));
    expect(e2.code).toBe("55000");
  });

  it("open_draft copies a set purpose, and the draft's change list counts it", async () => {
    const draft = await draftOf();
    await as(editor.claims, (c) => save(c, draft, audit, null, "removable"));
    await as(editor.claims, (c) => rpc(c, "publish_process", proc, true));
    expect((await q("select purpose from steps where revision_id = $1 and id = $2", [await liveOf(), audit]))[0]!.purpose).toBe("removable");
    const next = (await as(editor.claims, (c) => rpc(c, "open_draft", proc))).revision_id as string;
    expect((await q("select purpose from steps where revision_id = $1 and id = $2", [next, audit]))[0]!.purpose).toBe("removable");
    const none = (await q("select private.revision_changes($1, $2) as r", [await liveOf(), next]))[0]!.r as { steps: { changed: unknown[] } };
    expect(none.steps.changed).toEqual([]);
    await as(editor.claims, (c) => save(c, next, audit, "removable", "client_job"));
    const changed = (await q("select private.revision_changes($1, $2) as r", [await liveOf(), next]))[0]!.r as { steps: { changed: string[] } };
    expect(changed.steps.changed).toEqual([audit]);
  });
});

describe("settings.purposes on a workspace", () => {
  const set = (id: string, value: unknown) => db.client.query("update workspaces set settings = jsonb_set(settings, '{purposes}', $2::jsonb) where id = $1", [id, JSON.stringify(value)]);

  it("accepts a valid list and null; refuses 4 items, a duplicate name and a missing fixed category (23514)", async () => {
    await set(wsIds.valid!, list());
    await set(wsIds.valid!, null);
    for (const bad of [list().slice(0, 4), [...list().slice(0, 6), { key: "c00000001", name: "winning work", description: "" }], list("removable"), "junk"]) {
      const e = await failure(() => set(wsIds.valid!, bad));
      expect(e.code).toBe("23514");
    }
  });

  it("a workspace with no list (the defaults) saves one against a null base, and a stale null is then a conflict", async () => {
    const renamed = list().map((c) => (c.key === "winning" ? { ...c, name: "Selling" } : c));
    const r = await as(admin.claims, (c) => rpc(c, "save_fields", "workspaces", JSON.stringify({ id: wsIds.absent }), JSON.stringify({ "settings.purposes": null }), JSON.stringify({ "settings.purposes": renamed })));
    expect(r.status).toBe("saved");
    const again = await as(admin.claims, (c) => rpc(c, "save_fields", "workspaces", JSON.stringify({ id: wsIds.absent }), JSON.stringify({ "settings.purposes": null }), JSON.stringify({ "settings.purposes": list() })));
    expect(again.status).toBe("conflict");
    expect(again.conflicts).toEqual({ "settings.purposes": renamed });
  });

  it("is saved through save_fields with compare-and-set on the whole list", async () => {
    const renamed = list().map((c) => (c.key === "fixing" ? { ...c, name: "Putting right" } : c));
    const r = await as(admin.claims, (c) => rpc(c, "save_fields", "workspaces", JSON.stringify({ id: wsIds.renamed }), JSON.stringify({ "settings.purposes": SETTINGS[1]![1] }), JSON.stringify({ "settings.purposes": renamed })));
    expect(r.status).toBe("saved");
    const stale = await as(admin.claims, (c) => rpc(c, "save_fields", "workspaces", JSON.stringify({ id: wsIds.renamed }), JSON.stringify({ "settings.purposes": SETTINGS[1]![1] }), JSON.stringify({ "settings.purposes": list() })));
    expect(stale.status).toBe("conflict");
    const e = await failure(() => as(admin.claims, (c) => rpc(c, "save_fields", "workspaces", JSON.stringify({ id: wsIds.renamed }), JSON.stringify({ "settings.purposes": renamed }), JSON.stringify({ "settings.purposes": list().slice(0, 3) }))));
    expect(e.code).toBe("23514");
  });
});

describe("share snapshots and restores", () => {
  it("'purpose' is on the SQL non-text list, which still equals SHARE_NON_TEXT_KEYS", async () => {
    const [{ src }] = (await q("select pg_get_functiondef('private.share_snapshot_problem(uuid, text, jsonb, boolean, boolean)'::regprocedure) as src")) as unknown as [{ src: string }];
    const list = /non_text_keys constant text\[\] := array\[([^\]]*)\]/.exec(src)![1]!;
    const sql = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
    expect(sql).toContain("purpose");
    expect(sql).toEqual([...SHARE_NON_TEXT_KEYS].sort());
  });

  async function exportOf(workspaceId: string): Promise<WorkspaceBundle> {
    const bundle = await db.as(admin.claims, async (c) => {
      const read: TableReader = async (table, wsId) => {
        const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
        return (await c.query(`select to_jsonb(t) as j from (select * from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}) t`, [wsId])).rows.map((r) => r.j) as Row[];
      };
      const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
      return exportWorkspaceBundle(workspaceId, readWorkspace, read, { canEdit: true, now: new Date("2026-10-05T12:00:00Z") });
    });
    return JSON.parse(JSON.stringify(bundle)) as WorkspaceBundle;
  }
  let seq = 0;
  const newWorkspace = async () => {
    const slug = `purpose-restore-${++seq}-${Date.now()}`;
    return as(admin.claims, async (c) => (await rpc(c, "create_workspace", "Restored", slug)) as string);
  };
  const restore = (workspace: string, plan: ImportPlan) => as(admin.claims, (c) => rpc(c, "import_workspace_bundle", workspace, JSON.stringify(plan), "backup.json"));

  it("a restore round-trips a step's purpose and the workspace's list", async () => {
    const bundle = await exportOf(ws);
    const plan = structuredClone(planWorkspaceImport(bundle, { canManage: true }).plan);
    const first = plan.processes.find((p) => p.steps.some((s) => s.kind === "task"))!;
    const target = first.steps.find((s) => s.kind === "task")!;
    (target as Row).purpose = "coordination";
    const renamed = list().map((c) => (c.key === "winning" ? { ...c, name: "Selling" } : c));
    plan.settings = { ...(plan.settings ?? {}), purposes: renamed };
    const into = await newWorkspace();
    await restore(into, plan);
    expect((await q("select settings -> 'purposes' as v from workspaces where id = $1", [into]))[0]!.v).toEqual(renamed);
    // The source holds one purpose of its own ("removable", set above and published); the plan adds "coordination" to one more step.
    const rows = await q("select purpose, count(*) from steps where workspace_id = $1 and purpose is not null group by purpose order by purpose", [into]);
    expect(rows).toEqual([{ purpose: "coordination", count: "1" }, { purpose: "removable", count: "1" }]);
  });

  it("a restore refuses a bad settings.purposes, and a bad step purpose, all or nothing", async () => {
    const bundle = await exportOf(ws);
    const base = structuredClone(planWorkspaceImport(bundle, { canManage: true }).plan);
    const badSettings = { ...structuredClone(base), settings: { ...(base.settings ?? {}), purposes: list().slice(0, 3) } };
    const into = await newWorkspace();
    const processesBefore = (await q("select count(*) from processes where workspace_id = $1", [into]))[0]!.count;
    const e = await failure(() => restore(into, badSettings));
    expect(e.message).toMatch(/settings could not be restored|purposes/);
    const badStep = structuredClone(base);
    (badStep.processes[0]!.steps[0] as Row).purpose = "Sales";
    const into2 = await newWorkspace();
    await failure(() => restore(into2, badStep));
    expect((await q("select count(*) from processes where workspace_id = $1", [into]))[0]!.count).toBe(processesBefore);
    expect((await q("select count(*) from processes where workspace_id = $1", [into2]))[0]!.count).toBe(processesBefore);
    expect((await q("select settings ? 'purposes' as has from workspaces where id = $1", [into]))[0]!.has).toBe(false);
  });
});

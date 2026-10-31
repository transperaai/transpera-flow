import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import {
  BUNDLE_TABLES,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  exportWorkspaceBundle,
  northbeamStepIds,
  planWorkspaceImport,
  type Row,
  type TableReader,
  type WorkspaceBundle,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Step base values (capacity P4, migration 20270120000000_step_base_values.sql): the migration runs on a database full of rows,
// writes none of them, checks the four new columns, accepts the driver recurrence beside the two old ones, and every path that
// copies a step row carries the new columns along.

const BASE = "20270118000000";
const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
let db: TestDb;
type User = { id: string; claims: Record<string, unknown> };
let editor: User;
let admin: User;
let before: Record<string, unknown>[];

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
const allSteps = () => q("select to_jsonb(s) - 'split' - 'split_notes' - 'tier_multiplier' - 'to_client_manager' as j, updated_at from public.steps s order by revision_id, id");

async function failure(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("expected the call to fail");
}

const SPLIT = { automatable: 0.5, augmentable: 0.3, manual: 0.2 };
const NOTES = { automatable: "Gather the numbers", augmentable: "Judge what they mean", manual: "Check it with the client" };
const TIERS = { T1: 1.5, T2: 1, T3: 0.7 };

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  editor = await createUser(db, "base-editor@example.com");
  admin = await createUser(db, "base-admin@example.com", { agency_admin: true });
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, editor.id]);
  await as(editor.claims, async (c) => {
    await rpc(c, "open_draft", proc);
    expect((await rpc(c, "publish_process", proc, true)).status).toBe("published");
    await rpc(c, "open_draft", proc);
  });
  before = await allSteps();
  const applied = await applyMigrations(db.client, {});
  expect(applied.files[0]).toBe("20270120000000_step_base_values.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("what the migration does to stored rows", () => {
  it("writes no step row: every step is as it was, the new columns are null and false, updated_at is unchanged", async () => {
    expect(before.length).toBeGreaterThan(20);
    const after = await allSteps();
    expect(after).toHaveLength(before.length);
    for (const [i, s] of after.entries()) {
      expect(s.j).toEqual(before[i]!.j);
      expect(s.updated_at).toEqual(before[i]!.updated_at);
    }
    expect(await q("select count(split) as a, count(split_notes) as b, count(tier_multiplier) as c, count(*) filter (where to_client_manager) as d from steps")).toEqual([{ a: "0", b: "0", c: "0", d: "0" }]);
  });

  it("the constraints are validated", async () => {
    const rows = await q("select conname, convalidated from pg_constraint where conname in ('steps_split', 'steps_split_notes', 'steps_tier_multiplier') order by conname");
    expect(rows).toEqual([
      { conname: "steps_split", convalidated: true },
      { conname: "steps_split_notes", convalidated: true },
      { conname: "steps_tier_multiplier", convalidated: true },
    ]);
  });
});

describe("the columns' checks", () => {
  const audit = northbeamStepIds.audit;
  const set = (column: string, value: unknown) =>
    db.client.query(`update public.steps set ${column} = $1::jsonb where id = $2 and revision_id = (select draft_revision_id from processes where id = $3)`, [JSON.stringify(value), audit, proc]);
  const clear = () => db.client.query("update public.steps set split = null, split_notes = null, tier_multiplier = null, to_client_manager = false where id = $1", [audit]);

  it("accepts a split that adds up to 1 (within 0.001), with zeros and ones", async () => {
    for (const ok of [SPLIT, { automatable: 1, augmentable: 0, manual: 0 }, { automatable: 0.333, augmentable: 0.333, manual: 0.334 }, { automatable: 0.3335, augmentable: 0.3333, manual: 0.3333 }]) {
      await set("split", ok);
    }
    await clear();
  });

  it("refuses a split that doesn't add up, has a missing, extra, negative or text part, or isn't an object (23514)", async () => {
    const bad: unknown[] = [
      { automatable: 0.5, augmentable: 0.3, manual: 0.3 },
      { automatable: 0.5, augmentable: 0.3, manual: 0.1 },
      { automatable: 0.5, augmentable: 0.5 },
      { ...SPLIT, other: 0 },
      { automatable: -0.2, augmentable: 0.7, manual: 0.5 },
      { automatable: 1.5, augmentable: -0.5, manual: 0 },
      { automatable: "0.5", augmentable: 0.3, manual: 0.2 },
      [0.5, 0.3, 0.2],
      0.5,
      {},
    ];
    for (const b of bad) expect((await failure(() => set("split", b))).code, JSON.stringify(b)).toBe("23514");
  });

  it("split_notes: a line for each part, one line, up to 300 characters", async () => {
    await set("split_notes", NOTES);
    await set("split_notes", { manual: "Only this one" });
    await clear();
    for (const b of [{ other: "x" }, { manual: 3 }, { manual: "two\nlines" }, { manual: "x".repeat(301) }, ["x"], "x"]) {
      expect((await failure(() => set("split_notes", b))).code, JSON.stringify(b)).toBe("23514");
    }
  });

  it("tier_multiplier: a number of 0 or more for each tier key", async () => {
    await set("tier_multiplier", TIERS);
    await set("tier_multiplier", { T1: 0 });
    await set("tier_multiplier", {});
    await clear();
    for (const b of [{ T1: -1 }, { T1: "2" }, { T1: 101 }, { "": 1 }, { ["x".repeat(41)]: 1 }, [1], 1]) {
      expect((await failure(() => set("tier_multiplier", b))).code, JSON.stringify(b)).toBe("23514");
    }
  });

  it("to_client_manager is a yes or no that defaults to no and can't be null", async () => {
    await db.client.query("update public.steps set to_client_manager = true where id = $1", [audit]);
    expect((await failure(() => db.client.query("update public.steps set to_client_manager = null where id = $1", [audit]))).code).toBe("23502");
    await clear();
  });

  it("is saved through save_fields with compare-and-set, on the draft only", async () => {
    const draft = (await q("select draft_revision_id as d, live_revision_id as l from processes where id = $1", [proc]))[0]!;
    const key = (rev: unknown) => JSON.stringify({ revision_id: rev, id: audit });
    const saved = await as(editor.claims, (c) => rpc(c, "save_fields", "steps", key(draft.d), JSON.stringify({ split: null, to_client_manager: false }), JSON.stringify({ split: SPLIT, to_client_manager: true })));
    expect(saved.status).toBe("saved");
    const stale = await as(editor.claims, (c) => rpc(c, "save_fields", "steps", key(draft.d), JSON.stringify({ split: null }), JSON.stringify({ split: { automatable: 0, augmentable: 0, manual: 1 } })));
    expect(stale.status).toBe("conflict");
    expect(stale.conflicts).toEqual({ split: SPLIT });
    const e = await failure(() => as(editor.claims, (c) => rpc(c, "save_fields", "steps", key(draft.d), JSON.stringify({ split: SPLIT }), JSON.stringify({ split: { automatable: 0.9, augmentable: 0.9, manual: 0.9 } }))));
    expect(e.code).toBe("23514");
    const live = await failure(() => as(editor.claims, (c) => rpc(c, "save_fields", "steps", key(draft.l), JSON.stringify({ to_client_manager: false }), JSON.stringify({ to_client_manager: true }))));
    expect(live.code).toBe("55000");
    await clear();
  });
});

describe("recurrences", () => {
  const valid = async (r: unknown) => (await q("select private.is_recurrence($1::jsonb) as ok", [JSON.stringify(r)]))[0]!.ok as boolean;

  it("every recurrence that was valid still is", async () => {
    for (const r of [{ every: "month", times: 1 }, { every: "week", times: 0.5 }, { every: "month", times: 100 }, { poisson_per_month: 3 }, { poisson_per_month: 1000 }]) expect(await valid(r), JSON.stringify(r)).toBe(true);
    for (const r of [{ every: "year", times: 1 }, { every: "month", times: 0 }, { every: "month", times: 101 }, { every: "month" }, { poisson_per_month: 0 }, { poisson_per_month: 1001 }, { every: "month", times: 1, extra: 1 }, {}, [], "month", null]) {
      expect(await valid(r), JSON.stringify(r)).toBe(false);
    }
  });

  it("accepts a driver recurrence, with or without per", async () => {
    for (const driver of ["words", "links", "techHours", "meetings", "builds", "creativeSets", "channels", "adhoc"]) expect(await valid({ perMonth: 1, driver }), driver).toBe(true);
    expect(await valid({ perMonth: 4, driver: "words", per: 1000 })).toBe(true);
    expect(await valid({ perMonth: 0.15, driver: "meetings" })).toBe(true);
  });

  it("refuses a bad driver, a bad count, a bad per, an extra key and the wrong types", async () => {
    for (const r of [
      { perMonth: 1, driver: "pages" },
      { perMonth: 1 },
      { driver: "words" },
      { perMonth: 0, driver: "words" },
      { perMonth: -1, driver: "words" },
      { perMonth: 1001, driver: "words" },
      { perMonth: "1", driver: "words" },
      { perMonth: 1, driver: "words", per: 0 },
      { perMonth: 1, driver: "words", per: "1000" },
      { perMonth: 1, driver: "words", extra: 1 },
      { perMonth: 1, driver: "words", every: "month" },
      { perMonth: 1, driver: 3 },
    ]) {
      expect(await valid(r), JSON.stringify(r)).toBe(false);
    }
  });

  it("a servicing link takes a driver recurrence and refuses a bad one (23514)", async () => {
    const [link] = await q("select id, recurrence from service_servicing where workspace_id = $1 limit 1", [ws]);
    await db.client.query("update service_servicing set recurrence = $2::jsonb where id = $1", [link!.id, JSON.stringify({ perMonth: 4, driver: "words", per: 1000 })]);
    expect((await q("select recurrence from service_servicing where id = $1", [link!.id]))[0]!.recurrence).toEqual({ perMonth: 4, driver: "words", per: 1000 });
    const e = await failure(() => db.client.query("update service_servicing set recurrence = $2::jsonb where id = $1", [link!.id, JSON.stringify({ perMonth: 4, driver: "pages" })]));
    expect(e.code).toBe("23514");
    await db.client.query("update service_servicing set recurrence = $2::jsonb where id = $1", [link!.id, JSON.stringify(link!.recurrence)]);
  });
});

describe("copying a step row carries the new columns", () => {
  const audit = northbeamStepIds.audit;
  const draftOf = async () => (await q("select draft_revision_id from processes where id = $1", [proc]))[0]!.draft_revision_id as string;
  const liveOf = async () => (await q("select live_revision_id from processes where id = $1", [proc]))[0]!.live_revision_id as string;
  const values = (rev: string) =>
    q("select split, split_notes, tier_multiplier, to_client_manager, provenance -> 'split' as p from steps where revision_id = $1 and id = $2", [rev, audit]).then((r) => r[0]!);
  const EXPECTED = { split: SPLIT, split_notes: NOTES, tier_multiplier: TIERS, to_client_manager: true, p: { source: "interview", at: "2026-10-31T00:00:00Z" } };

  it("a draft publishes, and the next draft (open_draft) starts with them", async () => {
    const draft = await draftOf();
    await db.client.query(
      "update steps set split = $3::jsonb, split_notes = $4::jsonb, tier_multiplier = $5::jsonb, to_client_manager = true, provenance = provenance || jsonb_build_object('split', $6::jsonb) where revision_id = $1 and id = $2",
      [draft, audit, JSON.stringify(SPLIT), JSON.stringify(NOTES), JSON.stringify(TIERS), JSON.stringify(EXPECTED.p)],
    );
    await as(editor.claims, (c) => rpc(c, "publish_process", proc, true));
    expect(await values(await liveOf())).toEqual(EXPECTED);
    const next = (await as(editor.claims, (c) => rpc(c, "open_draft", proc))).revision_id as string;
    expect(await values(next)).toEqual(EXPECTED);
    const none = (await q("select private.revision_changes($1, $2) as r", [await liveOf(), next]))[0]!.r as { steps: { changed: unknown[] } };
    expect(none.steps.changed).toEqual([]);
  });

  it("a change to a base value is a change to publish (the version compare sees it)", async () => {
    const next = await draftOf();
    await as(editor.claims, (c) => rpc(c, "save_fields", "steps", JSON.stringify({ revision_id: next, id: audit }), JSON.stringify({ to_client_manager: true }), JSON.stringify({ to_client_manager: false })));
    const changed = (await q("select private.revision_changes($1, $2) as r", [await liveOf(), next]))[0]!.r as { steps: { changed: string[] } };
    expect(changed.steps.changed).toEqual([audit]);
    await as(editor.claims, (c) => rpc(c, "save_fields", "steps", JSON.stringify({ revision_id: next, id: audit }), JSON.stringify({ to_client_manager: false }), JSON.stringify({ to_client_manager: true })));
  });

  it("restore_version and duplicate_version carry them", async () => {
    // Publish again so the version above is superseded, then restore it (a live version can't be restored over itself).
    const live = await liveOf();
    await as(editor.claims, (c) => rpc(c, "publish_process", proc, true));
    expect(await liveOf()).not.toBe(live);
    const restored = await as(editor.claims, (c) => rpc(c, "restore_version", proc, live, true));
    expect(restored.status).toBe("restored");
    expect(await values(restored.revision_id as string)).toEqual(EXPECTED);
    const copy = await as(editor.claims, (c) => rpc(c, "duplicate_version", live, "A copy"));
    const copied = await q("select split, split_notes, tier_multiplier, to_client_manager from steps where revision_id = $1 and name = (select name from steps where revision_id = $2 and id = $3)", [copy.revision_id as string, live, audit]);
    expect(copied).toEqual([{ split: SPLIT, split_notes: NOTES, tier_multiplier: TIERS, to_client_manager: true }]);
  });
});

describe("the workspace bundle", () => {
  const audit = northbeamStepIds.audit;
  async function exportOf(workspaceId: string): Promise<WorkspaceBundle> {
    const bundle = await db.as(admin.claims, async (c) => {
      const read: TableReader = async (table, wsId) => {
        const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
        return (await c.query(`select to_jsonb(t) as j from (select * from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}) t`, [wsId])).rows.map((r) => r.j) as Row[];
      };
      const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
      return exportWorkspaceBundle(workspaceId, readWorkspace, read, { canEdit: true, now: new Date("2026-10-31T12:00:00Z") });
    });
    return JSON.parse(JSON.stringify(bundle)) as WorkspaceBundle;
  }

  it("exports the columns, and a restore into a new workspace brings them back", async () => {
    const bundle = await exportOf(ws);
    const plan = structuredClone(planWorkspaceImport(bundle, { canManage: true }).plan);
    const steps = plan.processes.flatMap((p) => p.steps as Row[]);
    const carried = steps.filter((s) => s.split != null);
    expect(carried.length).toBeGreaterThan(0);
    expect(carried[0]).toMatchObject({ split: SPLIT, split_notes: NOTES, tier_multiplier: TIERS, to_client_manager: true });
    // A step without a base value restores as it was.
    expect(steps.some((s) => s.split == null && s.to_client_manager === false)).toBe(true);
    const into = await as(admin.claims, async (c) => (await rpc(c, "create_workspace", "Restored", `base-restore-${Date.now()}`)) as string);
    await as(admin.claims, (c) => rpc(c, "import_workspace_bundle", into, JSON.stringify(plan), "backup.json"));
    const rows = await q("select split, split_notes, tier_multiplier, to_client_manager from steps where workspace_id = $1 and split is not null", [into]);
    expect(rows.length).toBe(carried.length);
    expect(rows[0]).toEqual({ split: SPLIT, split_notes: NOTES, tier_multiplier: TIERS, to_client_manager: true });
  });

  it("a restore refuses a split that doesn't add up, all or nothing", async () => {
    const bundle = await exportOf(ws);
    const plan = structuredClone(planWorkspaceImport(bundle, { canManage: true }).plan);
    (plan.processes[0]!.steps[0] as Row).split = { automatable: 0.9, augmentable: 0.9, manual: 0.9 };
    const into = await as(admin.claims, async (c) => (await rpc(c, "create_workspace", "Refused", `base-refused-${Date.now()}`)) as string);
    await failure(() => as(admin.claims, (c) => rpc(c, "import_workspace_bundle", into, JSON.stringify(plan), "backup.json")));
    expect((await q("select count(*) from processes where workspace_id = $1", [into]))[0]!.count).toBe((await q("select count(*) from processes where workspace_id = $1", [await as(admin.claims, async (c) => (await rpc(c, "create_workspace", "Empty", `base-empty-${Date.now()}`)) as string)]))[0]!.count);
  });
});

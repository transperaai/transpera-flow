import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// Editing the company map (issue #163, B11 slice 2, migration 20261127500000): editors work on it like any process (a
// draft, save, publish, version history, restore), the sync rule keeps history honest (a system-made published version per
// event, mirrored into an open draft, never an edit of a published version), restore keeps the holders' links, and what
// people drew is never deleted by sync. Made with Supabase's default table privileges, as production is. Each test builds
// its own workspace.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let viewer: { id: string; claims: Record<string, unknown> };

type Reply = Record<string, unknown> & { status: string };

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

async function commitAs<T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(db.client);
    await db.client.query("commit");
    return out;
  } catch (err) {
    await db.client.query("rollback");
    throw err;
  }
}

const rpc = async (c: pg.Client, fn: string, ...args: unknown[]): Promise<Reply> =>
  (await c.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r as Reply;

const save = (c: pg.Client, table: "steps" | "edges", revision: string, id: string, base: object, changes: object) =>
  rpc(c, "save_fields", table, JSON.stringify({ revision_id: revision, id }), JSON.stringify(base), JSON.stringify(changes));

interface World {
  ws: string;
  cid: string;
  sales: string;
  delivery: string;
  support: string;
}

let counter = 0;
/** A workspace with a company map and three top-level processes: Sales (pipeline), Delivery and Support (servicing). */
async function world(): Promise<World> {
  const n = ++counter;
  const [{ id: ws }] = await q("insert into workspaces (name, slug) values ($1, $2) returning id", [`Editing ${n}`, `editing-company-map-${n}`]);
  for (const [user, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
    await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.id, role]);
  }
  const [sales, delivery, support] = [randomUUID(), randomUUID(), randomUUID()];
  await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Sales', 'pipeline')", [sales, ws]);
  await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Delivery', 'servicing')", [delivery, ws]);
  await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Support', 'servicing')", [support, ws]);
  const [{ id: cid }] = await q("select id from processes where workspace_id = $1 and is_company", [ws]);
  return { ws, cid, sales, delivery, support };
}

/** `holder` gets a published version 1 holding `child` by a link (as publishing a draft from the library leaves it). */
async function liveHolding(w: World, holder: string, child: string, name: string) {
  const [rev] = await q("insert into process_revisions (workspace_id, process_id, number, status, published_at) values ($1, $2, 1, 'published', now()) returning id", [w.ws, holder]);
  await q("insert into steps (revision_id, workspace_id, process_id, name, kind, child_process_id) values ($1, $2, $3, $4, 'subprocess', $5)", [rev.id, w.ws, holder, name, child]);
  await q("update processes set live_revision_id = $2 where id = $1", [holder, rev.id]);
}

const processRow = async (id: string) => (await q("select live_revision_id, draft_revision_id from processes where id = $1", [id]))[0] as { live_revision_id: string; draft_revision_id: string | null };

/** A revision's holders (and other steps), by name. */
const stepsOf = (rev: string) => q("select id, name, kind, child_process_id, parent_step_id, x::float8 as x, y::float8 as y from steps where revision_id = $1 order by name, id", [rev]);

/** A revision's steps and edges without bookkeeping columns, to compare contents. */
async function snapshot(rev: string) {
  const strip = ({ revision_id: _r, created_at: _c, updated_at: _u, created_by: _b, ...rest }: Record<string, unknown>) => rest;
  return {
    steps: (await q("select * from steps where revision_id = $1 order by id", [rev])).map(strip),
    edges: (await q("select * from edges where revision_id = $1 order by id", [rev])).map(strip),
  };
}

const history = (cid: string) =>
  commitAs(editor.claims, async (c) => (await c.query("select revision_id, number, status, author_kind, note, changes from revision_history($1)", [cid])).rows) as Promise<
    { revision_id: string; number: number; status: string; author_kind: string | null; note: string | null; changes: { steps: Record<string, number>; edges: Record<string, number> } | null }[]
  >;

const openDraft = async (cid: string) => (await commitAs(editor.claims, (c) => rpc(c, "open_draft", cid))).revision_id as string;
const holderOf = async (rev: string, pid: string) => (await q("select id, name, x::float8 as x, y::float8 as y from steps where revision_id = $1 and child_process_id = $2", [rev, pid]))[0] as { id: string; name: string; x: number; y: number } | undefined;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@company-map-editing.example.com");
  viewer = await createUser(db, "viewer@company-map-editing.example.com");
});

afterAll(async () => {
  await db?.close();
});

describe("editing the company map like any process", () => {
  it("opens a draft, moves a card, draws and labels a handoff, publishes, lists the versions and restores one", async () => {
    const w = await world();
    const before = await processRow(w.cid);
    const draft = await openDraft(w.cid);
    // The draft starts as a copy of live: the same holders with the same ids.
    expect((await stepsOf(draft)).map((s) => [s.name, s.child_process_id])).toEqual((await stepsOf(before.live_revision_id)).map((s) => [s.name, s.child_process_id]));

    const sales = (await holderOf(draft, w.sales))!;
    const support = (await holderOf(draft, w.support))!;
    const delivery = (await holderOf(draft, w.delivery))!;
    // Move a card; draw a handoff from Delivery to Support and label it; relabel an existing line.
    await commitAs(editor.claims, async (c) => {
      expect((await save(c, "steps", draft, sales.id, { x: sales.x, y: sales.y }, { x: 40, y: 500 })).status).toBe("saved");
      await c.query("insert into edges (id, revision_id, workspace_id, process_id, from_step_id, to_step_id, probability, label) values ($1, $2, $3, $4, $5, $6, 1, 'Onboarding hand-off')", [
        randomUUID(), draft, w.ws, w.cid, delivery.id, support.id,
      ]);
      const [line] = (await c.query("select id, label from edges where revision_id = $1 and from_step_id = $2 and to_step_id = $3", [draft, sales.id, support.id])).rows;
      expect((await save(c, "edges", draft, line.id, { label: line.label }, { label: "Won deals" })).status).toBe("saved");
    });
    // Live is untouched until publish.
    expect((await processRow(w.cid)).live_revision_id).toBe(before.live_revision_id);
    expect((await holderOf(before.live_revision_id, w.sales))!.x).toBe(0);

    const published = await commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid));
    expect(published).toMatchObject({ status: "published", previous_revision_id: before.live_revision_id });
    const live = (await processRow(w.cid)).live_revision_id;
    expect(live).toBe(draft);
    expect(await holderOf(live, w.sales)).toMatchObject({ x: 40, y: 500 });
    expect((await q("select label from edges where revision_id = $1 and label is not null order by label", [live])).map((r) => r.label)).toEqual(["Onboarding hand-off", "Won deals"]);

    // History lists the versions: the user's publish on top, the system-made ones (one per process) below, newest first.
    const rows = await history(w.cid);
    expect(rows.map((r) => r.number)).toEqual([...rows.map((r) => r.number)].sort((a, b) => b - a));
    expect(rows[0]).toMatchObject({ status: "published", author_kind: "user", note: null });
    expect(rows[0]!.changes!.edges).toMatchObject({ added: 1, changed: 1 });
    // Moving a card is not a change.
    expect(rows[0]!.changes!.steps).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(rows.slice(1).map((r) => r.note)).toEqual(["Added Support", "Added Delivery", "Added Sales", null]);

    // Restore the version before the publish: it goes into a draft, live is unchanged until publish.
    const before2 = rows[1]!;
    const restored = await commitAs(editor.claims, (c) => rpc(c, "restore_version", w.cid, before2.revision_id));
    expect(restored).toMatchObject({ status: "restored", unlinked_children: 0, skipped_holders: 0, added_holders: 0 });
    const redraft = restored.revision_id as string;
    expect(await holderOf(redraft, w.sales)).toMatchObject({ x: 0, y: 0 });
    expect((await processRow(w.cid)).live_revision_id).toBe(live);
    // Every holder keeps its process (blocker b), and no handoff label survives from the later version.
    expect((await stepsOf(redraft)).map((s) => s.child_process_id).sort()).toEqual([w.sales, w.delivery, w.support].sort());
    expect((await q("select count(*)::int n from edges where revision_id = $1 and label is not null", [redraft]))[0].n).toBe(0);
    await commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid));
    expect((await processRow(w.cid)).live_revision_id).toBe(redraft);
    expect(await holderOf(redraft, w.sales)).toMatchObject({ x: 0 });
  });

  it("refuses everyone who may not edit, and every change to the map's own row", async () => {
    const w = await world();
    const live = (await processRow(w.cid)).live_revision_id;
    await expect(commitAs(viewer.claims, (c) => rpc(c, "open_draft", w.cid))).resolves.toMatchObject({ status: "not_found" });
    await expect(commitAs(viewer.claims, (c) => c.query("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 99, 'draft')", [w.ws, w.cid]))).rejects.toThrow();
    await expect(commitAs(viewer.claims, (c) => rpc(c, "restore_version", w.cid, live))).resolves.toMatchObject({ status: "not_found" });
    // An editor: no rename, no new kind, no parent, no deleting, no copy.
    await expect(commitAs(editor.claims, (c) => c.query("update processes set name = 'Our map' where id = $1", [w.cid]))).rejects.toThrow(/can't be renamed/);
    await expect(commitAs(editor.claims, (c) => c.query("update processes set kind = 'servicing' where id = $1", [w.cid]))).rejects.toThrow(/can't be renamed/);
    await expect(commitAs(editor.claims, (c) => c.query("update processes set parent_process_id = $2 where id = $1", [w.cid, w.sales]))).rejects.toThrow();
    await expect(commitAs(editor.claims, (c) => c.query("update processes set parent_process_id = $2 where id = $1", [w.sales, w.cid]))).rejects.toThrow(/can't be a process's parent/);
    await expect(commitAs(editor.claims, (c) => c.query("delete from processes where id = $1", [w.cid]))).rejects.toThrow(/can't be deleted/);
    await expect(commitAs(editor.claims, (c) => rpc(c, "duplicate_version", live, "Copy"))).resolves.toEqual({ status: "not_found" });
    expect((await q("select count(*)::int n from processes where workspace_id = $1 and name = 'Copy'", [w.ws]))[0].n).toBe(0);
  });

  it("lets an editor take a card off a draft (the link only), and discarding a draft and moving cards work", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    const holder = (await holderOf(draft, w.support))!;
    // (Taking a card off, and what it leaves alone, is tested in process-library.test.ts.)
    // A group an editor made is theirs to delete.
    const group = randomUUID();
    await commitAs(editor.claims, async (c) => {
      await c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, x, y) values ($1, $2, $3, $4, 'Delivery team', 'group', 0, 0)", [group, draft, w.ws, w.cid]);
      await c.query("update steps set parent_step_id = $3 where revision_id = $1 and id = $2", [draft, holder.id, group]);
    });
    await commitAs(editor.claims, (c) => c.query("update steps set parent_step_id = null where revision_id = $1 and id = $2", [draft, holder.id]));
    await commitAs(editor.claims, (c) => c.query("delete from steps where revision_id = $1 and id = $2", [draft, group]));
    // Discarding the draft removes it with its holders (a cascade, not the editor deleting them).
    await expect(commitAs(editor.claims, (c) => rpc(c, "discard_draft", w.cid))).resolves.toMatchObject({ status: "discarded" });
    expect((await processRow(w.cid)).draft_revision_id).toBeNull();
    expect((await q("select count(*)::int n from steps where revision_id = $1", [draft]))[0].n).toBe(0);
  });
});

describe("the sync rule: a system-made version per event, never an edit of a published one", () => {
  it("makes a new published version for a created, renamed, nested, taken-out, re-kinded and deleted process, and leaves old versions untouched", async () => {
    const w = await world();
    const versions = async () => (await q("select id, number, status from process_revisions where process_id = $1 order by number", [w.cid])) as { id: string; number: number; status: string }[];
    const noteOf = async (rev: string) => (await history(w.cid)).find((r) => r.revision_id === rev)?.note;
    const live = async () => (await processRow(w.cid)).live_revision_id;

    const l1 = await live();
    const snap1 = await snapshot(l1);
    const extra = randomUUID();
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Partnerships', 'pipeline')", [extra, w.ws]);
    const l2 = await live();
    expect(l2).not.toBe(l1);
    // The earlier version is exactly as it was, and now superseded; the new one is published, made by the system.
    expect(await snapshot(l1)).toEqual(snap1);
    expect((await q("select status from process_revisions where id = $1", [l1]))[0].status).toBe("superseded");
    expect((await q("select status, published_by from process_revisions where id = $1", [l2]))[0]).toEqual({ status: "published", published_by: null });
    expect(await noteOf(l2)).toBe("Added Partnerships");
    expect((await history(w.cid)).find((r) => r.revision_id === l2)).toMatchObject({ author_kind: "system", number: (await versions()).at(-1)!.number });
    expect(await holderOf(l1, extra)).toBeUndefined();
    expect(await holderOf(l2, extra)).toMatchObject({ x: 0, y: 160 });

    // Renamed: the new version has the new name, the one before keeps the old.
    const snap2 = await snapshot(l2);
    await q("update processes set name = 'Partners' where id = $1", [extra]);
    const l3 = await live();
    expect(await snapshot(l2)).toEqual(snap2);
    expect((await holderOf(l2, extra))!.name).toBe("Partnerships");
    expect((await holderOf(l3, extra))!.name).toBe("Partners");
    expect(await noteOf(l3)).toBe("Renamed Partnerships to Partners");

    // Nested under another process: off the map in a new version; the one before still has it.
    await q("update processes set parent_process_id = $1 where id = $2", [w.sales, extra]);
    const l4 = await live();
    expect(await holderOf(l4, extra)).toBeUndefined();
    expect(await holderOf(l3, extra)).toBeDefined();
    expect(await noteOf(l4)).toBe("Removed Partners from the map: it now sits inside another process");

    // Taken out again: back on the map, at the bottom of its column.
    await q("update processes set parent_process_id = null where id = $1", [extra]);
    const l5 = await live();
    expect(await holderOf(l5, extra)).toMatchObject({ x: 0 });
    expect(await noteOf(l5)).toBe("Added Partners");

    // Re-kinded: it moves to the other column, keeping its lines.
    const linesBefore = (await q("select count(*)::int n from edges where revision_id = $1", [l5]))[0].n;
    await q("update processes set kind = 'servicing' where id = $1", [extra]);
    const l6 = await live();
    expect(await holderOf(l6, extra)).toMatchObject({ x: 288 });
    expect((await holderOf(l5, extra))!.x).toBe(0);
    expect((await q("select count(*)::int n from edges where revision_id = $1", [l6]))[0].n).toBe(linesBefore);
    expect(await noteOf(l6)).toBe("Partners is now a servicing process");

    // Deleted: off the map; every version it was in keeps its card (now unlinked: the process is gone).
    await q("delete from processes where id = $1", [extra]);
    const l7 = await live();
    expect(await noteOf(l7)).toBe("Removed Partners");
    expect(await stepsOf(l7)).toHaveLength(3);
    expect(await stepsOf(l5)).toHaveLength(4);
    expect((await q("select count(*)::int n from steps where revision_id = $1 and kind = 'subprocess' and child_process_id is null", [l5]))[0].n).toBe(1);

    // Nothing to say, no new version: a description, a rename to the same name, a kind that did not change.
    const count = (await versions()).length;
    await q("update processes set description = 'New words', name = name, kind = kind where id = $1", [w.sales]);
    await q("update processes set name = 'Sales' where id = $1", [w.sales]);
    expect((await versions()).length).toBe(count);
    // Version numbers are one apart and every published one but the newest is superseded.
    const all = await versions();
    expect(all.map((v) => v.number)).toEqual(all.map((_, i) => i + 1));
    expect(all.filter((v) => v.status === "published")).toHaveLength(1);
  });

  it("applies each event to an open draft too, and keeps what the person did in it", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    // The person moved Sales, and renamed Delivery's card, in the draft.
    const sales = (await holderOf(draft, w.sales))!;
    const delivery = (await holderOf(draft, w.delivery))!;
    await commitAs(editor.claims, async (c) => {
      await save(c, "steps", draft, sales.id, { x: sales.x, y: sales.y }, { x: 600, y: 600 });
      await save(c, "steps", draft, delivery.id, { name: delivery.name }, { name: "Our delivery" });
    });
    const live0 = (await processRow(w.cid)).live_revision_id;

    // A new process: a holder in the draft (once), at the bottom of its column, and the person's changes stay.
    const alpha = randomUUID();
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Alpha', 'pipeline')", [alpha, w.ws]);
    expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id = $2", [draft, alpha]))[0].n).toBe(1);
    expect(await holderOf(draft, w.sales)).toMatchObject({ x: 600, y: 600 });
    expect(await holderOf(draft, alpha)).toMatchObject({ x: 0 });
    const live1 = (await processRow(w.cid)).live_revision_id;
    expect(live1).not.toBe(live0);
    expect((await processRow(w.cid)).draft_revision_id).toBe(draft);

    // A rename: live follows; the draft follows too, except the card the person renamed.
    await q("update processes set name = 'Delivery v2' where id = $1", [w.delivery]);
    await q("update processes set name = 'Sales v2' where id = $1", [w.sales]);
    expect((await holderOf(draft, w.delivery))!.name).toBe("Our delivery");
    expect((await holderOf(draft, w.sales))!.name).toBe("Sales v2");
    expect((await holderOf((await processRow(w.cid)).live_revision_id, w.delivery))!.name).toBe("Delivery v2");

    // A kind change moves a card the person has not moved; one they have moved stays where they put it.
    await q("update processes set kind = 'servicing' where id = $1", [alpha]);
    expect(await holderOf(draft, alpha)).toMatchObject({ x: 288 });
    await q("update processes set kind = 'servicing' where id = $1", [w.sales]);
    expect(await holderOf(draft, w.sales)).toMatchObject({ x: 600, y: 600 });

    // The person's draft publishes without a clash, and carries their changes.
    const published = await commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid));
    expect(published.status).toBe("published");
    const live = (await processRow(w.cid)).live_revision_id;
    expect(await holderOf(live, w.sales)).toMatchObject({ x: 600, name: "Sales v2" });
    expect((await holderOf(live, w.delivery))!.name).toBe("Our delivery");
    expect((await q("select number from process_revisions where id = $1", [live]))[0].number).toBeGreaterThan(live1 === live ? 0 : (await q("select number from process_revisions where id = $1", [live1]))[0].number);
  });

  it("never deletes a subprocess or group step a person drew, in live or in a draft", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    const group = randomUUID();
    const lone = randomUUID();
    const support = (await holderOf(draft, w.support))!;
    await commitAs(editor.claims, async (c) => {
      await c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, x, y) values ($1, $2, $3, $4, 'Service teams', 'group', 300, 300)", [group, draft, w.ws, w.cid]);
      // An empty holder-shaped step: kind subprocess with no process, which the old reconciler deleted.
      await c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, x, y) values ($1, $2, $3, $4, 'Placeholder', 'subprocess', 600, 300)", [lone, draft, w.ws, w.cid]);
      await c.query("update steps set parent_step_id = $3 where revision_id = $1 and id = $2", [draft, support.id, group]);
    });
    // In the draft: an event leaves them alone.
    const beta = randomUUID();
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Beta', 'pipeline')", [beta, w.ws]);
    const kept = (await stepsOf(draft)).map((s) => s.name);
    expect(kept).toEqual(expect.arrayContaining(["Service teams", "Placeholder", "Beta"]));
    expect((await holderOf(draft, w.support)) && (await q("select parent_step_id from steps where revision_id = $1 and id = $2", [draft, support.id]))[0].parent_step_id).toBe(group);

    // Published, then an event: the system-made version keeps them too.
    await commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid));
    const published = (await processRow(w.cid)).live_revision_id;
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Gamma', 'pipeline')", [randomUUID(), w.ws]);
    const after = (await processRow(w.cid)).live_revision_id;
    expect(after).not.toBe(published);
    expect((await stepsOf(after)).map((s) => s.name)).toEqual(expect.arrayContaining(["Service teams", "Placeholder", "Gamma"]));
    expect((await q("select parent_step_id from steps where revision_id = $1 and child_process_id = $2", [after, w.support]))[0].parent_step_id).toBe(group);
    // A process deleted that sat in a group: only its own card goes.
    await q("delete from processes where id = $1", [w.support]);
    const last = (await processRow(w.cid)).live_revision_id;
    expect((await stepsOf(last)).map((s) => s.name)).toEqual(expect.arrayContaining(["Service teams", "Placeholder"]));
    expect(await holderOf(last, w.support)).toBeUndefined();
  });

  it("does not put back a holder that is gone from a draft, whatever else happens to the processes", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    const delivery = (await holderOf(draft, w.delivery))!;
    // A person took the card off the draft (the process library's Remove from the map).
    await q("delete from steps where revision_id = $1 and id = $2", [draft, delivery.id]);
    await q("insert into processes (workspace_id, name, kind) values ($1, 'Epsilon', 'pipeline')", [w.ws]);
    await q("update processes set name = 'Delivery 2' where id = $1", [w.delivery]);
    await q("update processes set kind = 'servicing' where id = $1", [w.sales]);
    expect(await holderOf(draft, w.delivery)).toBeUndefined();
    expect((await stepsOf(draft)).map((s) => s.name)).toContain("Epsilon");
  });
});

describe("restoring a version of the company map re-links its processes", () => {
  it("keeps the links, skips a process that is gone or now nested, adds one made since, and says so", async () => {
    const w = await world();
    const rows = await history(w.cid);
    const full = rows[0]!; // every holder the world made
    // Later: Support is deleted, Delivery nests under Sales, a new process appears. Nested means held by Sales's LIVE version
    // (B12: "inside" comes from the live links; the old parent column only takes it off the map, as MCP's import still sets it).
    await q("delete from processes where id = $1", [w.support]);
    await q("update processes set parent_process_id = $1 where id = $2", [w.sales, w.delivery]);
    await liveHolding(w, w.sales, w.delivery, "Delivery");
    const newer = randomUUID();
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Newer', 'pipeline')", [newer, w.ws]);
    await q("update processes set name = 'Sales (renamed)' where id = $1", [w.sales]);

    const restored = await commitAs(editor.claims, (c) => rpc(c, "restore_version", w.cid, full.revision_id));
    expect(restored).toMatchObject({ status: "restored", unlinked_children: 0, skipped_holders: 2, added_holders: 1 });
    const draft = restored.revision_id as string;
    const holders = await q("select child_process_id, name, kind from steps where revision_id = $1 order by name", [draft]);
    // Sales is re-linked (and called what it is called now); the gone and the nested are skipped; Newer is added.
    expect(holders.map((h) => [h.name, h.child_process_id])).toEqual([["Newer", newer], ["Sales (renamed)", w.sales]]);
    expect(holders.every((h) => h.kind === "subprocess")).toBe(true);
    // Lines to a skipped holder went with it; none points at a step the draft lacks.
    expect((await q("select count(*)::int n from edges e where e.revision_id = $1 and not (exists (select 1 from steps s where s.revision_id = e.revision_id and s.id = e.from_step_id) and exists (select 1 from steps s where s.revision_id = e.revision_id and s.id = e.to_step_id))", [draft]))[0].n).toBe(0);
    // The audit entry says how many.
    const [entry] = await q("select diff from audit_log where target_id = $1 and action = 'restore_version' order by created_at desc limit 1", [w.cid]);
    expect(entry.diff).toMatchObject({ skipped_holders: 2, added_holders: 1 });
    // The live version is unchanged until it is published, and it publishes.
    expect((await processRow(w.cid)).live_revision_id).not.toBe(draft);
    await expect(commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid))).resolves.toMatchObject({ status: "published" });
  });

  it("a group whose first step was skipped loses that entry rather than the restore failing", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    const group = randomUUID();
    const support = (await holderOf(draft, w.support))!;
    await commitAs(editor.claims, async (c) => {
      await c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, x, y) values ($1, $2, $3, $4, 'Service teams', 'group', 300, 300)", [group, draft, w.ws, w.cid]);
      await c.query("update steps set parent_step_id = $3 where revision_id = $1 and id = $2", [draft, support.id, group]);
      await c.query("update steps set entry_step_id = $3 where revision_id = $1 and id = $2", [draft, group, support.id]);
    });
    await commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid));
    const withGroup = (await processRow(w.cid)).live_revision_id;
    // A newer version, then Support goes: the old version's card for it is skipped on restore.
    await q("insert into processes (workspace_id, name, kind) values ($1, 'Zeta', 'pipeline')", [w.ws]);
    await q("delete from processes where id = $1", [w.support]);
    const restored = await commitAs(editor.claims, (c) => rpc(c, "restore_version", w.cid, withGroup));
    expect(restored).toMatchObject({ status: "restored", skipped_holders: 1 });
    const [g] = await q("select entry_step_id from steps where revision_id = $1 and id = $2", [restored.revision_id, group]);
    expect(g.entry_step_id).toBeNull();
  });

  it("restores an ordinary process as before: a child that is not inside it any more is unlinked and counted", async () => {
    const w = await world();
    // Sales holds a child process in its draft; the child is then moved out, and an old version holding it is restored.
    const child = randomUUID();
    await q("insert into processes (id, workspace_id, name, kind, parent_process_id) values ($1, $2, 'Qualify', 'pipeline', $3)", [child, w.ws, w.sales]);
    const [salesRev] = await q("insert into process_revisions (workspace_id, process_id, number, status, published_at) values ($1, $2, 1, 'published', now()) returning id", [w.ws, w.sales]);
    await q("update processes set live_revision_id = $2 where id = $1", [w.sales, salesRev.id]);
    await q("insert into steps (revision_id, workspace_id, process_id, name, kind, child_process_id) values ($1, $2, $3, 'Qualify', 'subprocess', $4)", [salesRev.id, w.ws, w.sales, child]);
    const [second] = await q("insert into process_revisions (workspace_id, process_id, number, status, published_at) values ($1, $2, 2, 'superseded', now()) returning id", [w.ws, w.sales]);
    await q("insert into steps (revision_id, workspace_id, process_id, name, kind, child_process_id) values ($1, $2, $3, 'Qualify', 'subprocess', $4)", [second.id, w.ws, w.sales, child]);
    await q("delete from steps where revision_id = $1", [salesRev.id]);
    // Moved out: Delivery's live version holds it now (B12: where a process sits is its live holder).
    await q("update processes set parent_process_id = $2 where id = $1", [child, w.delivery]);
    await liveHolding(w, w.delivery, child, "Qualify");
    const restored = await commitAs(editor.claims, (c) => rpc(c, "restore_version", w.sales, second.id));
    expect(restored).toMatchObject({ status: "restored", unlinked_children: 1, skipped_holders: 0, added_holders: 0 });
    expect((await q("select child_process_id, kind from steps where revision_id = $1", [restored.revision_id]))[0]).toEqual({ child_process_id: null, kind: "subprocess" });
  });
});

describe("review fixes: nothing takes a card off the map, history is kept, drafts stay equal to live, bulk is one version", () => {
  const untouched = { steps: { added: [], removed: [], changed: [] }, edges: { added: [], removed: [], changed: [] } };
  const changesOf = async (w: World) => {
    const p = await processRow(w.cid);
    return (await q("select private.revision_changes($1, $2) as r", [p.live_revision_id, p.draft_revision_id]))[0].r;
  };

  it("takes a card off the map only by deleting it from a draft: not by unlinking it, and not from a published version", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    const card = (await holderOf(draft, w.support))!;
    const offMap = /taken off the company map by removing its card in a draft/;
    await expect(commitAs(editor.claims, (c) => c.query("update steps set child_process_id = null where revision_id = $1 and id = $2", [draft, card.id]))).rejects.toThrow(offMap);
    await expect(commitAs(editor.claims, (c) => c.query("update steps set child_process_id = $3 where revision_id = $1 and id = $2", [draft, card.id, w.delivery]))).rejects.toThrow(offMap);
    await expect(commitAs(editor.claims, (c) => save(c, "steps", draft, card.id, { child_process_id: w.support }, { child_process_id: null }))).rejects.toThrow(offMap);
    // A published version is never edited (the card stays in it).
    const live = (await processRow(w.cid)).live_revision_id;
    const liveCard = (await holderOf(live, w.support))!;
    await expect(commitAs(editor.claims, (c) => c.query("delete from steps where revision_id = $1 and id = $2", [live, liveCard.id]))).rejects.toThrow(offMap);
    expect(await holderOf(live, w.support)).toBeDefined();
    // A card in a group, and the group in another: deleting a group in the draft takes the card with it.
    const [inner, outer] = [randomUUID(), randomUUID()];
    await commitAs(editor.claims, async (c) => {
      await c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, x, y) values ($1, $3, $4, $5, 'Inner', 'group', 0, 0), ($2, $3, $4, $5, 'Outer', 'group', 0, 0)", [inner, outer, draft, w.ws, w.cid]);
      await c.query("update steps set parent_step_id = $2 where revision_id = $1 and id = $3", [draft, outer, inner]);
      await c.query("update steps set parent_step_id = $2 where revision_id = $1 and id = $3", [draft, inner, card.id]);
    });
    await commitAs(editor.claims, (c) => c.query("delete from steps where revision_id = $1 and id = $2", [draft, outer]));
    expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id = $2", [draft, w.support]))[0].n).toBe(0);
    // The process itself is as it was.
    expect((await q("select count(*)::int n from processes where id = $1 and parent_process_id is null", [w.support]))[0].n).toBe(1);
  });

  it("keeps history: only drafts are made or deleted, status moves only as publishing moves it, pointers name the right versions", async () => {
    const w = await world();
    const live = (await processRow(w.cid)).live_revision_id;
    const [old] = await q("select id from process_revisions where process_id = $1 and status = 'superseded' order by number limit 1", [w.cid]);
    const [{ number }] = await q("select max(number)::int number from process_revisions where process_id = $1", [w.cid]);
    const bad = (sql: string, params: unknown[]) => expect(commitAs(editor.claims, (c) => c.query(sql, params))).rejects.toThrow();
    await bad("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, $3, 'superseded')", [w.ws, w.cid, number + 1]);
    await bad("insert into process_revisions (workspace_id, process_id, number, status, published_at) values ($1, $2, $3, 'published', now())", [w.ws, w.cid, number + 1]);
    await bad("delete from process_revisions where id = $1", [old.id]);
    await bad("delete from process_revisions where id = $1", [live]);
    await bad("update process_revisions set status = 'draft' where id = $1", [old.id]);
    await bad("update process_revisions set status = 'draft' where id = $1", [live]);
    await bad("update process_revisions set status = 'published' where id = $1", [old.id]);
    await bad("update processes set live_revision_id = $2 where id = $1", [w.cid, old.id]);
    const draft = await openDraft(w.cid);
    await bad("update processes set draft_revision_id = $2 where id = $1", [w.cid, live]);
    // What publishing does still works, and so does discarding.
    await expect(commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid))).resolves.toMatchObject({ status: "published" });
    expect((await processRow(w.cid)).live_revision_id).toBe(draft);
    await openDraft(w.cid);
    await expect(commitAs(editor.claims, (c) => rpc(c, "discard_draft", w.cid))).resolves.toMatchObject({ status: "discarded" });
  });

  it("mirrors events into an untouched draft with live's own rows: no phantom changes, so restore and publish see only the person's work", async () => {
    const w = await world();
    await openDraft(w.cid);
    expect(await changesOf(w)).toEqual(untouched);
    const extra = randomUUID();
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Partnerships', 'pipeline')", [extra, w.ws]);
    expect(await changesOf(w)).toEqual(untouched);
    await q("update processes set name = 'Partners' where id = $1", [extra]);
    expect(await changesOf(w)).toEqual(untouched);
    await q("update processes set kind = 'servicing' where id = $1", [extra]);
    expect(await changesOf(w)).toEqual(untouched);
    await q("delete from processes where id = $1", [extra]);
    expect(await changesOf(w)).toEqual(untouched);
    // An untouched draft is replaced by a restore without asking.
    const [first] = await q("select id from process_revisions where process_id = $1 and status = 'superseded' order by number limit 1", [w.cid]);
    await expect(commitAs(editor.claims, (c) => rpc(c, "restore_version", w.cid, first.id))).resolves.toMatchObject({ status: "restored" });
  });

  it("makes one system version for a bulk create, quickly", async () => {
    const w = await world();
    const count = async () => (await q("select count(*)::int n from process_revisions where process_id = $1", [w.cid]))[0].n as number;
    const before = await count();
    const started = Date.now();
    await q("insert into processes (workspace_id, name, kind) select $1, 'Bulk ' || i, 'pipeline' from generate_series(1, 60) i", [w.ws]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await count()).toBe(before + 1);
    const live = (await processRow(w.cid)).live_revision_id;
    expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id is not null", [live]))[0].n).toBe(63);
    expect((await history(w.cid))[0]!.note).toMatch(/^Added Bulk 1; Added Bulk 2/);
    // Separate transactions stay separate versions.
    await q("insert into processes (workspace_id, name, kind) values ($1, 'Later', 'pipeline')", [w.ws]);
    expect(await count()).toBe(before + 2);
  });

  it("keeps a placeholder a person drew when restoring, and skips the card of a process that was deleted", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    await commitAs(editor.claims, (c) => c.query("insert into steps (revision_id, workspace_id, process_id, name, kind, x, y) values ($1, $2, $3, 'Placeholder', 'subprocess', 700, 0)", [draft, w.ws, w.cid]));
    await commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid));
    const withPlaceholder = (await processRow(w.cid)).live_revision_id;
    await q("delete from processes where id = $1", [w.support]);
    const restored = await commitAs(editor.claims, (c) => rpc(c, "restore_version", w.cid, withPlaceholder));
    expect(restored).toMatchObject({ status: "restored", skipped_holders: 1 });
    const names = (await stepsOf(restored.revision_id as string)).map((s) => s.name);
    expect(names).toContain("Placeholder");
    expect(names).not.toContain("Support");
  });

  it("checks a card added while another transaction nests its process after that transaction, so it is not on the map twice", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    const extra = randomUUID();
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Racer', 'pipeline')", [extra, w.ws]);
    await q("delete from steps where revision_id = $1 and child_process_id = $2", [draft, extra]);
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    try {
      await db.client.query("begin");
      await db.client.query("insert into steps (revision_id, workspace_id, process_id, name, kind, child_process_id, x, y) values ($1, $2, $3, 'Racer', 'subprocess', $4, 0, 900)", [draft, w.ws, w.cid, extra]);
      await db.client.query("set constraints all immediate");
      const nesting = other.query("update processes set parent_process_id = $1 where id = $2", [w.sales, extra]);
      await new Promise((r) => setTimeout(r, 300));
      await db.client.query("commit");
      await nesting;
      const p = await processRow(w.cid);
      for (const rev of [p.live_revision_id, p.draft_revision_id!]) expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id = $2", [rev, extra]))[0].n).toBe(0);
    } finally {
      await other.end();
    }
  });
});

describe("rows stay in the version and process they were made in", () => {
  /** A published first version for an ordinary process, and the editor's draft of it. */
  async function draftOf(w: World, pid: string): Promise<string> {
    const [{ id: rev }] = await q("insert into process_revisions (workspace_id, process_id, number, status, published_at) values ($1, $2, 1, 'published', now()) returning id", [w.ws, pid]);
    await q("update processes set live_revision_id = $2 where id = $1", [pid, rev]);
    await q("insert into steps (revision_id, workspace_id, process_id, name, kind) values ($1, $2, $3, 'First', 'task')", [rev, w.ws, pid]);
    return (await commitAs(editor.claims, (c) => rpc(c, "open_draft", pid))).revision_id as string;
  }

  it("refuses moving a card of the map into another process's draft, and moving the map's draft to another process", async () => {
    const w = await world();
    const mapDraft = await openDraft(w.cid);
    const salesDraft = await draftOf(w, w.sales);
    const card = (await holderOf(mapDraft, w.support))!;
    // Its lines first, as the editor would: then nothing else stands in the way.
    await commitAs(editor.claims, (c) => c.query("delete from edges where revision_id = $1 and (from_step_id = $2 or to_step_id = $2)", [mapDraft, card.id]));
    await expect(
      commitAs(editor.claims, (c) => c.query("update steps set revision_id = $3, process_id = $4 where revision_id = $1 and id = $2", [mapDraft, card.id, salesDraft, w.sales])),
    ).rejects.toThrow(/stays in the process/);
    await expect(commitAs(editor.claims, (c) => c.query("update steps set process_id = $3 where revision_id = $1 and id = $2", [mapDraft, card.id, w.sales]))).rejects.toThrow(/stays in the process/);
    await expect(commitAs(editor.claims, (c) => c.query("update process_revisions set process_id = $2 where id = $1", [mapDraft, w.sales]))).rejects.toThrow(/stays in the process/);
    expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id = $2", [mapDraft, w.support]))[0].n).toBe(1);
  });

  it("refuses the same for ordinary processes: a step or connection into another process's draft", async () => {
    const w = await world();
    const salesDraft = await draftOf(w, w.sales);
    const deliveryDraft = await draftOf(w, w.delivery);
    const [step] = await q("select id from steps where revision_id = $1", [salesDraft]);
    await expect(
      commitAs(editor.claims, (c) => c.query("update steps set revision_id = $3, process_id = $4 where revision_id = $1 and id = $2", [salesDraft, step.id, deliveryDraft, w.delivery])),
    ).rejects.toThrow(/stays in the process/);
    await expect(commitAs(editor.claims, (c) => c.query("update process_revisions set process_id = $2 where id = $1", [salesDraft, w.delivery]))).rejects.toThrow(/stays in the process/);
    // The owner (a migration, a seed) is not refused, and ordinary saves still work.
    const [row] = await q("select work_hours from steps where revision_id = $1 and id = $2", [salesDraft, step.id]);
    await expect(commitAs(editor.claims, (c) => save(c, "steps", salesDraft, step.id, { work_hours: Number(row.work_hours) }, { work_hours: 2 }))).resolves.toMatchObject({ status: "saved" });
  });
});

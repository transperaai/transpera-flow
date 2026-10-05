import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// The process library on the company map (issue #164, B12, migration 20261129500000): an editor places a process on the map
// as a linked card in the map's DRAFT and takes it off by deleting the card from a draft. Placing and removing never edit the
// process: its row, versions, steps and edges are byte-identical before and after. A process is on the map at most once, only
// a parent-less process of the same workspace can be placed, and never the company map itself. Made with Supabase's default
// table privileges, as production is.

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

interface World {
  ws: string;
  cid: string;
  sales: string;
  delivery: string;
  support: string;
}

let counter = 0;
async function world(): Promise<World> {
  const n = ++counter;
  const [{ id: ws }] = await q("insert into workspaces (name, slug) values ($1, $2) returning id", [`Library ${n}`, `process-library-${n}`]);
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

const processRow = async (id: string) => (await q("select live_revision_id, draft_revision_id from processes where id = $1", [id]))[0] as { live_revision_id: string; draft_revision_id: string | null };
const openDraft = async (cid: string) => (await commitAs(editor.claims, (c) => rpc(c, "open_draft", cid))).revision_id as string;
const holderOf = async (rev: string, pid: string) => (await q("select id, name, x::float8 as x, y::float8 as y from steps where revision_id = $1 and child_process_id = $2", [rev, pid]))[0] as { id: string; name: string; x: number; y: number } | undefined;

/** Everything stored about the given processes: their rows, every revision, step and edge (all columns, including updated_at). */
async function snapshot(ids: string[]) {
  return {
    processes: await q("select * from processes where id = any($1) order by id", [ids]),
    revisions: await q("select * from process_revisions where process_id = any($1) order by id", [ids]),
    steps: await q("select * from steps where process_id = any($1) order by revision_id, id", [ids]),
    edges: await q("select * from edges where process_id = any($1) order by revision_id, id", [ids]),
  };
}

/** What the Editor writes when it places a process: one holder step in the map's draft. */
const place = (c: pg.Client, w: World, draft: string, processId: string, name: string, x: number, y: number) =>
  c.query(
    "insert into steps (id, revision_id, workspace_id, process_id, name, kind, child_process_id, x, y) values ($1, $2, $3, $4, $5, 'subprocess', $6, $7, $8)",
    [randomUUID(), draft, w.ws, w.cid, name, processId, x, y],
  );
const unplace = (c: pg.Client, draft: string, stepId: string) => c.query("delete from steps where revision_id = $1 and id = $2", [draft, stepId]);

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@process-library.example.com");
  viewer = await createUser(db, "viewer@process-library.example.com");
});

afterAll(async () => {
  await db?.close();
});

describe("the process library places a process on the company map as a link", () => {
  it("takes several processes off a draft and puts them back in one go, then publishes, and the processes are byte-identical throughout", async () => {
    const w = await world();
    const all = [w.sales, w.delivery, w.support];
    const before = await snapshot(all);
    const draft = await openDraft(w.cid);
    const cards = await Promise.all(all.map(async (p) => (await holderOf(draft, p))!));
    // Take all three off the map (Remove from the map), publish: none of them is on the map.
    await commitAs(editor.claims, async (c) => {
      for (const card of cards) await unplace(c, draft, card.id);
    });
    await commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid));
    expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id is not null", [(await processRow(w.cid)).live_revision_id]))[0].n).toBe(0);
    expect(await snapshot(all)).toEqual(before);

    // Place the three again in one transaction (the library's "Add 3 processes"), publish: three cards with the processes' names.
    const draft2 = await openDraft(w.cid);
    await commitAs(editor.claims, async (c) => {
      let x = 0;
      for (const [id, name] of [[w.sales, "Sales"], [w.delivery, "Delivery"], [w.support, "Support"]] as const) await place(c, w, draft2, id, name, (x += 240), 0);
    });
    // Placing writes nothing to the processes: a draft of the map is the map's own.
    expect(await snapshot(all)).toEqual(before);
    await commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid));
    const live = (await processRow(w.cid)).live_revision_id;
    expect((await q("select name from steps where revision_id = $1 and child_process_id is not null order by name", [live])).map((r) => r.name)).toEqual(["Delivery", "Sales", "Support"]);
    expect(await snapshot(all)).toEqual(before);
    // None of the three has a parent: "on the map" is only "held by the map".
    expect((await q("select count(*)::int n from processes where id = any($1) and parent_process_id is not null", [all]))[0].n).toBe(0);
  });

  it("shows later changes to the placed process through the link, which stays a link", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    const card = (await holderOf(draft, w.sales))!;
    await commitAs(editor.claims, (c) => unplace(c, draft, card.id));
    await commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid));
    const draft2 = await openDraft(w.cid);
    await commitAs(editor.claims, (c) => place(c, w, draft2, w.sales, "Sales", 0, 0));
    await commitAs(editor.claims, (c) => rpc(c, "publish_process", w.cid));
    const live = (await processRow(w.cid)).live_revision_id;
    expect((await holderOf(live, w.sales))?.name).toBe("Sales");
    // The card points at the process, not at a copy: the link survives the process being renamed (the map's sync only renames the card).
    await q("update processes set name = 'Sales v2' where id = $1", [w.sales]);
    const now = (await processRow(w.cid)).live_revision_id;
    expect((await holderOf(now, w.sales))?.name).toBe("Sales v2");
  });

  it("is on the map at most once: a second card for the same process in a draft is refused", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    // The world already put Sales on the map: a second card for it, anywhere, is refused.
    await expect(commitAs(editor.claims, (c) => place(c, w, draft, w.sales, "Sales again", 500, 500))).rejects.toThrow(/steps_one_holder_per_child|duplicate key/);
    expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id = $2", [draft, w.sales]))[0].n).toBe(1);
  });

  it("refuses another workspace's process, the company map itself, and a process that sits inside another", async () => {
    const w = await world();
    const other = await world();
    const draft = await openDraft(w.cid);
    // Make room: take Support off, so a refusal is about the process, not about it already being there.
    const support = (await holderOf(draft, w.support))!;
    await commitAs(editor.claims, (c) => unplace(c, draft, support.id));
    await expect(commitAs(editor.claims, (c) => place(c, w, draft, other.sales, "Their Sales", 0, 0))).rejects.toThrow();
    await expect(commitAs(editor.claims, (c) => place(c, w, draft, w.cid, "Company map", 0, 0))).rejects.toThrow();
    // Support nested under Sales is held by Sales; it can't also sit on the map.
    await q("update processes set parent_process_id = $2 where id = $1", [w.support, w.sales]);
    await expect(commitAs(editor.claims, (c) => place(c, w, draft, w.support, "Support", 0, 0))).rejects.toThrow();
    expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id = any($2)", [draft, [other.sales, w.cid, w.support]]))[0].n).toBe(0);
  });

  it("is for editors: a viewer can neither place nor remove a card", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    const card = (await holderOf(draft, w.support))!;
    await commitAs(editor.claims, (c) => unplace(c, draft, card.id));
    await expect(commitAs(viewer.claims, (c) => place(c, w, draft, w.support, "Support", 0, 0))).rejects.toThrow();
    const sales = (await holderOf(draft, w.sales))!;
    // (A viewer can read the row but the policy lets the delete match nothing, or refuses it.)
    await commitAs(viewer.claims, (c) => unplace(c, draft, sales.id)).catch(() => undefined);
    expect(await holderOf(draft, w.sales)).toBeDefined();
  });

  it("refuses to take a card off a published version, or off by unlinking", async () => {
    const w = await world();
    const live = (await processRow(w.cid)).live_revision_id;
    const liveCard = (await holderOf(live, w.sales))!;
    await expect(commitAs(editor.claims, (c) => unplace(c, live, liveCard.id))).rejects.toThrow();
    const draft = await openDraft(w.cid);
    const card = (await holderOf(draft, w.sales))!;
    await expect(commitAs(editor.claims, (c) => c.query("update steps set child_process_id = null where revision_id = $1 and id = $2", [draft, card.id]))).rejects.toThrow();
    expect(await holderOf(live, w.sales)).toBeDefined();
    expect(await holderOf(draft, w.sales)).toBeDefined();
  });

  it("discarding the draft drops its pending removals: live never lost the card", async () => {
    const w = await world();
    const draft = await openDraft(w.cid);
    const card = (await holderOf(draft, w.delivery))!;
    await commitAs(editor.claims, (c) => unplace(c, draft, card.id));
    await commitAs(editor.claims, (c) => rpc(c, "discard_draft", w.cid));
    expect(await holderOf((await processRow(w.cid)).live_revision_id, w.delivery)).toBeDefined();
  });
});

import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// The process library in every editor (issue #164, B12 part 2, migration 20261130000000): ANY process may hold others by a
// link (a `subprocess` holder step in its draft). Placing never writes the placed process. Publishing is where the rules bite:
// a process sits in at most one live version across every map (the refusal names where it sits), and no process ends up
// inside itself. "Where a process sits" is `public.process_placements` (live links), not `parent_process_id`. Made with
// Supabase's default table privileges, as production is.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let viewer: { id: string; claims: Record<string, unknown> };

type Reply = Record<string, unknown> & { status: string };

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

async function commitAs<T>(claims: Record<string, unknown> | null, fn: (c: pg.Client) => Promise<T>, role = "authenticated"): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query(`set local role ${role}`);
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : ""]);
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

/** The statement is refused with this SQLSTATE and a message that says why (a refusal for another reason fails the test). */
async function refused(run: Promise<unknown>, code: string, why: RegExp) {
  const err = (await run.then(
    () => null,
    (e: unknown) => e,
  )) as { code?: string; message?: string } | null;
  expect(err, "expected the statement to be refused").not.toBeNull();
  expect({ code: err!.code, message: err!.message }).toEqual({ code, message: expect.stringMatching(why) });
}

interface World {
  ws: string;
  cid: string;
  /** Processes by name, made by the library ("New process"): published once, on no map. */
  p: Record<string, string>;
}

let counter = 0;
/** A workspace with an editor and a viewer, the company map, and processes that sit nowhere, each with a published version. */
async function world(names = ["Sales", "Onboarding", "Delivery", "Support"]): Promise<World> {
  const n = ++counter;
  const [{ id: ws }] = await q("insert into workspaces (name, slug) values ($1, $2) returning id", [`Everywhere ${n}`, `library-everywhere-${n}`]);
  for (const [user, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
    await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.id, role]);
  }
  const [{ id: cid }] = await q("select id from processes where workspace_id = $1 and is_company", [ws]);
  const p: Record<string, string> = {};
  for (const name of names) {
    const made = await commitAs(editor.claims, (c) => rpc(c, "create_library_process", ws, name, "servicing"));
    expect(made.status).toBe("created");
    p[name] = made.process_id as string;
    await publishWith(p[name]!, []);
  }
  return { ws, cid, p };
}

const processRow = async (id: string) => (await q("select live_revision_id, draft_revision_id from processes where id = $1", [id]))[0] as { live_revision_id: string | null; draft_revision_id: string | null };
const openDraft = async (id: string) => (await commitAs(editor.claims, (c) => rpc(c, "open_draft", id))).revision_id as string;
const publish = (id: string) => commitAs(editor.claims, (c) => rpc(c, "publish_process", id));

/** What the Editor writes when it places a process: one holder step in the draft, named after it. */
const link = (c: pg.Client, ws: string, holder: string, draft: string, child: string, name = "Linked", x = 0, y = 0) =>
  c.query(
    "insert into steps (id, revision_id, workspace_id, process_id, name, kind, child_process_id, x, y) values ($1, $2, $3, $4, $5, 'subprocess', $6, $7, $8)",
    [randomUUID(), draft, ws, holder, name, child, x, y],
  );

/** Opens a draft of `holder`, links `children` in it (as the editor, one transaction), and returns the draft. */
async function draftWith(ws: string, holder: string, children: string[]): Promise<string> {
  const draft = await openDraft(holder);
  await commitAs(editor.claims, async (c) => {
    let x = 0;
    for (const child of children) await link(c, ws, holder, draft, child, `Link ${(x += 1)}`, x * 240, 0);
  });
  return draft;
}

/** Opens a draft of `holder`, links `children`, and publishes it. */
async function publishWith(holder: string, children: string[]) {
  const [{ workspace_id: ws }] = await q("select workspace_id from processes where id = $1", [holder]);
  await draftWith(ws, holder, children);
  return publish(holder);
}

/** Where each process sits, from the live links. */
const placements = async (ws: string) =>
  Object.fromEntries((await q("select process_id, holder_process_id from process_placements where workspace_id = $1", [ws])).map((r) => [r.process_id, r.holder_process_id]));

/** Everything stored about the given processes: rows, revisions, steps and edges, every column. */
async function snapshot(ids: string[]) {
  return {
    processes: await q("select * from processes where id = any($1) order by id", [ids]),
    revisions: await q("select * from process_revisions where process_id = any($1) order by id", [ids]),
    steps: await q("select * from steps where process_id = any($1) order by revision_id, id", [ids]),
    edges: await q("select * from edges where process_id = any($1) order by revision_id, id", [ids]),
  };
}

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@library-everywhere.example.com");
  viewer = await createUser(db, "viewer@library-everywhere.example.com");
});

afterAll(async () => {
  await db?.close();
});

describe("New process from the library", () => {
  it("makes a process that sits nowhere: the company map gives it no card", async () => {
    const w = await world(["Sales"]);
    expect(await placements(w.ws)).toEqual({});
    const live = (await processRow(w.cid)).live_revision_id;
    expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id = $2", [live, w.p.Sales]))[0].n).toBe(0);
    // An ordinary insert still gets its card (the note is for that one process only).
    const [{ id: other }] = await q("insert into processes (workspace_id, name) values ($1, 'Made elsewhere') returning id", [w.ws]);
    expect((await placements(w.ws))[other]).toBe(w.cid);
  });

  it("refuses a name in use, a viewer, and anon", async () => {
    const w = await world(["Sales"]);
    expect((await commitAs(editor.claims, (c) => rpc(c, "create_library_process", w.ws, "  sales ", "pipeline"))).status).toBe("name_taken");
    expect((await commitAs(viewer.claims, (c) => rpc(c, "create_library_process", w.ws, "Viewer's", "pipeline"))).status).toBe("not_found");
    await refused(commitAs(null, (c) => rpc(c, "create_library_process", w.ws, "Anon's", "pipeline"), "anon"), "42501", /permission denied for function create_library_process/);
    expect((await q("select count(*)::int n from processes where workspace_id = $1 and name in ('Viewer''s', 'Anon''s')", [w.ws]))[0].n).toBe(0);
  });
});

describe("any process holds others by a link", () => {
  it("links three processes into an ordinary process in one go and publishes; the three are byte-identical throughout", async () => {
    const w = await world();
    const held = [w.p.Sales!, w.p.Delivery!, w.p.Support!];
    const before = await snapshot(held);
    await draftWith(w.ws, w.p.Onboarding!, held);
    expect(await snapshot(held)).toEqual(before);
    expect(await placements(w.ws)).toEqual({});
    expect((await publish(w.p.Onboarding!)).status).toBe("published");
    expect(await snapshot(held)).toEqual(before);
    expect(await placements(w.ws)).toEqual(Object.fromEntries(held.map((id) => [id, w.p.Onboarding])));
    // The stored parent column is not written: "inside" is the live link.
    expect((await q("select count(*)::int n from processes where id = any($1) and parent_process_id is not null", [held]))[0].n).toBe(0);
  });

  it("taking a link out (in a draft, then publishing) leaves the process untouched, back in its default home, the company map", async () => {
    const w = await world();
    await publishWith(w.p.Onboarding!, [w.p.Sales!]);
    const before = await snapshot([w.p.Sales!]);
    const draft = await openDraft(w.p.Onboarding!);
    await commitAs(editor.claims, (c) => c.query("delete from steps where revision_id = $1 and child_process_id = $2", [draft, w.p.Sales]));
    expect((await publish(w.p.Onboarding!)).status).toBe("published");
    expect(await placements(w.ws)).toEqual({ [w.p.Sales!]: w.cid });
    expect(await snapshot([w.p.Sales!])).toEqual(before);
    // ...and it can be placed again, anywhere (the map gives way again).
    expect((await publishWith(w.p.Delivery!, [w.p.Sales!])).status).toBe("published");
    expect(await placements(w.ws)).toEqual({ [w.p.Sales!]: w.p.Delivery });
  });

  it("discarding a draft drops its pending links", async () => {
    const w = await world();
    await draftWith(w.ws, w.p.Onboarding!, [w.p.Sales!, w.p.Support!]);
    await commitAs(editor.claims, (c) => rpc(c, "discard_draft", w.p.Onboarding));
    expect(await placements(w.ws)).toEqual({});
    const live = (await processRow(w.p.Onboarding!)).live_revision_id;
    expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id is not null", [live]))[0].n).toBe(0);
  });

  it("refuses another workspace's process, the company map, and the process itself", async () => {
    const w = await world(["Sales", "Onboarding"]);
    const other = await world(["Theirs"]);
    const draft = await openDraft(w.p.Onboarding!);
    await refused(commitAs(editor.claims, (c) => link(c, w.ws, w.p.Onboarding!, draft, other.p.Theirs!)), "23503", /steps_child_process_fk/);
    await refused(commitAs(editor.claims, (c) => link(c, w.ws, w.p.Onboarding!, draft, w.cid)), "23514", /can.t sit in step Linked: a process can.t hold itself or the company map/);
    await refused(commitAs(editor.claims, (c) => link(c, w.ws, w.p.Onboarding!, draft, w.p.Onboarding!)), "23514", /can.t sit in step Linked: a process can.t hold itself/);
    // Twice in one draft: the unique index.
    await commitAs(editor.claims, (c) => link(c, w.ws, w.p.Onboarding!, draft, w.p.Sales!));
    await expect(commitAs(editor.claims, (c) => link(c, w.ws, w.p.Onboarding!, draft, w.p.Sales!, "Again"))).rejects.toThrow(/steps_one_holder_per_child|duplicate key/);
  });

  it("is for editors: a viewer can't link, and anon can't read where processes sit", async () => {
    const w = await world(["Sales", "Onboarding"]);
    const draft = await openDraft(w.p.Onboarding!);
    await refused(commitAs(viewer.claims, (c) => link(c, w.ws, w.p.Onboarding!, draft, w.p.Sales!)), "42501", /row-level security/);
    await publishWith(w.cid, [w.p.Sales!]);
    // Members read placements; a non-member and anon read nothing.
    expect((await commitAs(viewer.claims, (c) => c.query("select count(*)::int n from process_placements where workspace_id = $1", [w.ws]))).rows[0].n).toBe(1);
    const stranger = await createUser(db, `stranger-${randomUUID()}@library-everywhere.example.com`);
    expect((await commitAs(stranger.claims, (c) => c.query("select count(*)::int n from process_placements where workspace_id = $1", [w.ws]))).rows[0].n).toBe(0);
    await refused(commitAs(null, (c) => c.query("select * from process_placements"), "anon"), "42501", /permission denied for (view|table) process_placements/);
  });
});

describe("at most once in the published tree, across every map", () => {

  it("refuses a process inside one process from being published inside another, and on the company map", async () => {
    const w = await world();
    await publishWith(w.p.Onboarding!, [w.p.Sales!]);
    await draftWith(w.ws, w.p.Delivery!, [w.p.Sales!]);
    await refused(publish(w.p.Delivery!), "23514", /^Sales is already inside Onboarding\. A process can sit in one place only/);
    await draftWith(w.ws, w.cid, [w.p.Sales!]);
    await refused(publish(w.cid), "23514", /^Sales is already inside Onboarding\./);
    expect(await placements(w.ws)).toEqual({ [w.p.Sales!]: w.p.Onboarding });
  });

  it("two drafts linking the same process: the first to publish wins, the second is refused", async () => {
    const w = await world();
    await draftWith(w.ws, w.p.Onboarding!, [w.p.Sales!]);
    await draftWith(w.ws, w.p.Delivery!, [w.p.Sales!]);
    expect((await publish(w.p.Delivery!)).status).toBe("published");
    await refused(publish(w.p.Onboarding!), "23514", /^Sales is already inside Delivery\./);
  });

  it("does not re-check links the live version already had (publishing other changes still works)", async () => {
    const w = await world();
    await publishWith(w.p.Onboarding!, [w.p.Sales!]);
    const draft = await openDraft(w.p.Onboarding!);
    await commitAs(editor.claims, (c) => c.query("update steps set x = x + 40 where revision_id = $1 and child_process_id = $2", [draft, w.p.Sales]));
    expect((await publish(w.p.Onboarding!)).status).toBe("published");
  });
});

describe("no process inside itself", () => {
  it("refuses a two-process loop at publish", async () => {
    const w = await world();
    await publishWith(w.p.Onboarding!, [w.p.Sales!]);
    // Sales's draft may link Onboarding (a draft is free); publishing it is refused.
    await draftWith(w.ws, w.p.Sales!, [w.p.Onboarding!]);
    await refused(publish(w.p.Sales!), "23514", /^Sales can't hold Onboarding: Onboarding already holds Sales, so Sales would sit inside itself\.$/);
  });

  it("refuses a deeper loop at publish", async () => {
    const w = await world();
    await publishWith(w.p.Delivery!, [w.p.Support!]);
    await publishWith(w.p.Onboarding!, [w.p.Delivery!]);
    await publishWith(w.p.Sales!, [w.p.Onboarding!]);
    await draftWith(w.ws, w.p.Support!, [w.p.Sales!]);
    await refused(publish(w.p.Support!), "23514", /^Support can't hold Sales: Sales already holds Support, so Support would sit inside itself\.$/);
    expect(await placements(w.ws)).toEqual({ [w.p.Support!]: w.p.Delivery, [w.p.Delivery!]: w.p.Onboarding, [w.p.Onboarding!]: w.p.Sales });
  });
});

/** The company map's live version, and the last system 'publish' entry's note. */
const mapState = async (w: World) => {
  const live = (await processRow(w.cid)).live_revision_id!;
  const cards = (await q("select child_process_id from steps where revision_id = $1 and child_process_id is not null order by child_process_id", [live])).map((r) => r.child_process_id);
  const [note] = await q("select diff ->> 'note' as note from audit_log where target_id = $1 and action = 'publish' and actor_kind = 'system' order by created_at desc, id desc limit 1", [w.cid]);
  return { live, cards, note: (note?.note as string | undefined) ?? null };
};

describe("the company map is the default home, and gives way", () => {
  it("publishing a link to a process on the company map moves it: its card comes off the map (a system version), the process is untouched", async () => {
    const w = await world();
    await publishWith(w.cid, [w.p.Sales!, w.p.Support!]);
    const mapBefore = await mapState(w);
    // A person's open draft of the map has the card too: it is taken off there as well.
    const mapDraft = await openDraft(w.cid);
    const before = await snapshot([w.p.Sales!]);
    await draftWith(w.ws, w.p.Onboarding!, [w.p.Sales!]);
    expect((await publish(w.p.Onboarding!)).status).toBe("published");
    expect(await placements(w.ws)).toEqual({ [w.p.Sales!]: w.p.Onboarding, [w.p.Support!]: w.cid });
    const mapAfter = await mapState(w);
    expect(mapAfter.live).not.toBe(mapBefore.live);
    expect(mapAfter.cards).toEqual([w.p.Support]);
    expect(mapAfter.note).toBe("Moved Sales inside Onboarding");
    expect((await q("select count(*)::int n from steps where revision_id = $1 and child_process_id = $2", [mapDraft, w.p.Sales]))[0].n).toBe(0);
    expect(await snapshot([w.p.Sales!])).toEqual(before);
  });

  it("still refuses a process that sits inside an ordinary process, and names it", async () => {
    const w = await world();
    await publishWith(w.p.Onboarding!, [w.p.Sales!]);
    await draftWith(w.ws, w.p.Delivery!, [w.p.Sales!]);
    await refused(publish(w.p.Delivery!), "23514", /^Sales is already inside Onboarding\. A process can sit in one place only: take it off there first, then publish again\.$/);
  });

  it("gives a process its card back when its holder is deleted and nothing else holds it", async () => {
    const w = await world();
    await publishWith(w.cid, [w.p.Sales!]);
    await publishWith(w.p.Onboarding!, [w.p.Sales!]);
    expect((await mapState(w)).cards).toEqual([]);
    await commitAs(editor.claims, (c) => c.query("delete from processes where id = $1", [w.p.Onboarding]));
    expect(await placements(w.ws)).toEqual({ [w.p.Sales!]: w.cid });
    expect((await mapState(w)).note).toBe("Put Sales back on the map: Onboarding was deleted");
  });

  it("leaves a card a person took off the company map off it (Not on any map)", async () => {
    const w = await world();
    await publishWith(w.cid, [w.p.Sales!]);
    const draft = await openDraft(w.cid);
    await commitAs(editor.claims, (c) => c.query("delete from steps where revision_id = $1 and child_process_id = $2", [draft, w.p.Sales]));
    await publish(w.cid);
    expect(await placements(w.ws)).toEqual({});
  });

  it("two drafts placing the same company-map process at once: the first to commit moves it, the second waits and is refused", async () => {
    const w = await world();
    await publishWith(w.cid, [w.p.Sales!]);
    await draftWith(w.ws, w.p.Onboarding!, [w.p.Sales!]);
    await draftWith(w.ws, w.p.Delivery!, [w.p.Sales!]);
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    try {
      const setClaims = async (c: pg.Client) => {
        await c.query("begin");
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(editor.claims)]);
      };
      await setClaims(db.client);
      expect((await rpc(db.client, "publish_process", w.p.Onboarding)).status).toBe("published");
      // The second publish blocks on the first's locks until it commits, then sees Sales inside Onboarding.
      await setClaims(other);
      const second = rpc(other, "publish_process", w.p.Delivery).then(
        () => null,
        (e: { message?: string }) => e.message ?? "",
      );
      await new Promise((r) => setTimeout(r, 300));
      await db.client.query("commit");
      expect(await second).toMatch(/^Sales is already inside Onboarding\./);
      await other.query("rollback");
    } finally {
      await other.end();
    }
    expect(await placements(w.ws)).toEqual({ [w.p.Sales!]: w.p.Onboarding });
    expect((await mapState(w)).cards).toEqual([]);
  });

  it("restoring the company map does not pull in a process another process links, live or in its draft (one the library made included)", async () => {
    const w = await world(["Onboarding", "Delivery"]);
    // Version with nothing on it.
    const empty = (await processRow(w.cid)).live_revision_id!;
    await publishWith(w.cid, [w.p.Delivery!]);
    // The library makes Fresh and places it in Onboarding's draft; Delivery moves inside Onboarding (live).
    const made = await commitAs(editor.claims, (c) => rpc(c, "create_library_process", w.ws, "Fresh", "servicing"));
    const fresh = made.process_id as string;
    await publishWith(w.p.Onboarding!, [w.p.Delivery!]);
    await draftWith(w.ws, w.p.Onboarding!, [fresh]);
    const r = await commitAs(editor.claims, (c) => rpc(c, "restore_version", w.cid, empty, true));
    expect(r.status).toBe("restored");
    const restored = (await q("select child_process_id from steps where revision_id = $1 and child_process_id is not null", [r.revision_id])).map((x) => x.child_process_id);
    expect(restored).not.toContain(fresh);
    expect(restored).not.toContain(w.p.Delivery);
  });
});

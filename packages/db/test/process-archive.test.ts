import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// Process admin (issue #182, B19 2/2, migration 20261204000000; ADR 0014 "B19: archiving a process"): an editor makes a
// process of either kind, renames it, changes its kind and archives it (soft delete), and restores it. A viewer can do none of
// it. Archiving takes the process's card off the company map as a system version and restoring puts it back; a process inside
// another ordinary process, or holding others, is refused with a plain message; an archived process can't be placed or
// published into a map. Made with Supabase's default table privileges, as production is.

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

async function refused(run: Promise<unknown>, code: string, why: RegExp) {
  const err = (await run.then(
    () => null,
    (e: unknown) => e,
  )) as { code?: string; message?: string } | null;
  expect(err, "expected the statement to be refused").not.toBeNull();
  expect({ code: err!.code, message: err!.message }).toEqual({ code, message: expect.stringMatching(why) });
}

let counter = 0;
/** A workspace with an editor and a viewer; `names` made the ordinary way by the editor (each gets a card on the map), published. */
async function world<N extends string>(names: [N, "pipeline" | "servicing"][]) {
  const n = ++counter;
  const [{ id: ws }] = await q("insert into workspaces (name, slug) values ($1, $2) returning id", [`Archive ${n}`, `archive-${n}`]);
  for (const [user, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
    await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.id, role]);
  }
  const [{ id: cid }] = await q("select id from processes where workspace_id = $1 and is_company", [ws]);
  const p = {} as Record<N, string>;
  for (const [name, kind] of names) {
    p[name] = await commitAs(editor.claims, async (c) => (await c.query("insert into processes (workspace_id, name, kind) values ($1, $2, $3) returning id", [ws, name, kind])).rows[0].id as string);
    await publishWith(ws, p[name], []);
  }
  return { ws, cid, p };
}

const liveOf = async (id: string) => (await q("select live_revision_id from processes where id = $1", [id]))[0].live_revision_id as string;
const draftOf = async (id: string) => (await q("select draft_revision_id from processes where id = $1", [id]))[0].draft_revision_id as string | null;
const openDraft = async (id: string) => (await commitAs(editor.claims, (c) => rpc(c, "open_draft", id))).revision_id as string;
const publish = (id: string) => commitAs(editor.claims, (c) => rpc(c, "publish_process", id));

const link = (c: pg.Client, ws: string, holder: string, draft: string, child: string) =>
  c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, child_process_id, x, y) values ($1, $2, $3, $4, 'Linked', 'subprocess', $5, 0, 0)", [
    randomUUID(),
    draft,
    ws,
    holder,
    child,
  ]);

async function publishWith(ws: string, holder: string, children: string[]) {
  const draft = await openDraft(holder);
  await commitAs(editor.claims, async (c) => {
    for (const child of children) await link(c, ws, holder, draft, child);
  });
  return publish(holder);
}

/** The company map's cards (live, or the given revision): process id → [x, y]. */
const cards = async (cid: string, revision?: string) =>
  Object.fromEntries(
    (await q("select child_process_id, x::float8 x, y::float8 y from steps where revision_id = $1 and child_process_id is not null", [revision ?? (await liveOf(cid))])).map((r) => [
      r.child_process_id,
      [r.x, r.y],
    ]),
  );
/** The notes of the company map's system versions, oldest first. */
const notes = async (cid: string) =>
  (await q("select diff ->> 'note' note from audit_log where target_id = $1 and action = 'publish' and actor_kind = 'system' order by created_at, id", [cid])).map((r) => r.note as string);
const archive = (claims: Record<string, unknown>, id: string) => commitAs(claims, async (c) => (await c.query("update processes set archived_at = now() where id = $1 returning archived_at, archived_by", [id])).rows);
const unarchive = (claims: Record<string, unknown>, id: string) => commitAs(claims, async (c) => (await c.query("update processes set archived_at = null where id = $1 returning archived_at, archived_by", [id])).rows);

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@process-archive.example.com");
  viewer = await createUser(db, "viewer@process-archive.example.com");
});

afterAll(async () => {
  await db?.close();
});

describe("creating, renaming and changing the kind", () => {
  it("lets an editor make either kind, rename it and change its kind, and the map follows; a viewer can't", async () => {
    const w = await world([["Sales", "pipeline"], ["Reporting", "servicing"]]);
    expect(Object.keys(await cards(w.cid)).sort()).toEqual([w.p.Sales, w.p.Reporting].sort());
    // Pipelines sit in the left column, client work in the right.
    expect((await cards(w.cid))[w.p.Sales]![0]).toBe(0);
    expect((await cards(w.cid))[w.p.Reporting]![0]).toBe(288);

    await commitAs(editor.claims, (c) => c.query("update processes set name = 'New business' where id = $1", [w.p.Sales]));
    await commitAs(editor.claims, (c) => c.query("update processes set kind = 'servicing', entity_name = 'task' where id = $1", [w.p.Sales]));
    const [row] = await q("select name, kind, entity_name from processes where id = $1", [w.p.Sales]);
    expect(row).toEqual({ name: "New business", kind: "servicing", entity_name: "task" });
    const [{ name: card }] = await q("select name from steps where revision_id = $1 and child_process_id = $2", [await liveOf(w.cid), w.p.Sales]);
    expect(card).toBe("New business");
    expect((await cards(w.cid))[w.p.Sales]![0]).toBe(288);
    expect((await notes(w.cid)).slice(-2)).toEqual(["Renamed Sales to New business", "New business is now a servicing process"]);

    // A viewer's writes touch nothing (RLS), and anon has no access at all.
    const before = await q("select name, kind, archived_at from processes where id = $1", [w.p.Reporting]);
    expect((await commitAs(viewer.claims, (c) => c.query("update processes set name = 'Viewer' where id = $1 returning id", [w.p.Reporting]))).rowCount).toBe(0);
    expect((await commitAs(viewer.claims, (c) => c.query("update processes set kind = 'pipeline' where id = $1 returning id", [w.p.Reporting]))).rowCount).toBe(0);
    expect(await archive(viewer.claims, w.p.Reporting)).toEqual([]);
    await refused(
      commitAs(viewer.claims, (c) => c.query("insert into processes (workspace_id, name, kind) values ($1, 'Viewer made', 'pipeline')", [w.ws])),
      "42501",
      /row-level security/,
    );
    await refused(commitAs(null, (c) => c.query("update processes set archived_at = now() where id = $1", [w.p.Reporting]), "anon"), "42501", /permission denied/);
    expect(await q("select name, kind, archived_at from processes where id = $1", [w.p.Reporting])).toEqual(before);
  });

  it("keeps a process linked to services as client work until it is unlinked (the database says so)", async () => {
    const w = await world([["Reporting", "servicing"]]);
    const [{ id: service }] = await q("insert into services (workspace_id, name) values ($1, 'Retainer') returning id", [w.ws]);
    await q("insert into service_servicing (workspace_id, service_id, process_id, recurrence) values ($1, $2, $3, '{\"every\": \"month\", \"times\": 1}')", [w.ws, service, w.p.Reporting]);
    await refused(commitAs(editor.claims, (c) => c.query("update processes set kind = 'pipeline' where id = $1", [w.p.Reporting])), "23514", /linked to services/);
  });
});

describe("archiving and restoring", () => {
  it("takes the card off the company map as a system version, keeps the history, and restore puts it back", async () => {
    const w = await world([["Sales", "pipeline"], ["Onboarding", "pipeline"], ["Reporting", "servicing"]]);
    const versionsBefore = await q("select id, number, status from process_revisions where process_id = $1 order by number", [w.p.Sales]);
    // An open draft of the map loses the card too.
    const mapDraft = await openDraft(w.cid);
    const before = await cards(w.cid);
    const liveBefore = await liveOf(w.cid);

    const [row] = await archive(editor.claims, w.p.Sales);
    expect(row.archived_at).not.toBeNull();
    expect(row.archived_by).toBe(editor.id);
    const after = await cards(w.cid);
    expect(after[w.p.Sales]).toBeUndefined();
    expect(Object.keys(after).sort()).toEqual([w.p.Onboarding, w.p.Reporting].sort());
    expect(await cards(w.cid, mapDraft)).toEqual(after);
    // A new published version made by the system: the old one is superseded, not edited.
    expect(await liveOf(w.cid)).not.toBe(liveBefore);
    expect((await cards(w.cid, liveBefore))[w.p.Sales]).toEqual(before[w.p.Sales]);
    expect((await notes(w.cid)).at(-1)).toBe("Archived Sales");
    // Its own versions are all still there, and members still read it (the app's lists leave it out: listProcesses, tested over
    // PostgREST in packages/mcp/test/postgrest-process-admin.test.ts).
    expect(await q("select id, number, status from process_revisions where process_id = $1 order by number", [w.p.Sales])).toEqual(versionsBefore);
    const seen = await db.as(viewer.claims, async (c) => (await c.query("select name from processes where workspace_id = $1 and archived_at is not null", [w.ws])).rows);
    expect(seen).toEqual([{ name: "Sales" }]);

    // Archiving again keeps when and by whom.
    const stamp = (await q("select archived_at from processes where id = $1", [w.p.Sales]))[0].archived_at;
    await commitAs(editor.claims, (c) => c.query("update processes set archived_at = now() + interval '1 day' where id = $1", [w.p.Sales]));
    expect((await q("select archived_at from processes where id = $1", [w.p.Sales]))[0].archived_at).toEqual(stamp);

    const [back] = await unarchive(editor.claims, w.p.Sales);
    expect(back).toEqual({ archived_at: null, archived_by: null });
    const restored = await cards(w.cid);
    // Back at the bottom of the pipelines' column.
    expect(restored[w.p.Sales]![0]).toBe(0);
    expect(restored[w.p.Sales]![1]).toBeGreaterThan(restored[w.p.Onboarding]![1]);
    expect(await cards(w.cid, mapDraft)).toEqual(restored);
    expect((await notes(w.cid)).at(-1)).toBe("Restored Sales");
    // It runs to the client work again, as a new process does.
    const lines = await q("select count(*)::int n from edges e join steps s on s.revision_id = e.revision_id and s.id = e.from_step_id where e.revision_id = $1 and s.child_process_id = $2", [await liveOf(w.cid), w.p.Sales]);
    expect(lines[0].n).toBe(1);
  });

  it("refuses the company map, a process inside another, and one that holds others, naming them", async () => {
    const w = await world([["Sales", "pipeline"], ["Kickoff", "pipeline"], ["Audit", "pipeline"]]);
    await refused(archive(editor.claims, w.cid), "55000", /^The company map can't be archived$/);
    // Onboarding work: Sales holds Kickoff and Audit (the company map gives way).
    await publishWith(w.ws, w.p.Sales!, [w.p.Kickoff!, w.p.Audit!]);
    await refused(archive(editor.claims, w.p.Kickoff!), "55000", /^Kickoff sits inside Sales\. Take it out of Sales and publish, then archive it\.$/);
    await refused(archive(editor.claims, w.p.Sales!), "55000", /^Sales holds Audit, Kickoff\. Take Audit, Kickoff out of Sales and publish, then archive it\.$/);
    expect(await q("select count(*)::int n from processes where workspace_id = $1 and archived_at is not null", [w.ws])).toEqual([{ n: 0 }]);
    // Taken out and published, Kickoff goes back to the map and can then be archived.
    const draft = await openDraft(w.p.Sales!);
    await commitAs(editor.claims, (c) => c.query("delete from steps where revision_id = $1 and child_process_id is not null", [draft]));
    await publish(w.p.Sales!);
    expect((await cards(w.cid))[w.p.Kickoff!]).toBeDefined();
    await archive(editor.claims, w.p.Kickoff!);
    expect((await cards(w.cid))[w.p.Kickoff!]).toBeUndefined();
  });

  it("archives a process never published (no card to take off) and restores it with one", async () => {
    const w = await world([]);
    const id = await commitAs(editor.claims, async (c) => (await c.query("insert into processes (workspace_id, name, kind) values ($1, 'Draft only', 'servicing') returning id", [w.ws])).rows[0].id as string);
    await openDraft(id);
    const [row] = await archive(editor.claims, id);
    expect(row.archived_by).toBe(editor.id);
    expect((await cards(w.cid))[id]).toBeUndefined();
    await unarchive(editor.claims, id);
    expect((await cards(w.cid))[id]![0]).toBe(288);
  });

  it("can't be placed in a draft or published into a map, and a restored map version skips it", async () => {
    const w = await world([["Sales", "pipeline"], ["Kickoff", "pipeline"], ["Audit", "pipeline"]]);
    const mapVersionWithAudit = await liveOf(w.cid);
    // A draft that linked Audit before it was archived can't publish it.
    const draft = await openDraft(w.p.Sales!);
    await commitAs(editor.claims, (c) => link(c, w.ws, w.p.Sales!, draft, w.p.Audit!));
    await archive(editor.claims, w.p.Audit!);
    await refused(publish(w.p.Sales!), "23514", /^Audit is archived\. Restore it from Processes \(Archived\), or take it out of this draft, then publish again\.$/);
    expect(await draftOf(w.p.Sales!)).toBe(draft);
    // Placing it now is refused at once (the check runs at commit).
    const kickoffDraft = await openDraft(w.p.Kickoff!);
    await refused(
      commitAs(editor.claims, (c) => link(c, w.ws, w.p.Kickoff!, kickoffDraft, w.p.Audit!).then(() => c.query("set constraints all immediate"))),
      "23514",
      /Audit is archived: restore it from Processes \(Archived\) before placing it/,
    );
    // Restoring a version of the map from before the archive leaves its card out, and adds nothing back for it.
    const [{ number }] = await q("select number from process_revisions where id = $1", [mapVersionWithAudit]);
    expect((await cards(w.cid, mapVersionWithAudit))[w.p.Audit!]).toBeDefined();
    const reply = await commitAs(editor.claims, (c) => rpc(c, "restore_version", w.cid, mapVersionWithAudit, false));
    expect(reply.status, JSON.stringify(reply)).toBe("restored");
    expect(number).toBeGreaterThan(0);
    const restoredDraft = (await draftOf(w.cid))!;
    expect((await cards(w.cid, restoredDraft))[w.p.Audit!]).toBeUndefined();
    expect(reply.skipped_holders).toBe(1);
    await publish(w.cid);
    expect((await cards(w.cid))[w.p.Audit!]).toBeUndefined();
    // Restored, it is back where it belongs.
    await unarchive(editor.claims, w.p.Audit!);
    expect((await cards(w.cid))[w.p.Audit!]).toBeDefined();
  });
});

describe("while it is archived, nothing changes it", () => {
  it("can't publish a draft opened before it was archived, so what that draft links stays where it is", async () => {
    // The review's case: X's draft links Y; X is archived; publishing X would have moved Y off the company map.
    const w = await world([["X", "pipeline"], ["Y", "pipeline"]]);
    const draft = await openDraft(w.p.X);
    await commitAs(editor.claims, (c) => link(c, w.ws, w.p.X, draft, w.p.Y));
    await archive(editor.claims, w.p.X);
    await refused(publish(w.p.X), "55000", /^X is archived\. Restore it from Processes \(Archived\) before (changing|publishing) it\.$/);
    expect((await cards(w.cid))[w.p.Y]).toBeDefined();
    expect(await q("select live_revision_id from processes where id = $1", [w.p.X])).toEqual([{ live_revision_id: expect.any(String) }]);
    // Not even the database's own roads: a pointer moved by hand.
    await refused(q("update processes set live_revision_id = $2 where id = $1", [w.p.X, draft]), "55000", /^X is archived\. Restore it from Processes \(Archived\) before publishing it\.$/);
  });

  it("refuses opening a draft (new or already open) and restoring a version into it", async () => {
    const w = await world([["Sales", "pipeline"], ["Audit", "pipeline"]]);
    const first = await liveOf(w.p.Audit);
    await publishWith(w.ws, w.p.Audit, []);
    await openDraft(w.p.Sales);
    await archive(editor.claims, w.p.Sales);
    await archive(editor.claims, w.p.Audit);
    const message = /^(Sales|Audit) is archived\. Restore it from Processes \(Archived\) before changing it\.$/;
    // Sales had a draft open; Audit had none.
    await refused(commitAs(editor.claims, (c) => rpc(c, "open_draft", w.p.Sales)), "55000", message);
    await refused(commitAs(editor.claims, (c) => rpc(c, "open_draft", w.p.Audit)), "55000", message);
    await refused(commitAs(editor.claims, (c) => rpc(c, "restore_version", w.p.Audit, first, false)), "55000", message);
    await refused(commitAs(editor.claims, (c) => rpc(c, "restore_version", w.p.Audit, first, true)), "55000", message);
    // Restored, it can be edited and published again.
    await unarchive(editor.claims, w.p.Audit);
    expect(await openDraft(w.p.Audit)).toEqual(expect.any(String));
    expect((await publish(w.p.Audit)).status).toBe("published");
  });
});

describe("who archived it, and what still needs it", () => {
  it("never takes archived_by from the caller, and a new process never starts archived", async () => {
    const w = await world([["Sales", "pipeline"]]);
    await refused(
      commitAs(editor.claims, (c) => c.query("insert into processes (workspace_id, name, kind, archived_at) values ($1, 'Born archived', 'pipeline', now())", [w.ws])),
      "55000",
      /^A new process can't start archived$/,
    );
    await refused(
      commitAs(editor.claims, (c) => c.query("insert into processes (workspace_id, name, kind, archived_by) values ($1, 'Forged', 'pipeline', $2)", [w.ws, viewer.id])),
      "55000",
      /^A new process can't start archived$/,
    );
    await refused(commitAs(editor.claims, (c) => c.query("update processes set archived_by = $2 where id = $1", [w.p.Sales, viewer.id])), "55000", /^Who archived a process is recorded by the database/);
    // Archiving with someone else's name in archived_by records the caller; changing it afterwards is refused.
    const [row] = await commitAs(editor.claims, async (c) => (await c.query("update processes set archived_at = now(), archived_by = $2 where id = $1 returning archived_by", [w.p.Sales, viewer.id])).rows);
    expect(row.archived_by).toBe(editor.id);
    await refused(commitAs(editor.claims, (c) => c.query("update processes set archived_by = $2 where id = $1", [w.p.Sales, viewer.id])), "55000", /^Who archived a process is recorded by the database/);
    const [back] = await commitAs(editor.claims, async (c) => (await c.query("update processes set archived_at = null, archived_by = $2 where id = $1 returning archived_by", [w.p.Sales, viewer.id])).rows);
    expect(back.archived_by).toBeNull();
  });

  it("refuses a pipeline that is a service's way in, and client work a service generates, naming the services", async () => {
    const w = await world([["Sales", "pipeline"], ["Reporting", "servicing"]]);
    await q("insert into services (workspace_id, name, entry_process_id) values ($1, 'SEO', $2), ($1, 'PPC', $2)", [w.ws, w.p.Sales]);
    const [{ id: service }] = await q("insert into services (workspace_id, name) values ($1, 'Retainer') returning id", [w.ws]);
    await q("insert into service_servicing (workspace_id, service_id, process_id, recurrence) values ($1, $2, $3, '{\"every\": \"month\", \"times\": 1}')", [w.ws, service, w.p.Reporting]);
    await refused(archive(editor.claims, w.p.Sales), "55000", /^Sales is where new work for PPC, SEO comes in\. Choose another process for it in Settings, Services, then archive it\.$/);
    await refused(archive(editor.claims, w.p.Reporting), "55000", /^Reporting is client work for Retainer\. Unlink it from that in Settings, Services, then archive it\.$/);
  });

  it("frees an archived process's name, and refuses a restore that would make two of a name", async () => {
    const w = await world([["Sales", "pipeline"]]);
    await archive(editor.claims, w.p.Sales);
    // The library's and the import's own name checks no longer count it.
    const made = await commitAs(editor.claims, (c) => rpc(c, "create_library_process", w.ws, "sales", "pipeline"));
    expect(made.status).toBe("created");
    await refused(unarchive(editor.claims, w.p.Sales), "55000", /^Another process is called Sales\. Rename one of them, then restore it\.$/);
    await commitAs(editor.claims, (c) => c.query("update processes set name = 'Old sales' where id = $1", [w.p.Sales]));
    expect(await unarchive(editor.claims, w.p.Sales)).toEqual([{ archived_at: null, archived_by: null }]);
    await archive(editor.claims, w.p.Sales);
    const imported = await commitAs(editor.claims, (c) =>
      c.query("select public.import_new_process($1, $2) as r", [w.ws, JSON.stringify([{ id: randomUUID(), name: "Old sales", kind: "pipeline", entity_name: "lead", steps: [], edges: [] }])]).then((r) => r.rows[0].r),
    );
    expect(imported).toBeTruthy();
    expect(await q("select name, archived_at is not null archived from processes where workspace_id = $1 and lower(name) = 'old sales' order by archived", [w.ws])).toEqual([
      { name: "Old sales", archived: false },
      { name: "Old sales", archived: true },
    ]);
  });
});

describe("the rollback in the header", () => {
  it("undoes the migration (with the six replaced bodies re-created, as it says), passes preflight 3 again, and the migration applies again", async () => {
    const read = (f: string) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8");
    const migration = read("20261204000000_process_admin_source_files.sql");
    const everywhere = read("20261130000000_process_library_everywhere.sql");
    const drafts = read("20261006000000_drafts.sql");
    const atomic = read("20261128000000_import_atomic_link_limit.sql");
    const defn = (sql: string, name: string) =>
      sql.match(new RegExp(`^create (?:or replace )?function ${name}\\([\\s\\S]*?\\n\\$\\$;`, "m"))![0].replace(/^create function/, "create or replace function");
    const bodies = [
      ...["holder_allows", "check_step_nesting", "company_add_holder"].map((n) => defn(everywhere, `private\\.${n}`)),
      defn(everywhere, "public\\.create_library_process"),
      defn(drafts, "public\\.open_draft"),
      defn(atomic, "public\\.import_new_process"),
    ].join("\n");
    const block = (from: string, to: string) => migration.slice(migration.indexOf(from), migration.indexOf(to));
    const rollback = block("-- ROLLBACK", "-- ---------------------------------------------------------------------------\n-- Archiving a process")
      .split("\n")
      .filter((l) => l.startsWith("--   ") && !l.startsWith("--   --"))
      .map((l) => l.slice(5))
      .join("\n")
      .replace("delete from supabase_migrations.schema_migrations where version = '20261204000000';", "")
      .replace("alter table public.processes drop column", () => `${bodies}\nalter table public.processes drop column`);
    await db.client.query(rollback);
    expect(await q("select column_name from information_schema.columns where table_schema = 'public' and table_name in ('processes', 'sources') and column_name in ('archived_at', 'archived_by', 'file_path', 'file_name', 'file_type', 'file_size')")).toEqual([]);
    expect(await q("select proname from pg_proc where proname in ('process_archive_guard', 'process_archive_map', 'refuse_archived_placements', 'refuse_archived_revision', 'refuse_archived_publish', 'storage_workspace')")).toEqual([]);
    expect(await q("select policyname from pg_policies where schemaname = 'storage' and policyname like 'sources:%'")).toEqual([]);
    // Preflight 3, as written in the header, passes again: the six bodies are back as they were.
    const preflight3 = block("--   3. The replaced functions", "--   4. Storage is there")
      .split("\n")
      .filter((l) => l.startsWith("--        "))
      .map((l) => l.slice(10))
      .join("\n");
    const checks = await q(preflight3);
    expect(checks).toHaveLength(6);
    for (const c of checks) expect(Object.values(c)[1], String(c.proname)).toBe(true);
    // The bucket row stays (it may hold files); applying again keeps it and puts everything back.
    await db.client.query(migration);
    expect(await q("select policyname, cmd from pg_policies where schemaname = 'storage' and policyname like 'sources:%' order by 1")).toEqual([
      { policyname: "sources: editors delete", cmd: "DELETE" },
      { policyname: "sources: editors upload", cmd: "INSERT" },
      { policyname: "sources: members read", cmd: "SELECT" },
    ]);
    const w = await world([["Sales", "pipeline"]]);
    await archive(editor.claims, w.p.Sales);
    expect((await cards(w.cid))[w.p.Sales]).toBeUndefined();
  });
});

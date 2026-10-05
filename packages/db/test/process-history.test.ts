import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, companyMap, flattenCompanyMap, northbeamStepIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Process history (issue #105, migration 20261118000000_process_history.sql), as signed-in users under RLS:
// revision_history, restore_version (live is unchanged until publish) and duplicate_version (a new top-level
// process with fresh ids). Tests in this file build on each other (they commit), so they run in order.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
const ids = northbeamStepIds;

type Reply = Record<string, unknown> & { status: string };

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

const saveFields = (c: pg.Client, revision: string, id: string, base: object, changes: object) =>
  rpc(c, "save_fields", "steps", JSON.stringify({ revision_id: revision, id }), JSON.stringify(base), JSON.stringify(changes));

const processRow = async (id = proc) =>
  (await db.client.query("select live_revision_id, draft_revision_id, parent_process_id from processes where id = $1", [id])).rows[0] as {
    live_revision_id: string | null;
    draft_revision_id: string | null;
    parent_process_id: string | null;
  };

/** A revision's steps and edges without bookkeeping columns, for comparing contents. */
async function revisionRows(revision: string) {
  const strip = ({ revision_id: _r, created_at: _c, updated_at: _u, created_by: _b, ...rest }: Record<string, unknown>) => rest;
  const steps = (await db.client.query("select * from steps where revision_id = $1 order by id", [revision])).rows.map(strip);
  const edges = (await db.client.query("select * from edges where revision_id = $1 order by id", [revision])).rows.map(strip);
  return { steps, edges };
}

/** Edit the draft (work hours of the audit step), publish it, and return its revision id. */
async function publishVersion(claims: Record<string, unknown>, hours: number): Promise<string> {
  const opened = await commitAs(claims, (c) => rpc(c, "open_draft", proc));
  const draft = opened.revision_id as string;
  const [row] = (await db.client.query("select work_hours from steps where revision_id = $1 and id = $2", [draft, ids.audit])).rows;
  await commitAs(claims, (c) => saveFields(c, draft, ids.audit, { work_hours: Number(row.work_hours) }, { work_hours: hours }));
  const published = await commitAs(claims, (c) => rpc(c, "publish_process", proc, true));
  expect(published.status).toBe("published");
  return draft;
}

const v1 = NORTHBEAM_REVISION_ID;
let v2: string;
let v3: string;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "other", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@history.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [
      ws,
      users[role]!.id,
      role === "other" ? "editor" : role,
    ]);
  }
  // A stranger with no access to the workspace.
  users.stranger = await createUser(db, "stranger@elsewhere.example.com");
});

afterAll(async () => {
  await db?.close();
});

describe("revision_history", () => {
  it("lists published versions newest first with who published them and what changed", async () => {
    // "other" is linked to a person, so their name shows; the editor is not.
    const [person] = (await db.client.query("select id, name from people where workspace_id = $1 order by name limit 1", [ws])).rows;
    await db.client.query("update memberships set person_id = $1 where workspace_id = $2 and user_id = $3", [person.id, ws, users.other!.id]);
    v2 = await publishVersion(users.other!.claims, 12);
    // Published through MCP: an API token's claims.
    const mcp = { ...users.editor!.claims, api_token_id: randomUUID() };
    v3 = await publishVersion(mcp, 15);

    const rows = await db.as(users.editor!.claims, async (c) => (await c.query("select * from revision_history($1)", [proc])).rows);
    expect(rows.map((r) => [r.number, r.status])).toEqual([
      [3, "published"],
      [2, "superseded"],
      [1, "superseded"],
    ]);
    const [r3, r2, r1] = rows;
    expect(r3).toMatchObject({ revision_id: v3, author_kind: "mcp", author_name: null });
    expect(r3.changes).toEqual({ steps: { added: 0, removed: 0, changed: 1 }, edges: { added: 0, removed: 0, changed: 0 } });
    expect(r2).toMatchObject({ revision_id: v2, author_kind: "user", author_name: person.name });
    // Version 1 came with the seed: no author, no recorded change.
    expect(r1).toMatchObject({ revision_id: v1, author_kind: null, author_name: null, changes: null });
  });

  it("shows an email only to someone who manages the workspace", async () => {
    const asOwner = await db.as(users.owner!.claims, async (c) => (await c.query("select * from revision_history($1) where number = 3", [proc])).rows[0]);
    expect(asOwner.author_name).toBe("editor@history.example.com");
  });

  it("returns nothing to someone who can't read the workspace, and never a draft", async () => {
    expect(await db.as(users.stranger!.claims, async (c) => (await c.query("select * from revision_history($1)", [proc])).rowCount)).toBe(0);
    await commitAs(users.editor!.claims, (c) => rpc(c, "open_draft", proc));
    expect(await db.as(users.viewer!.claims, async (c) => (await c.query("select * from revision_history($1)", [proc])).rowCount)).toBe(3);
    await commitAs(users.editor!.claims, (c) => rpc(c, "discard_draft", proc));
  });
});

describe("restore_version", () => {
  it("copies the old version into a new draft and leaves live alone until publish", async () => {
    const liveBefore = await revisionRows(v3);
    const result = await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, v1, false));
    expect(result).toMatchObject({ status: "restored", number: 4, unlinked_children: 0 });
    const draft = result.revision_id as string;

    expect(await processRow()).toMatchObject({ live_revision_id: v3, draft_revision_id: draft });
    // The draft is version 1's content with the same ids; live and version 1 are untouched.
    expect(await revisionRows(draft)).toEqual(await revisionRows(v1));
    expect(await revisionRows(v3)).toEqual(liveBefore);
    const status = (await db.client.query("select number, status from process_revisions where id = any($1) order by number", [[v1, v3, draft]])).rows;
    expect(status).toEqual([
      { number: 1, status: "superseded" },
      { number: 3, status: "published" },
      { number: 4, status: "draft" },
    ]);
    // One audit entry, saying which version was restored (not an 'open_draft' entry claiming the draft came from live).
    const entries = (await db.client.query("select action, actor_kind, actor_id, diff from audit_log where target_id = $1 and diff ->> 'revision_id' = $2 order by created_at, id", [proc, draft])).rows;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "restore_version", actor_kind: "user", actor_id: users.editor!.id });
    expect(entries[0].diff).toEqual({ revision_id: draft, number: 4, restored_from_revision_id: v1, restored_from_number: 1, replaced_draft: false });
  });

  it("asks before replacing a draft that has changes, and replaces it when told to", async () => {
    const draft = (await processRow()).draft_revision_id!;
    // A draft equal to live would be replaced silently, but this one differs from live (it is version 1's).
    const asked = await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, v2, false));
    expect(asked).toEqual({ status: "draft_exists", number: 4 });
    expect(await revisionRows(draft)).toEqual(await revisionRows(v1));

    const replaced = await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, v2, true));
    expect(replaced).toMatchObject({ status: "restored", revision_id: draft, number: 4 });
    expect(await revisionRows(draft)).toEqual(await revisionRows(v2));
    expect((await processRow()).live_revision_id).toBe(v3);
    // Replacing a draft that exists adds its own entry.
    const last = (await db.client.query("select diff from audit_log where action = 'restore_version' and target_id = $1 order by created_at desc, id limit 1", [proc])).rows[0];
    expect(last.diff).toMatchObject({ revision_id: draft, restored_from_number: 2, replaced_draft: true });
  });

  it("replaces an untouched draft without asking", async () => {
    await commitAs(users.editor!.claims, (c) => rpc(c, "discard_draft", proc));
    await commitAs(users.editor!.claims, (c) => rpc(c, "open_draft", proc));
    const result = await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, v1, false));
    expect(result.status).toBe("restored");
    await commitAs(users.editor!.claims, (c) => rpc(c, "discard_draft", proc));
  });

  it("publishing the restored draft makes it a new version and keeps the old ones", async () => {
    await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, v1, false));
    const published = await commitAs(users.editor!.claims, (c) => rpc(c, "publish_process", proc, true));
    expect(published).toMatchObject({ status: "published", number: 4, previous_revision_id: v3 });
    const draftId = published.revision_id as string;
    expect(await revisionRows(draftId)).toEqual(await revisionRows(v1));
    expect(await processRow()).toMatchObject({ live_revision_id: draftId, draft_revision_id: null });
    expect((await db.client.query("select count(*)::int as n from process_revisions where process_id = $1 and status = 'superseded'", [proc])).rows[0].n).toBe(3);
  });

  it("refuses the live version, drafts, another process's version, and viewers", async () => {
    const live = (await processRow()).live_revision_id!;
    expect(await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, live, false))).toEqual({ status: "already_live" });

    await commitAs(users.editor!.claims, (c) => rpc(c, "open_draft", proc));
    const draft = (await processRow()).draft_revision_id!;
    expect(await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, draft, true))).toEqual({ status: "not_found" });
    await commitAs(users.editor!.claims, (c) => rpc(c, "discard_draft", proc));

    // A version of some other process (a servicing process of the same workspace).
    const [other] = (await db.client.query("select p.id as process_id, p.live_revision_id from processes p where p.workspace_id = $1 and p.id <> $2 and p.live_revision_id is not null limit 1", [ws, proc])).rows;
    expect(await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, other.live_revision_id, true))).toEqual({ status: "not_found" });

    for (const who of ["viewer", "stranger"]) {
      expect(await commitAs(users[who]!.claims, (c) => rpc(c, "restore_version", proc, v2, true))).toEqual({ status: "not_found" });
    }
    expect((await processRow()).draft_revision_id).toBeNull();
  });

  it("clears the link of a step holding a child process another ordinary process now holds (one only on the company map stays linked)", async () => {
    // A child process held by a step of a published version, then (after that step is removed and the next
    // version published) moved to the top level.
    const child = randomUUID();
    const holder = randomUUID();
    await db.client.query("insert into processes (id, workspace_id, name, kind, parent_process_id) values ($1, $2, 'Onboarding detail', 'pipeline', $3)", [child, ws, proc]);
    await commitAs(users.editor!.claims, (c) => rpc(c, "open_draft", proc));
    const draft = (await processRow()).draft_revision_id!;
    await commitAs(users.editor!.claims, (c) =>
      c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, child_process_id) values ($1, $2, $3, $4, 'Onboarding detail', 'subprocess', $5)", [holder, draft, ws, proc, child]),
    );
    const withChild = (await commitAs(users.editor!.claims, (c) => rpc(c, "publish_process", proc, true))).revision_id as string;

    // The child is still inside this process: restoring keeps the link.
    await commitAs(users.editor!.claims, (c) => rpc(c, "open_draft", proc));
    const d2 = (await processRow()).draft_revision_id!;
    await commitAs(users.editor!.claims, (c) => c.query("delete from steps where revision_id = $1 and id = $2", [d2, holder]));
    await commitAs(users.editor!.claims, (c) => rpc(c, "publish_process", proc, true));
    const kept = await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, withChild, true));
    expect(kept).toMatchObject({ status: "restored", unlinked_children: 0 });
    expect((await db.client.query("select child_process_id from steps where revision_id = $1 and id = $2", [kept.revision_id, holder])).rows[0].child_process_id).toBe(child);
    await commitAs(users.editor!.claims, (c) => rpc(c, "discard_draft", proc));

    // Now the child moves to the top level, onto the company map. B12: the map gives way, so restoring still keeps the link
    // (publishing it would move the child off the map again).
    await db.client.query("update processes set parent_process_id = null where id = $1", [child]);
    const onMap = await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, withChild, true));
    expect(onMap).toMatchObject({ status: "restored", unlinked_children: 0 });
    await commitAs(users.editor!.claims, (c) => rpc(c, "discard_draft", proc));

    // Held live by another ORDINARY process instead: the restored step stays, without its link.
    const other = randomUUID();
    const otherRev = randomUUID();
    await db.client.query("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Other holder', 'pipeline')", [other, ws]);
    await db.client.query("insert into process_revisions (id, workspace_id, process_id, number, status, published_at) values ($1, $2, $3, 1, 'published', now())", [otherRev, ws, other]);
    await db.client.query("insert into steps (revision_id, workspace_id, process_id, name, kind, child_process_id) values ($1, $2, $3, 'Onboarding detail', 'subprocess', $4)", [otherRev, ws, other, child]);
    await db.client.query("update processes set live_revision_id = $2 where id = $1", [other, otherRev]);
    const unlinked = await commitAs(users.editor!.claims, (c) => rpc(c, "restore_version", proc, withChild, true));
    expect(unlinked).toMatchObject({ status: "restored", unlinked_children: 1 });
    const row = (await db.client.query("select name, kind, child_process_id from steps where revision_id = $1 and id = $2", [unlinked.revision_id, holder])).rows[0];
    expect(row).toEqual({ name: "Onboarding detail", kind: "subprocess", child_process_id: null });
    await commitAs(users.editor!.claims, (c) => rpc(c, "discard_draft", proc));
  });
});

describe("duplicate_version", () => {
  it("creates a new top-level process whose draft is a copy of that version, with fresh ids", async () => {
    const before = await processRow();
    const result = await commitAs(users.editor!.claims, (c) => rpc(c, "duplicate_version", v2, "Sales (copy of v2)"));
    expect(result.status).toBe("duplicated");
    const copy = result.process_id as string;
    const draft = result.revision_id as string;

    const row = (await db.client.query("select name, kind, entity_name, parent_process_id, live_revision_id, draft_revision_id, workspace_id, source from processes where id = $1", [copy])).rows[0];
    const original = (await db.client.query("select kind, entity_name from processes where id = $1", [proc])).rows[0];
    expect(row).toEqual({
      name: "Sales (copy of v2)",
      kind: original.kind,
      entity_name: original.entity_name,
      parent_process_id: null,
      live_revision_id: null,
      draft_revision_id: draft,
      workspace_id: ws,
      source: "manual",
    });
    expect((await db.client.query("select number, status, process_id from process_revisions where id = $1", [draft])).rows[0]).toEqual({ number: 1, status: "draft", process_id: copy });

    // Same shape as version 2, with new ids and the new process id on every row.
    const src = await revisionRows(v2);
    const dup = await revisionRows(draft);
    expect(dup.steps).toHaveLength(src.steps.length);
    expect(dup.edges).toHaveLength(src.edges.length);
    const srcIds = new Set(src.steps.map((s) => s.id));
    expect(dup.steps.every((s) => !srcIds.has(s.id) && s.process_id === copy)).toBe(true);
    const names = (rows: Record<string, unknown>[]) => rows.map((s) => `${s.name}|${s.work_hours}|${s.kind}`).sort();
    expect(names(dup.steps)).toEqual(names(src.steps));
    // Edges join the copied steps, with the same probabilities.
    const dupIds = new Set(dup.steps.map((s) => s.id));
    expect(dup.edges.every((e) => dupIds.has(e.from_step_id) && dupIds.has(e.to_step_id) && e.process_id === copy)).toBe(true);
    const nameOf = (rows: Record<string, unknown>[]) => new Map(rows.map((s) => [s.id, s.name]));
    const edgeNames = (rows: { steps: Record<string, unknown>[]; edges: Record<string, unknown>[] }) => {
      const n = nameOf(rows.steps);
      return rows.edges.map((e) => `${n.get(e.from_step_id)}>${n.get(e.to_step_id)}:${e.probability}`).sort();
    };
    expect(edgeNames(dup)).toEqual(edgeNames(src));

    // The original is untouched: still live at version 4's successor, no draft.
    expect(await processRow()).toEqual(before);
  });

  it("puts the copy at the end of the company map's top level", async () => {
    const rows = (
      await db.client.query("select id, name, kind, live_revision_id, draft_revision_id, parent_process_id from processes where workspace_id = $1 order by created_at, id", [ws])
    ).rows;
    const listing = rows.map((p) => ({ id: p.id, name: p.name, kind: p.kind, live: Boolean(p.live_revision_id), draft: Boolean(p.draft_revision_id), parentId: p.parent_process_id }));
    const order = flattenCompanyMap(companyMap(listing));
    const last = order.at(-1)!;
    expect(last.process.name).toBe("Sales (copy of v2)");
    expect(last.depth).toBe(1);
  });

  it("copies a child process as a top-level process and clears its holder links, groups and all", async () => {
    // A step holding a child process, a group with a step in it, and a retired (replaced) step.
    const child = randomUUID();
    const holder = randomUUID();
    const group = randomUUID();
    const inGroup = randomUUID();
    const retired = randomUUID();
    await db.client.query("insert into processes (id, workspace_id, name, kind, parent_process_id) values ($1, $2, 'Hand-over detail', 'pipeline', $3)", [child, ws, proc]);
    await commitAs(users.editor!.claims, (c) => rpc(c, "open_draft", proc));
    const draft = (await processRow()).draft_revision_id!;
    await commitAs(users.editor!.claims, async (c) => {
      await c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, child_process_id) values ($1, $2, $3, $4, 'Hand-over detail', 'subprocess', $5)", [holder, draft, ws, proc, child]);
      await c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind) values ($1, $2, $3, $4, 'Welcome box', 'group')", [group, draft, ws, proc]);
      await c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, parent_step_id, rework_to_step_id) values ($1, $2, $3, $4, 'Inside the box', 'task', $5, $6)", [inGroup, draft, ws, proc, group, holder]);
      await c.query("update steps set entry_step_id = $3 where revision_id = $1 and id = $2", [draft, group, inGroup]);
      await c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, replaced_by) values ($1, $2, $3, $4, 'Old step', 'task', $5)", [retired, draft, ws, proc, [inGroup]]);
    });
    const published = (await commitAs(users.editor!.claims, (c) => rpc(c, "publish_process", proc, true))).revision_id as string;

    // Duplicating the child's own version puts the copy at the top level, not inside the parent.
    const childVersion = randomUUID();
    await db.client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 1, 'published')", [childVersion, ws, child]);
    await db.client.query("update processes set live_revision_id = $1 where id = $2", [childVersion, child]);
    const asChild = await commitAs(users.editor!.claims, (c) => rpc(c, "duplicate_version", childVersion, "Hand-over detail 2"));
    expect(asChild.status).toBe("duplicated");
    expect((await processRow(asChild.process_id as string)).parent_process_id).toBeNull();

    const result = await commitAs(users.editor!.claims, (c) => rpc(c, "duplicate_version", published, "Sales with a box"));
    expect(result.status).toBe("duplicated");
    const rows = (await db.client.query("select id, name, kind, child_process_id, parent_step_id, entry_step_id, rework_to_step_id from steps where revision_id = $1", [result.revision_id])).rows;
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.has("Old step")).toBe(false);
    expect(byName.get("Hand-over detail")).toMatchObject({ kind: "subprocess", child_process_id: null });
    const box = byName.get("Welcome box");
    const inside = byName.get("Inside the box");
    expect(box.id).not.toBe(group);
    expect(inside.parent_step_id).toBe(box.id);
    expect(box.entry_step_id).toBe(inside.id);
    expect(inside.rework_to_step_id).toBe(byName.get("Hand-over detail").id);
    // The child process itself still hangs from the original holder.
    expect((await processRow(child)).parent_process_id).toBe(proc);
  });

  it("checks the name and who is asking", async () => {
    const dup = (claims: Record<string, unknown>, name: unknown, revision = v2) => commitAs(claims, (c) => rpc(c, "duplicate_version", revision, name));
    expect(await dup(users.editor!.claims, "  ")).toEqual({ status: "invalid_name" });
    expect(await dup(users.editor!.claims, "x".repeat(121))).toEqual({ status: "invalid_name" });
    expect(await dup(users.editor!.claims, null)).toEqual({ status: "invalid_name" });
    expect(await dup(users.editor!.claims, "  sales (COPY of v2) ")).toEqual({ status: "name_taken" });
    // Viewers and strangers can't copy; neither can anyone copy a draft or a version that does not exist.
    expect(await dup(users.viewer!.claims, "Viewer's copy")).toEqual({ status: "not_found" });
    expect(await dup(users.stranger!.claims, "Stranger's copy")).toEqual({ status: "not_found" });
    await commitAs(users.editor!.claims, (c) => rpc(c, "open_draft", proc));
    const draft = (await processRow()).draft_revision_id!;
    expect(await dup(users.editor!.claims, "From a draft", draft)).toEqual({ status: "not_found" });
    expect(await dup(users.editor!.claims, "From nowhere", randomUUID())).toEqual({ status: "not_found" });
    await commitAs(users.editor!.claims, (c) => rpc(c, "discard_draft", proc));
    expect((await db.client.query("select count(*)::int as n from processes where name in ('Viewer''s copy', 'Stranger''s copy', 'From a draft', 'From nowhere')")).rows[0].n).toBe(0);
  });

  it("is not callable by anyone signed out", async () => {
    for (const sql of ["select public.duplicate_version($1, 'x')", "select public.restore_version($1, $1, false)", "select * from public.revision_history($1)"]) {
      await db.client.query("begin");
      try {
        await db.client.query("set local role anon");
        await expect(db.client.query(sql, [v2])).rejects.toMatchObject({ code: "42501" });
      } finally {
        await db.client.query("rollback");
      }
    }
  });
});

describe("revision_history changes", () => {
  it("does not count moving a step as a change", async () => {
    await commitAs(users.editor!.claims, (c) => rpc(c, "open_draft", proc));
    const draft = (await processRow()).draft_revision_id!;
    await db.client.query("update steps set x = x + 40, y = y + 10 where revision_id = $1 and id = $2", [draft, ids.audit]);
    await commitAs(users.editor!.claims, (c) => rpc(c, "publish_process", proc, true));
    const [latest] = await db.as(users.editor!.claims, async (c) => (await c.query("select number, changes from revision_history($1) limit 1", [proc])).rows);
    expect(latest.changes).toEqual({ steps: { added: 0, removed: 0, changed: 0 }, edges: { added: 0, removed: 0, changed: 0 } });
  });
});

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Claims, loadDeleteCandidates, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, resolveFirstPrinciples, firstPrinciplesDiffer, firstPrinciplesFromRow, firstPrinciplesToColumns, type FirstPrinciplesRow } from "../src";
import { emptyFirstPrinciples } from "@transpera-flow/engine";
import { createTestDb, createUser, type TestDb } from "./harness";

// First principles per process revision (issue #119, A54): one record per revision, edits go into the draft only,
// every member reads, owners and editors write, anon has nothing, and no one reaches another workspace's.

const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
const live = NORTHBEAM_REVISION_ID;
let db: TestDb;
let otherWs: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};

const insert = (c: pg.Client, revision: string, extra = "") =>
  c.query(`insert into first_principles (workspace_id, process_id, revision_id, job_progress ${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2, $3, 'More enquiries' ${extra ? ", " + extra.split("=")[1] : ""}) returning id`, [ws, proc, revision]);
const openDraft = async (c: pg.Client) => (await c.query("select public.open_draft($1) as r", [proc])).rows[0].r as { revision_id: string };

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@fp.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@fp.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-fp') returning id")).rows[0].id;
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [otherWs, users.stranger!.id]);
});

afterAll(async () => {
  await db?.close();
});

describe("first_principles: shape", () => {
  it("starts empty, and a row defaults to empty answers", async () => {
    expect((await db.client.query("select 1 from first_principles")).rowCount).toBe(0);
    await db.as(users.editor!.claims, async (c) => {
      const draft = await openDraft(c);
      await insert(c, draft.revision_id);
      const row = (await c.query("select * from first_principles")).rows[0];
      expect(row).toMatchObject({ job_progress: "More enquiries", job_who: "", statements: [], requirements: [], deletes: [], improvements: [], measures: [], why_chain: [], root_cause: "" });
      expect(row.updated_at).toBeTruthy();
    });
  });

  it("holds one record per revision", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const draft = await openDraft(c);
      await insert(c, draft.revision_id);
      await expect(insert(c, draft.revision_id)).rejects.toThrow(/first_principles_revision_id_key/);
    });
  });

  it("checks each part is the right kind of JSON and not too long", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const draft = await openDraft(c);
      await c.query("savepoint a");
      await expect(insert(c, draft.revision_id, "statements='{}'::jsonb")).rejects.toThrow(/check/);
      await c.query("rollback to a");
      await expect(insert(c, draft.revision_id, "requirements=(select jsonb_agg(1) from generate_series(1, 51))")).rejects.toThrow(/check/);
      await c.query("rollback to a");
      await expect(insert(c, draft.revision_id, "job_who=repeat('x', 2001)")).rejects.toThrow(/check/);
    });
  });

  it("refuses a revision of another process or workspace", async () => {
    await expect(
      db.client.query("insert into first_principles (workspace_id, process_id, revision_id) values ($1, $2, $3)", [otherWs, proc, live]),
    ).rejects.toThrow(/violates foreign key/);
  });

  it("ties a row's revision to its process: another process's revision is refused, even as an editor in the same workspace", async () => {
    const other = (await db.client.query("select id, live_revision_id from processes where workspace_id = $1 and id <> $2 and live_revision_id is not null limit 1", [ws, proc])).rows[0];
    expect(other, "the seed has a second process").toBeTruthy();
    await expect(
      db.client.query("insert into first_principles (workspace_id, process_id, revision_id) values ($1, $2, $3)", [ws, proc, other.live_revision_id]),
    ).rejects.toThrow(/first_principles_revision_id_process_id_workspace_id_fkey/);
    await db.as(users.editor!.claims, async (c) => {
      const draft = await openDraft(c);
      await expect(c.query("insert into first_principles (workspace_id, process_id, revision_id) values ($1, $2, $3)", [ws, other.id, draft.revision_id])).rejects.toThrow(/violates foreign key/);
    });
  });

  it("caps each JSON part at 512 KB as text, and takes the app's largest allowed list", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const draft = await openDraft(c);
      await c.query("savepoint a");
      // Three 200 KB texts: under the item count, over the byte cap.
      await expect(insert(c, draft.revision_id, "statements=(select jsonb_build_array(repeat('x', 200000), repeat('x', 200000), repeat('x', 200000)))")).rejects.toThrow(/check/);
      await c.query("rollback to a");
      const biggest = firstPrinciplesToColumns({ ...emptyFirstPrinciples(), statements: Array.from({ length: 50 }, () => ({ text: "😀".repeat(500), kind: "truth" as const, source: "😀".repeat(500), test: "😀".repeat(500), linked_parameter: null })) });
      await c.query("insert into first_principles (workspace_id, process_id, revision_id, statements) values ($1, $2, $3, $4)", [ws, proc, draft.revision_id, JSON.stringify(biggest.statements)]);
    });
  });

  it("keeps updated_at moving", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const draft = await openDraft(c);
      await insert(c, draft.revision_id);
      const before = (await c.query("select updated_at from first_principles")).rows[0].updated_at as Date;
      await c.query("select pg_sleep(0.01)");
      // now() is the transaction's start inside one transaction, so move the clock the trigger reads.
      await c.query("update first_principles set job_who = 'Founders' where revision_id = $1", [draft.revision_id]);
      const after = (await c.query("select updated_at from first_principles")).rows[0].updated_at as Date;
      expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });
});

describe("first_principles: drafts only", () => {
  it("refuses a write to the live revision, even for an owner", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        await expect(insert(c, live), role).rejects.toThrow(/edits go into the process's draft/);
      });
    }
  });

  it("refuses to change or delete a row once its revision is published", async () => {
    const draft = (await db.client.query("select public.open_draft($1) as r", [proc])).rows[0].r as { revision_id: string };
    await db.client.query("insert into first_principles (workspace_id, process_id, revision_id, job_progress) values ($1, $2, $3, 'v2')", [ws, proc, draft.revision_id]);
    await db.client.query("select public.publish_process($1, true)", [proc]);
    try {
      await db.as(users.editor!.claims, async (c) => {
        await expect(c.query("update first_principles set job_progress = 'edited' where revision_id = $1", [draft.revision_id])).rejects.toThrow(/published/);
      });
      await db.as(users.editor!.claims, async (c) => {
        await expect(c.query("delete from first_principles where revision_id = $1", [draft.revision_id])).rejects.toThrow(/published/);
      });
      // History keeps it: the published version still holds what it was published with.
      expect((await db.client.query("select job_progress from first_principles where revision_id = $1", [draft.revision_id])).rows[0].job_progress).toBe("v2");
    } finally {
      await db.client.query("delete from first_principles where revision_id = $1", [draft.revision_id]);
    }
  });

  it("goes with the draft when it is discarded", async () => {
    const draft = (await db.client.query("select public.open_draft($1) as r", [proc])).rows[0].r as { revision_id: string };
    await db.client.query("insert into first_principles (workspace_id, process_id, revision_id) values ($1, $2, $3)", [ws, proc, draft.revision_id]);
    await db.as(users.editor!.claims, async (c) => {
      await c.query("select public.discard_draft($1)", [proc]);
      expect((await c.query("select 1 from first_principles")).rowCount).toBe(0);
    });
    await db.client.query("select public.discard_draft($1)", [proc]);
    expect((await db.client.query("select 1 from first_principles")).rowCount).toBe(0);
  });
});

describe("first_principles: row-level security", () => {
  it("lets owners and editors insert, change and remove a draft's first principles", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        const draft = await openDraft(c);
        expect((await insert(c, draft.revision_id)).rowCount, role).toBe(1);
        expect((await c.query("update first_principles set job_who = 'x' where revision_id = $1", [draft.revision_id])).rowCount, role).toBe(1);
        expect((await c.query("delete from first_principles where revision_id = $1", [draft.revision_id])).rowCount, role).toBe(1);
      });
    }
  });

  it("lets every member read it", async () => {
    const draft = (await db.client.query("select public.open_draft($1) as r", [proc])).rows[0].r as { revision_id: string };
    await db.client.query("insert into first_principles (workspace_id, process_id, revision_id, job_progress) values ($1, $2, $3, 'Visible')", [ws, proc, draft.revision_id]);
    try {
      for (const role of ["owner", "editor", "member", "viewer"]) {
        const rows = await db.as(users[role]!.claims, async (c) => (await c.query("select job_progress from first_principles")).rows);
        expect(rows, role).toEqual([{ job_progress: "Visible" }]);
      }
    } finally {
      await db.client.query("select public.discard_draft($1)", [proc]);
    }
  });

  it("stops members and viewers writing", async () => {
    const draft = (await db.client.query("select public.open_draft($1) as r", [proc])).rows[0].r as { revision_id: string };
    await db.client.query("insert into first_principles (workspace_id, process_id, revision_id, job_progress) values ($1, $2, $3, 'Kept')", [ws, proc, draft.revision_id]);
    try {
      for (const role of ["member", "viewer"]) {
        await db.as(users[role]!.claims, async (c) => {
          expect((await c.query("update first_principles set job_progress = 'x'")).rowCount, role).toBe(0);
          expect((await c.query("delete from first_principles")).rowCount, role).toBe(0);
        });
        await db.as(users[role]!.claims, async (c) => {
          await expect(
            c.query("insert into first_principles (workspace_id, process_id, revision_id) values ($1, $2, $3)", [ws, proc, randomUUID()]),
            role,
          ).rejects.toThrow(/row-level security|foreign key/);
        });
      }
      expect((await db.client.query("select job_progress from first_principles")).rows).toEqual([{ job_progress: "Kept" }]);
    } finally {
      await db.client.query("select public.discard_draft($1)", [proc]);
    }
  });

  it("hides another workspace's, and stops its members writing into this one", async () => {
    const draft = (await db.client.query("select public.open_draft($1) as r", [proc])).rows[0].r as { revision_id: string };
    await db.client.query("insert into first_principles (workspace_id, process_id, revision_id) values ($1, $2, $3)", [ws, proc, draft.revision_id]);
    try {
      expect(await db.as(users.stranger!.claims, async (c) => (await c.query("select 1 from first_principles")).rowCount)).toBe(0);
      await db.as(users.stranger!.claims, async (c) => {
        expect((await c.query("update first_principles set job_who = 'x'")).rowCount).toBe(0);
        expect((await c.query("delete from first_principles")).rowCount).toBe(0);
      });
    } finally {
      await db.client.query("select public.discard_draft($1)", [proc]);
    }
  });

  it("gives the anon role nothing", async () => {
    await expect(
      db.as(null, async (c) => {
        await c.query("reset role");
        await c.query("set local role anon");
        return c.query("select 1 from first_principles");
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.as(null, async (c) => {
        await c.query("reset role");
        await c.query("set local role anon");
        return c.query("insert into first_principles (workspace_id, process_id, revision_id) values ($1, $2, $3)", [ws, proc, live]);
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("first_principles: audit of MCP writes", () => {
  it("logs an API-token write with actor_kind mcp, and a canvas write not at all", async () => {
    const tokenId = randomUUID();
    await db.as({ ...users.editor!.claims, api_token_id: tokenId }, async (c) => {
      const draft = await openDraft(c);
      await insert(c, draft.revision_id);
      await c.query("update first_principles set job_who = 'Founders' where revision_id = $1", [draft.revision_id]);
      await c.query("reset role");
      const rows = (await c.query("select action, diff from audit_log where target_table = 'first_principles' and created_at = now() order by action")).rows;
      expect(rows.map((r) => r.action)).toEqual(["insert", "update"]);
      expect(rows[1].diff).toMatchObject({ new: { job_who: "Founders" }, revision_id: draft.revision_id, api_token_id: tokenId });
    });
    await db.as(users.editor!.claims, async (c) => {
      const draft = await openDraft(c);
      await insert(c, draft.revision_id);
      await c.query("reset role");
      expect((await c.query("select 1 from audit_log where target_table = 'first_principles' and created_at = now()")).rowCount).toBe(0);
    });
  });
});

describe("resolving a revision's first principles", () => {
  const row = (revision_id: string, progress: string, updated_at: string): FirstPrinciplesRow => ({
    id: randomUUID(),
    workspace_id: ws,
    process_id: proc,
    revision_id,
    ...firstPrinciplesToColumns({ ...emptyFirstPrinciples(), job: { who: "", progress, situation: "", done: "" } }),
    updated_at,
  });
  const revisions = [
    { id: "r1", number: 1 },
    { id: "r2", number: 2 },
    { id: "r3", number: 3 },
  ];

  it("reads a revision's own row, with its version", () => {
    const got = resolveFirstPrinciples(revisions, [row("r2", "two", "t2"), row("r1", "one", "t1")], "r2");
    expect(got).toMatchObject({ version: "t2", inheritedFrom: null });
    expect(got.doc?.job.progress).toBe("two");
  });
  it("inherits the nearest earlier row, with no version, so the next save inserts", () => {
    const got = resolveFirstPrinciples(revisions, [row("r1", "one", "t1"), row("r2", "two", "t2")], "r3");
    expect(got).toMatchObject({ version: null, inheritedFrom: 2 });
    expect(got.doc?.job.progress).toBe("two");
  });
  it("never reads a later revision's row", () => {
    expect(resolveFirstPrinciples(revisions, [row("r3", "three", "t3")], "r1")).toEqual({ doc: null, version: null, inheritedFrom: null });
  });
  it("is empty for a revision that is unknown or has nothing before it", () => {
    expect(resolveFirstPrinciples(revisions, [], "r2").doc).toBeNull();
    expect(resolveFirstPrinciples(revisions, [row("r1", "one", "t1")], "nope").doc).toBeNull();
  });
  it("sees a draft whose answers differ from live's as a change, and an inherited one as none", () => {
    const revs = [{ id: "r1", number: 1 }, { id: "r2", number: 2 }];
    const live = resolveFirstPrinciples(revs, [row("r1", "one", "t1")], "r1");
    expect(firstPrinciplesDiffer(live, resolveFirstPrinciples(revs, [row("r1", "one", "t1")], "r2"))).toBe(false);
    expect(firstPrinciplesDiffer(live, resolveFirstPrinciples(revs, [row("r1", "one", "t1"), row("r2", "two", "t2")], "r2"))).toBe(true);
    // Live has no answers, the draft has some: still a change to publish.
    expect(firstPrinciplesDiffer(resolveFirstPrinciples(revs, [row("r2", "two", "t2")], "r1"), resolveFirstPrinciples(revs, [row("r2", "two", "t2")], "r2"))).toBe(true);
  });
  it("round-trips through the columns", () => {
    const doc = { ...emptyFirstPrinciples(), why: { problem: "p", chain: ["a", "b"], root: "r" } };
    expect(firstPrinciplesFromRow(row("r1", "x", "t") as FirstPrinciplesRow).why.chain).toEqual([""]);
    expect(firstPrinciplesFromRow({ ...row("r1", "x", "t"), ...firstPrinciplesToColumns(doc) }).why).toEqual(doc.why);
  });
});

describe("loadDeleteCandidates (sandbox phase 4)", () => {
  it("reads an inherited row, leaves out a step put back, and gives an empty list for a process with no answers", async () => {
    const audit = "e0000000-0000-4000-8000-000000000003";
    const kickoff = "e0000000-0000-4000-8000-000000000006";
    const editorDb = db.dbAs(users.editor!.claims as unknown as Claims);
    expect(await loadDeleteCandidates(editorDb, [{ processId: proc, revisionId: live }])).toEqual({ [proc]: [] });
    expect(await loadDeleteCandidates(editorDb, [])).toEqual({});
    const deletes = [
      { step_id: audit, breaks_if_removed: "", agreed_by: null, added_back: false },
      { step_id: kickoff, breaks_if_removed: "", agreed_by: null, added_back: true },
    ];
    await db.client.query("insert into first_principles (workspace_id, process_id, revision_id, deletes) values ($1, $2, $3, $4::jsonb)", [ws, proc, live, JSON.stringify(deletes)]);
    const draft = (await db.client.query("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 2, 'draft') returning id", [ws, proc])).rows[0].id as string;
    try {
      expect(await loadDeleteCandidates(editorDb, [{ processId: proc, revisionId: live }])).toEqual({ [proc]: [audit] });
      // The draft has no row of its own: it inherits live's answers.
      expect(await loadDeleteCandidates(editorDb, [{ processId: proc, revisionId: draft }])).toEqual({ [proc]: [audit] });
    } finally {
      await db.client.query("delete from first_principles where process_id = $1", [proc]);
      await db.client.query("delete from process_revisions where id = $1", [draft]);
    }
  });
});

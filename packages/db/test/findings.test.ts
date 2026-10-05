import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Findings (issue #175, B17; decision D40; migration 20261205000000). Every member reads them; owners and editors add
// findings by hand (accepted at once) and accept, edit or dismiss them; AI findings start proposed and must come from an
// analysis the writer ran in the last 15 minutes; nobody deletes one; anon has nothing; another workspace sees nothing.

const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
const live = NORTHBEAM_REVISION_ID;
let db: TestDb;
let otherWs: string;
let otherProc: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};

const manual = (c: pg.Client, extra: Record<string, unknown> = {}) => {
  const row = { workspace_id: ws, process_id: proc, origin: "manual", status: "accepted", rating: "bad", type: "delay", title: "Proposals wait for the strategist", why: "Clients wait.", ...extra };
  const cols = Object.keys(row);
  return c.query(`insert into findings (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, Object.values(row));
};

/** The run that wrote each seeded analysis (an AI finding cites both). */
const runOf = new Map<string, string>();

/** An analysis written by `user` (as the administrator, triggers off), `age` ago: what an AI finding must cite. */
async function seedAnalysis(user: string, age = "1 minute", revision = live) {
  await db.client.query("begin");
  await db.client.query("set local session_replication_role = replica");
  const run = (await db.client.query("insert into ai_runs (workspace_id, process_id, trigger, user_id, started_at) values ($1, $2, 'manual', $3, now() - $4::interval) returning id", [ws, proc, user, age])).rows[0].id;
  const id = (
    await db.client.query(
      "insert into ai_analyses (workspace_id, process_id, revision_id, status, trigger, input_hash, run_id, created_by, updated_at) values ($1, $2, $3, 'ok', 'manual', 'h', $4, $5, now() - $6::interval) returning id",
      [ws, proc, revision, run, user, age],
    )
  ).rows[0].id as string;
  await db.client.query("commit");
  runOf.set(id, run);
  return id;
}

/** A later run of the same analysis by `user` (analyses are one per version, so the row stays and names the new run). */
async function rerun(analysisId: string, user: string) {
  await db.client.query("begin");
  await db.client.query("set local session_replication_role = replica");
  const run = (await db.client.query("insert into ai_runs (workspace_id, process_id, trigger, user_id) values ($1, $2, 'manual', $3) returning id", [ws, proc, user])).rows[0].id as string;
  await db.client.query("update ai_analyses set run_id = $2, updated_at = now(), created_by = $3 where id = $1", [analysisId, run, user]);
  await db.client.query("commit");
  runOf.set(analysisId, run);
  return run;
}

const ai = (c: pg.Client, analysisId: string | null, extra: Record<string, unknown> = {}) =>
  manual(c, { origin: "ai", status: "proposed", ai_key: "ai:insight:abc123", analysis_id: analysisId, run_id: (analysisId && runOf.get(analysisId)) ?? null, ...extra });

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@findings.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@findings.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-findings') returning id")).rows[0].id;
  otherProc = (await db.client.query("insert into processes (workspace_id, name) values ($1, 'Theirs') returning id", [otherWs])).rows[0].id;
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [otherWs, users.stranger!.id]);
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.client.query("delete from findings");
  await db.client.query("delete from ai_analyses");
  await db.client.query("delete from ai_runs");
});

describe("findings by hand", () => {
  it("lets owners and editors add one, accepted at once and stamped with who and when, whatever the client sent", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        const row = (await manual(c, { created_by: users.viewer!.id, decided_by: users.viewer!.id })).rows[0];
        expect(row, role).toMatchObject({ status: "accepted", origin: "manual", created_by: users[role]!.id, decided_by: users[role]!.id, updated_by: users[role]!.id });
        expect(row.decided_at).not.toBeNull();
      });
    }
  });

  it("refuses a viewer, a member without edit rights, another workspace's owner and anon", async () => {
    for (const role of ["viewer", "member", "stranger"]) {
      await db.as(users[role]!.claims, async (c) => {
        // The trigger may refuse first (the stranger can't see the process); either way nothing is written.
        await expect(manual(c), role).rejects.toThrow(/row-level security|process must be one of/);
      });
    }
    await db.client.query("begin");
    await db.client.query("set local role anon");
    await expect(db.client.query("select 1 from findings")).rejects.toThrow(/permission denied/);
    await db.client.query("rollback");
  });

  it("must start accepted and cite no analysis", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await expect(manual(c, { status: "proposed" })).rejects.toThrow(/added by hand starts accepted/);
    });
  });

  it("refuses a process of another workspace", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await expect(manual(c, { process_id: otherProc })).rejects.toThrow(/process must be one of the workspace/);
    });
  });

  it("lets every member read, a viewer change nothing, and an editor edit and dismiss; nobody deletes", async () => {
    const id = (await db.as(users.owner!.claims, async (c) => (await manual(c)).rows[0].id as string));
    // `as` rolls back: write it for real as the administrator, attributed to the owner.
    const real = (await db.client.query("insert into findings (workspace_id, process_id, origin, status, rating, type, title) values ($1, $2, 'manual', 'accepted', 'bad', 'delay', 'Slow replies') returning id", [ws, proc])).rows[0].id as string;
    expect(id).toBeTruthy();
    for (const role of ["owner", "editor", "member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await c.query("select title from findings where id = $1", [real])).rows, role).toEqual([{ title: "Slow replies" }]);
      });
    }
    await db.as(users.viewer!.claims, async (c) => {
      expect((await c.query("update findings set title = 'Theirs' where id = $1", [real])).rowCount).toBe(0);
      expect((await c.query("update findings set status = 'dismissed' where id = $1", [real])).rowCount).toBe(0);
    });
    await db.as(users.editor!.claims, async (c) => {
      const edited = (await c.query("update findings set title = 'Replies wait two days', why = 'Clients notice.' where id = $1 returning updated_by, decided_by", [real])).rows[0];
      expect(edited).toEqual({ updated_by: users.editor!.id, decided_by: null });
      const dismissed = (await c.query("update findings set status = 'dismissed' where id = $1 returning decided_by", [real])).rows[0];
      expect(dismissed.decided_by).toBe(users.editor!.id);
      await expect(c.query("delete from findings where id = $1", [real])).rejects.toThrow(/permission denied/);
    });
    await db.as(users.stranger!.claims, async (c) => {
      expect((await c.query("select 1 from findings")).rowCount).toBe(0);
      expect((await c.query("update findings set title = 'x'")).rowCount).toBe(0);
    });
  });

  it("never changes its workspace, origin or creator, and never goes back to proposed", async () => {
    const real = (await db.client.query("insert into findings (workspace_id, process_id, origin, status, rating, type, title) values ($1, $2, 'manual', 'accepted', 'bad', 'delay', 'Slow replies') returning id", [ws, proc])).rows[0].id as string;
    await db.as(users.editor!.claims, async (c) => {
      for (const set of ["origin = 'ai', ai_key = 'ai:insight:x'", `created_by = '${users.viewer!.id}'`]) {
        await c.query("savepoint s");
        await expect(c.query(`update findings set ${set} where id = $1`, [real]), set).rejects.toThrow(/cannot be changed/);
        await c.query("rollback to savepoint s");
      }
      await expect(c.query("update findings set status = 'proposed' where id = $1", [real])).rejects.toThrow(/back to proposed/);
    });
  });
});

describe("AI findings", () => {
  it("are proposed from an analysis the writer ran in the last 15 minutes, and accepted or dismissed by an editor", async () => {
    const mine = await seedAnalysis(users.editor!.id);
    await db.as(users.editor!.claims, async (c) => {
      const row = (await ai(c, mine)).rows[0];
      expect(row).toMatchObject({ status: "proposed", decided_by: null, created_by: users.editor!.id });
      expect(row.edited).toBe(false);
      const accepted = (await c.query("update findings set status = 'accepted', title = 'Edited' where id = $1 returning status, decided_by, title, edited", [row.id])).rows[0];
      // Changing what it says marks it edited, so the page doesn't call the editor's words AI's.
      expect(accepted).toEqual({ status: "accepted", decided_by: users.editor!.id, title: "Edited", edited: true });
      await c.query("savepoint s");
      await expect(c.query("update findings set status = 'superseded' where id = $1", [row.id])).rejects.toThrow(/only a proposed AI finding is superseded/);
      await c.query("rollback to savepoint s");
      await expect(c.query("update findings set analysis_id = gen_random_uuid() where id = $1", [row.id])).rejects.toThrow(/cannot be changed/);
    });
  });

  it("must cite the run that wrote the analysis, not another", async () => {
    const mine = await seedAnalysis(users.editor!.id);
    const earlier = runOf.get(mine)!;
    await rerun(mine, users.editor!.id);
    await db.as(users.editor!.claims, async (c) => {
      await expect(ai(c, mine, { run_id: earlier })).rejects.toThrow(/must come from an analysis you ran/);
    });
  });

  it("keeps the facts an AI finding cites as cited, while its words can be edited; a finding by hand is never 'edited'", async () => {
    const mine = await seedAnalysis(users.editor!.id);
    await db.as(users.editor!.claims, async (c) => {
      const cited = [{ kind: "fact", key: "wait:step:a", text: "Work waits 6.2 days." }];
      const row = (await ai(c, mine, { facts: JSON.stringify(cited), edited: true })).rows[0];
      // The client can't mark it edited.
      expect(row.edited).toBe(false);
      await c.query("savepoint s");
      await expect(c.query("update findings set facts = '[]' where id = $1", [row.id])).rejects.toThrow(/facts an AI finding cites stay/);
      await c.query("rollback to savepoint s");
      expect((await c.query("update findings set why = 'Clients leave.' where id = $1 returning edited, facts", [row.id])).rows[0]).toEqual({ edited: true, facts: cited });
      // Only the database sets it: it can't be cleared either.
      expect((await c.query("update findings set edited = false where id = $1 returning edited", [row.id])).rows[0].edited).toBe(true);
      const byHand = (await manual(c)).rows[0];
      const changed = (await c.query("update findings set title = 'Slower', facts = $2, edited = true where id = $1 returning edited", [byHand.id, JSON.stringify(cited)])).rows[0];
      expect(changed.edited).toBe(false);
    });
  });

  it("refuses to accept or dismiss a superseded proposal; a later run of the writer's can propose it again", async () => {
    const a = await seedAnalysis(users.editor!.id);
    await db.client.query("begin");
    await db.client.query("set local session_replication_role = replica");
    const id = (
      await db.client.query(
        "insert into findings (workspace_id, process_id, origin, status, rating, type, title, ai_key, analysis_id, run_id) values ($1, $2, 'ai', 'superseded', 'bad', 'delay', 'Proposals wait', 'ai:insight:abc123', $3, $4) returning id",
        [ws, proc, a, runOf.get(a)],
      )
    ).rows[0].id as string;
    await db.client.query("commit");
    await db.as(users.editor!.claims, async (c) => {
      for (const status of ["accepted", "dismissed"]) {
        await c.query("savepoint s");
        await expect(c.query("update findings set status = $2 where id = $1", [id, status]), status).rejects.toThrow(/later analysis replaced this proposal/);
        await c.query("rollback to savepoint s");
      }
      // Proposed again without a new run: nothing new ran, so it isn't allowed.
      await expect(c.query("update findings set status = 'proposed' where id = $1", [id])).rejects.toThrow(/back to proposed/);
    });
    const owners = await rerun(a, users.owner!.id);
    await db.as(users.editor!.claims, async (c) => {
      // Someone else's run can't be claimed.
      await expect(c.query("update findings set status = 'proposed', run_id = $2 where id = $1", [id, owners])).rejects.toThrow(/must come from an analysis you ran/);
    });
    const next = await rerun(a, users.editor!.id);
    await db.as(users.editor!.claims, async (c) => {
      const again = (await c.query("update findings set status = 'proposed', run_id = $2, title = 'Proposals wait a week', facts = '[]' where id = $1 returning status, run_id, edited, decided_by", [id, next])).rows[0];
      expect(again).toEqual({ status: "proposed", run_id: next, edited: false, decided_by: null });
      // And now it can be decided; once decided, its run never changes again.
      expect((await c.query("update findings set status = 'accepted' where id = $1 returning status", [id])).rows[0].status).toBe("accepted");
      await expect(c.query("update findings set status = 'proposed', run_id = $2 where id = $1", [id, runOf.get(a)])).rejects.toThrow(/back to proposed|cannot be changed/);
    });
  });

  it("cites only sources of its own workspace", async () => {
    const own = (await db.client.query("insert into sources (workspace_id, title) values ($1, 'Kickoff call') returning id", [ws])).rows[0].id as string;
    const theirs = (await db.client.query("insert into sources (workspace_id, title) values ($1, 'Their call') returning id", [otherWs])).rows[0].id as string;
    try {
      await db.as(users.editor!.claims, async (c) => {
        const row = (await manual(c, { source_ids: [own] })).rows[0];
        expect(row.source_ids).toEqual([own]);
        await c.query("savepoint s");
        await expect(manual(c, { source_ids: [own, theirs] })).rejects.toThrow(/every source cited must be one of the workspace/);
        await c.query("rollback to savepoint s");
        await expect(c.query("update findings set source_ids = $2 where id = $1", [row.id, [theirs]])).rejects.toThrow(/every source cited must be one of the workspace/);
      });
    } finally {
      await db.client.query("delete from sources where id = any($1)", [[own, theirs]]);
    }
  });

  it("refuses an AI finding from no analysis, someone else's, an old one, or one that starts accepted", async () => {
    const theirs = await seedAnalysis(users.owner!.id);
    await db.client.query("delete from ai_analyses where id = $1", [theirs]);
    const owners = await seedAnalysis(users.owner!.id);
    await db.client.query("delete from ai_runs where id not in (select run_id from ai_analyses)");
    await db.as(users.editor!.claims, async (c) => {
      for (const [label, analysisId] of [["none", null], ["someone else's", owners]] as const) {
        await c.query("savepoint s");
        await expect(ai(c, analysisId), label).rejects.toThrow(/must come from an analysis you ran/);
        await c.query("rollback to savepoint s");
      }
    });
    await db.client.query("delete from ai_analyses");
    const old = await seedAnalysis(users.editor!.id, "20 minutes");
    await db.as(users.editor!.claims, async (c) => {
      await expect(ai(c, old)).rejects.toThrow(/must come from an analysis you ran/);
    });
    await db.client.query("delete from ai_analyses");
    const fresh = await seedAnalysis(users.editor!.id);
    await db.as(users.editor!.claims, async (c) => {
      await expect(ai(c, fresh, { status: "accepted" })).rejects.toThrow(/starts as proposed/);
    });
    await db.as(users.viewer!.claims, async (c) => {
      await expect(ai(c, fresh)).rejects.toThrow(/row-level security|must come from an analysis you ran/);
    });
  });

  it("proposes one finding per key and process, and supersedes only proposals", async () => {
    const a = await seedAnalysis(users.editor!.id);
    await db.as(users.editor!.claims, async (c) => {
      const first = (await ai(c, a)).rows[0];
      await c.query("savepoint s");
      await expect(ai(c, a)).rejects.toThrow(/duplicate key/);
      await c.query("rollback to savepoint s");
      // The same key across the company (no process) is a different finding.
      expect((await ai(c, a, { process_id: null })).rowCount).toBe(1);
      expect((await c.query("update findings set status = 'superseded' where id = $1 returning status", [first.id])).rows[0].status).toBe("superseded");
    });
  });
});

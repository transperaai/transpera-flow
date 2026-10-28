import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Solutions (issue #114, A49): a separate copy of a process with changed steps, linked to the issues it solves. Members
// read, editors write, anon has nothing; a link cannot cross workspaces; linking moves an Open issue to Testing
// solutions and logs `solution_tested` through A47's mechanism; and saving a solution never touches live or the draft.

const ws = NORTHBEAM_WORKSPACE_ID;
const [openIssue, testingIssue] = northbeamIssues().map((i) => i.id) as [string, string, string];
let db: TestDb;
let otherWs: string;
let otherIssue: string;
let otherProcess: string;
let otherRevision: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const bundle = JSON.stringify({ steps: [], edges: [], entry_step_id: null });

const solution = (c: pg.Client, workspace = ws, process = NORTHBEAM_PROCESS_ID, revision = NORTHBEAM_REVISION_ID, name = "AI lead qualifier") =>
  c.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, $4, $5::jsonb) returning id", [workspace, process, revision, name, bundle]);
const link = (c: pg.Client, solutionId: string, issueId: string, workspace = ws) =>
  c.query("insert into solution_issues (solution_id, issue_id, workspace_id, auto_verdict, holds_pct) values ($1, $2, $3, 'pass', 95)", [solutionId, issueId, workspace]);
const save = async (c: pg.Client, links: unknown[] = [], name = "Fast track") =>
  (await c.query("select public.save_solution($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb) as r", [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, name, bundle, "[]", "[]", JSON.stringify(links)])).rows[0].r as { id: string; name: string };
const events = async (c: pg.Client, issue: string) => (await c.query("select kind, actor, detail from issue_events where issue_id = $1 order by seq", [issue])).rows;
const issueStatus = async (c: pg.Client, issue: string) => (await c.query("select status from issues where id = $1", [issue])).rows[0].status as string;
/** Outside a transaction (as the superuser): run `run` in one that is rolled back. */
const failsAtRoot = async (run: () => Promise<unknown>, pattern: RegExp) => {
  await db.client.query("begin");
  try {
    await expect(run()).rejects.toThrow(pattern);
  } finally {
    await db.client.query("rollback");
  }
};
const newIssue = async (workspace = ws, process: string | null = NORTHBEAM_PROCESS_ID, extra = "") =>
  (await db.client.query(`insert into issues (workspace_id, process_id, title, type, severity, source ${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2, 'Fresh', 'delay', 'warning', 'manual' ${extra ? ", " + extra.split("=")[1] : ""}) returning id`, [workspace, process])).rows[0].id as string;
const fails = async (c: pg.Client, run: () => Promise<unknown>, pattern: RegExp) => {
  await c.query("savepoint s");
  try {
    await expect(run()).rejects.toThrow(pattern);
  } finally {
    await c.query("rollback to savepoint s");
  }
};

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@solutions.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@solutions.example.com");
  otherWs = (await db.client.query("insert into workspaces (name, slug) values ('Other', 'other-solutions') returning id")).rows[0].id;
  otherProcess = randomUUID();
  otherRevision = randomUUID();
  await db.client.query("insert into processes (id, workspace_id, name) values ($1, $2, 'Theirs')", [otherProcess, otherWs]);
  await db.client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 1, 'draft')", [otherRevision, otherWs, otherProcess]);
  await db.client.query("update process_revisions set status = 'published' where id = $1", [otherRevision]);
  otherIssue = (await db.client.query("insert into issues (workspace_id, process_id, title, type, severity, source) values ($1, $2, 'Theirs', 'delay', 'warning', 'manual') returning id", [otherWs, otherProcess])).rows[0].id;
});

afterAll(async () => {
  await db?.close();
});

describe("solutions: row-level security", () => {
  it("lets owners and editors save, change and delete a solution", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        const id = (await solution(c)).rows[0].id;
        expect((await c.query("update solutions set name = 'Renamed', notes = 'Tried it' where id = $1", [id])).rowCount, role).toBe(1);
        expect((await c.query("delete from solutions where id = $1", [id])).rowCount, role).toBe(1);
      });
    }
  });

  it("lets every member read, and only owners and editors write", async () => {
    const id = (await solution(db.client)).rows[0].id;
    const linked = await newIssue();
    await link(db.client, id, linked);
    try {
      for (const role of ["owner", "editor", "member", "viewer"]) {
        const rows = await db.as(users[role]!.claims, async (c) => ({
          solutions: (await c.query("select name from solutions")).rows,
          links: (await c.query("select issue_id, auto_verdict, holds_pct from solution_issues")).rows,
        }));
        expect(rows.solutions, role).toEqual([{ name: "AI lead qualifier" }]);
        expect(rows.links, role).toEqual([{ issue_id: linked, auto_verdict: "pass", holds_pct: 95 }]);
      }
      for (const role of ["member", "viewer"]) {
        await db.as(users[role]!.claims, async (c) => {
          await fails(c, () => solution(c), /row-level security|cannot edit this workspace/);
          expect((await c.query("update solutions set name = 'x' where id = $1", [id])).rowCount, role).toBe(0);
          expect((await c.query("delete from solutions where id = $1", [id])).rowCount, role).toBe(0);
          await fails(c, () => link(c, id, testingIssue), /row-level security|cannot edit this workspace/);
          expect((await c.query("update solution_issues set user_verdict = 'fail' where solution_id = $1", [id])).rowCount, role).toBe(0);
          expect((await c.query("delete from solution_issues where solution_id = $1", [id])).rowCount, role).toBe(0);
          await fails(c, () => save(c), /cannot edit this workspace/);
        });
      }
    } finally {
      await db.client.query("delete from solutions where id = $1", [id]);
      await db.client.query("delete from issues where id = $1", [linked]);
    }
  });

  it("gives anon and people outside the workspace nothing", async () => {
    const id = (await solution(db.client)).rows[0].id;
    const linked = await newIssue();
    await link(db.client, id, linked);
    try {
      await db.as(users.stranger!.claims, async (c) => {
        expect((await c.query("select 1 from solutions")).rowCount).toBe(0);
        expect((await c.query("select 1 from solution_issues")).rowCount).toBe(0);
        await fails(c, () => solution(c), /row-level security|cannot edit this workspace/);
        await fails(c, () => save(c), /cannot edit this workspace/);
      });
      await db.client.query("begin");
      try {
        await db.client.query("set local role anon");
        await expect(db.client.query("select 1 from solutions")).rejects.toThrow(/permission denied/);
        await db.client.query("rollback");
        await db.client.query("begin");
        await db.client.query("set local role anon");
        await expect(db.client.query("select 1 from solution_issues")).rejects.toThrow(/permission denied/);
      } finally {
        await db.client.query("rollback");
      }
    } finally {
      await db.client.query("delete from solutions where id = $1", [id]);
      await db.client.query("delete from issues where id = $1", [linked]);
    }
  });

  it("checks the name and the shape of the stored copy", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await fails(c, () => solution(c, ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, "  "), /solutions_name_check|violates check/);
      await fails(c, () => c.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'x', '[]')", [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID]), /violates check/);
      await fails(c, () => c.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'x', '{\"steps\": {}, \"edges\": []}')", [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID]), /violates check/);
      const id = (await solution(c)).rows[0].id;
      await link(c, id, openIssue);
      await fails(c, () => c.query("update solution_issues set user_verdict = 'maybe' where solution_id = $1", [id]), /violates check/);
      await fails(c, () => c.query("insert into solution_issues (solution_id, issue_id, workspace_id, holds_pct) values ($1, $2, $3, 101)", [id, openIssue, ws]), /violates check/);
    });
  });
});

describe("solutions: links never cross workspaces", () => {
  it("refuses a solution on another workspace's process or revision", async () => {
    await failsAtRoot(() => solution(db.client, ws, otherProcess, otherRevision), /foreign key|published version/);
    await failsAtRoot(() => solution(db.client, otherWs, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID), /foreign key|published version/);
    // A revision of the right workspace but another process.
    await failsAtRoot(() => solution(db.client, ws, NORTHBEAM_PROCESS_ID, otherRevision), /foreign key|published version/);
  });

  it("refuses to link a solution to an issue of another workspace, whichever workspace the link claims", async () => {
    const id = (await solution(db.client)).rows[0].id;
    try {
      await failsAtRoot(() => link(db.client, id, otherIssue, ws), /foreign key/);
      await failsAtRoot(() => link(db.client, id, otherIssue, otherWs), /foreign key/);
      await failsAtRoot(() => link(db.client, id, openIssue, otherWs), /foreign key/);
      await db.as(users.owner!.claims, async (c) => {
        await fails(c, () => link(c, id, otherIssue, ws), /foreign key|row-level security/);
        await fails(c, () => save(c, [{ issue_id: otherIssue, auto_verdict: "pass", holds_pct: 90 }]), /foreign key/);
      });
      expect((await db.client.query("select 1 from solution_issues where solution_id = $1", [id])).rowCount).toBe(0);
    } finally {
      await db.client.query("delete from solutions where id = $1", [id]);
    }
  });

  it("does not let a solution of one workspace be read from another", async () => {
    const other = (await solution(db.client, otherWs, otherProcess, otherRevision, "Theirs")).rows[0].id;
    try {
      const names = await db.as(users.viewer!.claims, async (c) => (await c.query("select name from solutions")).rows.map((r) => r.name));
      expect(names).not.toContain("Theirs");
    } finally {
      await db.client.query("delete from solutions where id = $1", [other]);
    }
  });

  it("takes its links with it when the solution, the issue or the process is deleted", async () => {
    const a = (await solution(db.client)).rows[0].id;
    const linked = await newIssue();
    await link(db.client, a, linked);
    await db.client.query("delete from solutions where id = $1", [a]);
    await db.client.query("delete from issues where id = $1", [linked]);
    expect((await db.client.query("select 1 from solution_issues where solution_id = $1", [a])).rowCount).toBe(0);
    const o = (await solution(db.client, otherWs, otherProcess, otherRevision, "Theirs")).rows[0].id;
    await link(db.client, o, otherIssue, otherWs);
    await db.client.query("delete from issues where id = $1", [otherIssue]);
    expect((await db.client.query("select 1 from solution_issues where solution_id = $1", [o])).rowCount).toBe(0);
    await db.client.query("delete from processes where id = $1", [otherProcess]);
    expect((await db.client.query("select 1 from solutions where id = $1", [o])).rowCount).toBe(0);
  });
});

describe("linking a solution to an issue", () => {
  it("moves an Open issue to Testing solutions and logs one solution_tested event, through A47's mechanism", async () => {
    await db.as(users.editor!.claims, async (c) => {
      expect(await issueStatus(c, openIssue)).toBe("open");
      const before = (await events(c, openIssue)).length;
      const s = await save(c, [{ issue_id: openIssue, auto_verdict: "pass", holds_pct: 95, auto_note: "Wait at Check fit: 3.1 h against under 4 hours" }]);
      expect(await issueStatus(c, openIssue)).toBe("in_progress");
      const log = await events(c, openIssue);
      expect(log).toHaveLength(before + 1);
      const last = log[log.length - 1]!;
      expect(last.kind).toBe("solution_tested");
      expect(last.actor).toBe(users.editor!.id);
      expect(last.detail).toMatchObject({ from: "open", to: "testing", solution_id: s.id, solution: "Fast track", auto_verdict: "pass", holds_pct: 95 });
      const row = (await c.query("select auto_verdict, holds_pct, auto_note, user_verdict, user_notes from solution_issues where solution_id = $1", [s.id])).rows[0];
      expect(row).toEqual({ auto_verdict: "pass", holds_pct: 95, auto_note: "Wait at Check fit: 3.1 h against under 4 hours", user_verdict: null, user_notes: "" });
    });
  });

  it("logs a solution_tested event for a second solution on an issue already being tested, and keeps its status", async () => {
    await db.as(users.editor!.claims, async (c) => {
      expect(await issueStatus(c, testingIssue)).toBe("in_progress");
      const before = (await events(c, testingIssue)).length;
      const a = await save(c, [{ issue_id: testingIssue, auto_verdict: "fail", holds_pct: 20 }], "First");
      const b = await save(c, [{ issue_id: testingIssue, auto_verdict: "pass", holds_pct: 88 }], "Second");
      expect(await issueStatus(c, testingIssue)).toBe("in_progress");
      const added = (await events(c, testingIssue)).slice(before);
      expect(added.map((e) => e.kind)).toEqual(["solution_tested", "solution_tested"]);
      expect(added.map((e) => e.detail.solution_id)).toEqual([a.id, b.id]);
    });
  });

  it("links a solution to several issues, each with its own verdict, and logs each issue", async () => {
    await db.as(users.owner!.claims, async (c) => {
      const s = await save(c, [
        { issue_id: openIssue, auto_verdict: "pass", holds_pct: 91 },
        { issue_id: testingIssue, auto_verdict: "fail", holds_pct: 12 },
      ]);
      const rows = (await c.query("select issue_id, auto_verdict, holds_pct from solution_issues where solution_id = $1 order by holds_pct", [s.id])).rows;
      expect(rows).toEqual([
        { issue_id: testingIssue, auto_verdict: "fail", holds_pct: 12 },
        { issue_id: openIssue, auto_verdict: "pass", holds_pct: 91 },
      ]);
      expect((await events(c, openIssue)).pop()!.kind).toBe("solution_tested");
      expect((await events(c, testingIssue)).pop()!.kind).toBe("solution_tested");
    });
  });

  it("refuses an issue that is resolved, won't fix or dismissed, with a clear message", async () => {
    for (const [status, resolution] of [["done", null], ["done", "wont_fix"], ["dismissed", null]]) {
      const closed = await newIssue();
      await db.client.query("update issues set status = $2, resolution = $3 where id = $1", [closed, status, resolution]);
      await db.as(users.editor!.claims, async (c) => {
        await fails(c, () => save(c, [{ issue_id: closed, auto_verdict: "pass", holds_pct: 70 }]), /issue is closed/);
      });
      await db.client.query("delete from issues where id = $1", [closed]);
    }
  });

  it("lets an editor record their own verdict and notes, and change the link's verdicts", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const s = await save(c, [{ issue_id: openIssue, auto_verdict: "fail", holds_pct: 30 }]);
      const r = await c.query("update solution_issues set user_verdict = 'pass', user_notes = 'Good enough for now' where solution_id = $1 and issue_id = $2", [s.id, openIssue]);
      expect(r.rowCount).toBe(1);
      expect((await c.query("select user_verdict, user_notes, auto_verdict from solution_issues where solution_id = $1", [s.id])).rows[0]).toEqual({
        user_verdict: "pass",
        user_notes: "Good enough for now",
        auto_verdict: "fail",
      });
    });
  });

  it("allows a link with no automatic verdict, for a target the simulation can't check", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const s = await save(c, [{ issue_id: openIssue, auto_verdict: null, holds_pct: null, auto_note: "Not checked by simulation" }]);
      expect((await c.query("select auto_verdict, holds_pct from solution_issues where solution_id = $1", [s.id])).rows[0]).toEqual({ auto_verdict: null, holds_pct: null });
    });
  });

  it("saves a solution with no issue, to be linked later, and links it afterwards", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const s = await save(c, []);
      expect((await c.query("select 1 from solution_issues where solution_id = $1", [s.id])).rowCount).toBe(0);
      expect(await issueStatus(c, openIssue)).toBe("open");
      await link(c, s.id, openIssue);
      expect(await issueStatus(c, openIssue)).toBe("in_progress");
    });
  });
});

describe("saving a solution never changes live or the draft (D18)", () => {
  const snapshot = async (c: pg.Client) => ({
    revisions: (await c.query("select id, number, status, published_at from process_revisions where process_id = $1 order by id", [NORTHBEAM_PROCESS_ID])).rows,
    process: (await c.query("select live_revision_id, updated_at from processes where id = $1", [NORTHBEAM_PROCESS_ID])).rows[0],
    steps: (await c.query("select md5(string_agg(to_jsonb(s)::text, '' order by id)) as m from steps s where process_id = $1", [NORTHBEAM_PROCESS_ID])).rows[0].m,
    edges: (await c.query("select md5(string_agg(to_jsonb(e)::text, '' order by id)) as m from edges e where process_id = $1", [NORTHBEAM_PROCESS_ID])).rows[0].m,
  });

  it("leaves the process, its revisions, steps and edges exactly as they were, with and without a draft", async () => {
    for (const withDraft of [false, true]) {
      await db.as(users.editor!.claims, async (c) => {
        if (withDraft) await c.query("select public.open_draft($1)", [NORTHBEAM_PROCESS_ID]);
        const before = await snapshot(c);
        const drafts = (await c.query("select count(*)::int as n from process_revisions where process_id = $1 and status = 'draft'", [NORTHBEAM_PROCESS_ID])).rows[0].n;
        await save(c, [{ issue_id: openIssue, auto_verdict: "pass", holds_pct: 95 }]);
        await save(c, []);
        expect(await snapshot(c), `withDraft ${withDraft}`).toEqual(before);
        expect((await c.query("select count(*)::int as n from process_revisions where process_id = $1 and status = 'draft'", [NORTHBEAM_PROCESS_ID])).rows[0].n).toBe(drafts);
        // A process has at most one draft, however many solutions it has.
        expect(drafts).toBe(withDraft ? 1 : 0);
      });
    }
  });
});

describe("what may be linked and what may be changed", () => {
  it("refuses a solution based on a draft, and discard_draft still works (D18)", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await c.query("select public.open_draft($1)", [NORTHBEAM_PROCESS_ID]);
      const draft = (await c.query("select id from process_revisions where process_id = $1 and status = 'draft'", [NORTHBEAM_PROCESS_ID])).rows[0].id;
      await fails(c, () => c.query("select public.save_solution($1, $2, $3, 'On a draft', $4::jsonb)", [ws, NORTHBEAM_PROCESS_ID, draft, bundle]), /published version/);
      // The table refuses it too, for any writer.
      await fails(c, () => solution(c, ws, NORTHBEAM_PROCESS_ID, draft), /published version/);
      await save(c);
      await c.query("select public.discard_draft($1)", [NORTHBEAM_PROCESS_ID]);
      expect((await c.query("select count(*)::int as n from process_revisions where process_id = $1 and status = 'draft'", [NORTHBEAM_PROCESS_ID])).rows[0].n).toBe(0);
    });
    await failsAtRoot(() => solution(db.client, ws, NORTHBEAM_PROCESS_ID, otherRevision), /foreign key|published version/);
  });

  it("refuses an issue about another process or a detection, with plain messages", async () => {
    const elsewhere = await newIssue(ws, null);
    const detected = (await db.client.query("insert into issues (workspace_id, process_id, title, type, severity, source, detected_key) values ($1, $2, 'Seen', 'delay', 'warning', 'detected', 'delay:p:step1') returning id", [ws, NORTHBEAM_PROCESS_ID])).rows[0].id as string;
    await db.as(users.editor!.claims, async (c) => {
      await fails(c, () => save(c, [{ issue_id: detected, auto_verdict: "pass", holds_pct: 90 }]), /only a detection/);
      await fails(c, () => save(c, [{ issue_id: elsewhere, auto_verdict: "pass", holds_pct: 90 }]), /about another process/);
    });
    // Linked to the process through an issue link, it is accepted.
    await db.client.query("insert into issue_links (issue_id, workspace_id, process_id) values ($1, $2, $3)", [elsewhere, ws, NORTHBEAM_PROCESS_ID]);
    await db.as(users.editor!.claims, async (c) => {
      await save(c, [{ issue_id: elsewhere, auto_verdict: "pass", holds_pct: 90 }]);
    });
    await db.client.query("delete from issues where id = any($1)", [[elsewhere, detected]]);
  });

  it("denies changing which issue, the verdicts, the copy or the base revision after saving", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const s = await save(c, [{ issue_id: openIssue, auto_verdict: "fail", holds_pct: 30 }]);
      for (const col of ["issue_id = $2", "auto_verdict = 'pass'", "holds_pct = 99", "auto_note = 'x'", "solution_id = $2", "workspace_id = $2"]) {
        await fails(c, () => c.query(`update solution_issues set ${col.replace("$2", `'${testingIssue}'`)} where solution_id = $1`, [s.id]), /permission denied/);
      }
      for (const col of ["steps = '{\"steps\": [], \"edges\": []}'", `base_revision_id = '${NORTHBEAM_REVISION_ID}'`, "process_id = $2", "changed_step_ids = '[]'", "lever_changes = '[]'", "workspace_id = $2"]) {
        await fails(c, () => c.query(`update solutions set ${col.replace("$2", `'${NORTHBEAM_PROCESS_ID}'`)} where id = $1`, [s.id]), /permission denied/);
      }
      expect((await c.query("update solution_issues set user_verdict = 'pass', user_notes = 'ok' where solution_id = $1", [s.id])).rowCount).toBe(1);
      expect((await c.query("update solutions set name = 'Renamed', notes = 'n' where id = $1", [s.id])).rowCount).toBe(1);
    });
  });
});
describe("the checks are for people who can edit, and a base may be a superseded version", () => {
  it("gives someone outside the workspace, or a viewer, a plain permission error and nothing about the issue or revision", async () => {
    const id = (await solution(db.client)).rows[0].id;
    const closed = await newIssue();
    await db.client.query("update issues set status = 'done' where id = $1", [closed]);
    try {
      for (const role of ["stranger", "viewer", "member"]) {
        await db.as(users[role]!.claims, async (c) => {
          await fails(c, () => solution(c), /cannot edit this workspace/);
          await fails(c, () => link(c, id, closed), /cannot edit this workspace/);
          await fails(c, () => save(c, [{ issue_id: closed, auto_verdict: "pass", holds_pct: 90 }]), /cannot edit this workspace/);
          await fails(c, () => solution(c, ws, NORTHBEAM_PROCESS_ID, "00000000-0000-4000-8000-0000000000ff"), /cannot edit this workspace/);
        });
      }
    } finally {
      await db.client.query("delete from solutions where id = $1", [id]);
      await db.client.query("delete from issues where id = $1", [closed]);
    }
  });

  it("allows a base that has been superseded, so publishing mid-edit doesn't lose the save, but never a draft", async () => {
    await db.as(users.editor!.claims, async (c) => {
      // Someone publishes a new version while the solution is being built: the revision it started from is now superseded.
      await c.query("select public.open_draft($1)", [NORTHBEAM_PROCESS_ID]);
      await c.query("update steps set notes = 'changed' where process_id = $1 and revision_id <> $2 and name = 'Audit & proposal'", [NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID]);
      await c.query("select public.publish_process($1, true)", [NORTHBEAM_PROCESS_ID]);
      expect((await c.query("select status from process_revisions where id = $1", [NORTHBEAM_REVISION_ID])).rows[0].status).toBe("superseded");
      const s = await save(c, [{ issue_id: openIssue, auto_verdict: "pass", holds_pct: 90 }]);
      expect((await c.query("select base_revision_id from solutions where id = $1", [s.id])).rows[0].base_revision_id).toBe(NORTHBEAM_REVISION_ID);
      // A draft is still refused.
      await c.query("select public.open_draft($1)", [NORTHBEAM_PROCESS_ID]);
      const draft = (await c.query("select id from process_revisions where process_id = $1 and status = 'draft'", [NORTHBEAM_PROCESS_ID])).rows[0].id;
      await fails(c, () => solution(c, ws, NORTHBEAM_PROCESS_ID, draft), /published version/);
    });
  });
});

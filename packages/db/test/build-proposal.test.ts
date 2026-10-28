import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Building a solution idea (issue #117, A52 slice 2): `build_proposal` saves the solution through `save_solution` and marks the
// idea `built` in the same transaction. The decision is made only by that function (the guard trigger is unchanged), only a
// pending solution idea can be built, once, by someone who can edit, never over the API.

const ws = NORTHBEAM_WORKSPACE_ID;
const [openIssue, otherIssue] = northbeamIssues().map((i) => i.id) as [string, string];
let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const mcp = () => ({ ...users.editor!.claims, api_token_id: randomUUID() });
const bundle = JSON.stringify({ steps: [], edges: [], entry_step_id: null });
const idea = JSON.stringify({ steps: [{ key: "s1", name: "Fast-track" }], edges: [] });

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@build-proposal.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@build-proposal.example.com");
});

afterAll(async () => {
  await db?.close();
});

const makeIdea = async (kind: "solution_idea" | "issue" = "solution_idea", issue = openIssue) =>
  (
    await db.client.query("insert into suggestion_proposals (workspace_id, kind, title, payload, issue_id) values ($1, $2, 'Fast-track partner leads', $3, $4) returning id", [
      ws,
      kind,
      kind === "solution_idea" ? idea : "{}",
      kind === "solution_idea" ? issue : null,
    ])
  ).rows[0].id as string;

const build = async (c: pg.Client, proposal: string, links: unknown[] = [{ issue_id: openIssue, auto_verdict: null, holds_pct: null, auto_note: "" }], name = "From an idea", process = NORTHBEAM_PROCESS_ID, revision = NORTHBEAM_REVISION_ID) =>
  (
    await c.query("select public.build_proposal($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb) as r", [
      proposal,
      ws,
      process,
      revision,
      name,
      bundle,
      "[]",
      "[]",
      JSON.stringify(links),
    ])
  ).rows[0].r as { id: string; name: string };

const fails = async (c: pg.Client, run: () => Promise<unknown>, pattern: RegExp) => {
  await c.query("savepoint s");
  try {
    await expect(run()).rejects.toThrow(pattern);
  } finally {
    await c.query("rollback to savepoint s");
  }
};

describe("build_proposal", () => {
  it("saves the solution, links the issue and marks the idea built, with the solution it made", async () => {
    const id = await makeIdea();
    await db.as(users.editor!.claims, async (c) => {
      const s = await build(c, id);
      expect(s.name).toBe("From an idea");
      expect((await c.query("select count(*)::int as n from solution_issues where solution_id = $1 and issue_id = $2", [s.id, openIssue])).rows[0].n).toBe(1);
      expect((await c.query("select status from issues where id = $1", [openIssue])).rows[0].status).toBe("in_progress");
      expect((await c.query("select status, applied, reviewed_by, reviewed_at is not null as reviewed from suggestion_proposals where id = $1", [id])).rows[0]).toEqual({
        status: "built",
        applied: { solution_id: s.id },
        reviewed_by: users.editor!.id,
        reviewed: true,
      });
    });
  });

  it("builds an idea once", async () => {
    const id = await makeIdea();
    await db.as(users.owner!.claims, async (c) => {
      await build(c, id);
      const before = (await c.query("select count(*)::int as n from solutions")).rows[0].n;
      await fails(c, () => build(c, id), /already been dealt with/);
      expect((await c.query("select count(*)::int as n from solutions")).rows[0].n).toBe(before);
    });
  });

  it("leaves an idea that was dismissed alone: nothing is saved", async () => {
    const id = await makeIdea();
    await db.as(users.editor!.claims, async (c) => {
      await c.query("select public.review_proposals(array[$1::uuid], 'reject')", [id]);
      const before = (await c.query("select count(*)::int as n from solutions")).rows[0].n;
      await fails(c, () => build(c, id), /already been dealt with/);
      expect((await c.query("select count(*)::int as n from solutions")).rows[0].n).toBe(before);
    });
  });

  it("only builds a solution idea", async () => {
    const id = await makeIdea("issue");
    await db.as(users.editor!.claims, (c) => fails(c, () => build(c, id), /only a solution idea can be built/));
  });

  it("rolls the whole thing back when the solution can't be saved: the idea stays pending", async () => {
    const id = await makeIdea();
    await db.as(users.editor!.claims, async (c) => {
      // An issue that doesn't exist can't be linked.
      await fails(c, () => build(c, id, [{ issue_id: randomUUID(), auto_verdict: null, holds_pct: null, auto_note: "" }]), /.+/);
      expect((await c.query("select status, applied from suggestion_proposals where id = $1", [id])).rows[0]).toEqual({ status: "pending", applied: null });
      expect((await c.query("select count(*)::int as n from solutions where name = 'From an idea'")).rows[0].n).toBe(0);
    });
  });

  it("only builds a solution that is linked to the idea's own issue", async () => {
    const id = await makeIdea();
    const link = (issue: string) => ({ issue_id: issue, auto_verdict: null, holds_pct: null, auto_note: "" });
    await db.as(users.editor!.claims, async (c) => {
      const solutions = (await c.query("select count(*)::int as n from solutions")).rows[0].n;
      // Another issue, no links, and links that aren't a list: none of them is the idea's issue.
      await fails(c, () => build(c, id, [link(otherIssue)]), /linked to the idea's issue/);
      await fails(c, () => build(c, id, []), /linked to the idea's issue/);
      await fails(c, () => c.query("select public.build_proposal($1, $2, $3, $4, 'X', $5::jsonb, '[]', '[]', '{}')", [id, ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, bundle]), /linked to the idea's issue/);
      expect((await c.query("select count(*)::int as n from solutions")).rows[0].n).toBe(solutions);
      expect((await c.query("select status from suggestion_proposals where id = $1", [id])).rows[0].status).toBe("pending");
      // Linked to the idea's issue as well as another one, it is the idea's solution.
      const s = await build(c, id, [link(otherIssue), link(openIssue)]);
      expect((await c.query("select applied from suggestion_proposals where id = $1", [id])).rows[0].applied).toEqual({ solution_id: s.id });
    });
  });

  it("can't build on a different process than the idea's issue is about: the solution isn't saved and the idea stays pending", async () => {
    const id = await makeIdea();
    const proc = randomUUID();
    const rev = randomUUID();
    await db.client.query("insert into processes (id, workspace_id, name) values ($1, $2, 'Another process')", [proc, ws]);
    await db.client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 1, 'draft')", [rev, ws, proc]);
    await db.client.query("update process_revisions set status = 'published' where id = $1", [rev]);
    await db.client.query("update processes set live_revision_id = $1 where id = $2", [rev, proc]);
    await db.as(users.editor!.claims, async (c) => {
      await fails(c, () => build(c, id, undefined, "Elsewhere", proc, rev), /another process/);
      expect((await c.query("select count(*)::int as n from solutions where name = 'Elsewhere'")).rows[0].n).toBe(0);
      expect((await c.query("select status, applied from suggestion_proposals where id = $1", [id])).rows[0]).toEqual({ status: "pending", applied: null });
    });
  });

  it("is for people who can edit: a viewer or a stranger finds no such idea; the API can't build", async () => {
    const id = await makeIdea();
    for (const role of ["viewer", "stranger"]) {
      await db.as(users[role]!.claims, (c) => fails(c, () => build(c, id), /no such idea/));
    }
    await db.as(mcp(), (c) => fails(c, () => build(c, id), /by a person in the app/));
    expect((await db.client.query("select status from suggestion_proposals where id = $1", [id])).rows[0].status).toBe("pending");
  });

  it("an idea from another workspace is not found", async () => {
    const id = await makeIdea();
    const other = (await db.client.query("insert into workspaces (name, slug) values ('Elsewhere', 'elsewhere-build') returning id")).rows[0].id;
    await db.as(users.editor!.claims, (c) =>
      fails(c, () => c.query("select public.build_proposal($1, $2, $3, $4, 'X', $5::jsonb, '[]', '[]', '[]')", [id, other, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, bundle]), /no such idea/),
    );
  });

  it("the decision still can't be made any other way", async () => {
    const id = await makeIdea();
    await db.as(users.editor!.claims, async (c) => {
      await fails(c, () => c.query("update suggestion_proposals set status = 'built', reviewed_at = now() where id = $1", [id]), /review_proposals/);
      await fails(c, () => c.query("update suggestion_proposals set applied = '{\"solution_id\": \"x\"}' where id = $1", [id]), /review_proposals/);
    });
  });

  it("is not executable by anon", async () => {
    const id = await makeIdea();
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(build(db.client, id)).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});

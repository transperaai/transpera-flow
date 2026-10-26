import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// A50 slice 1 (issue #115): resolving an issue with the solution that fixed it, and your verdict and notes on a solution
// logged on the issue's history. Members read, editors write.

const ws = NORTHBEAM_WORKSPACE_ID;
const [issueA, issueB, issueC] = northbeamIssues().map((i) => i.id) as [string, string, string];
let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const bundle = JSON.stringify({ steps: [], edges: [], entry_step_id: null });

type Client = pg.Client;
const save = async (c: Client, links: string[], name = "Lead scoring") =>
  (
    await c.query("select public.save_solution($1, $2, $3, $4, $5::jsonb, '[]', '[]', $6::jsonb) as r", [
      ws,
      NORTHBEAM_PROCESS_ID,
      NORTHBEAM_REVISION_ID,
      name,
      bundle,
      JSON.stringify(links.map((issue_id) => ({ issue_id, auto_verdict: "pass", holds_pct: 90, auto_note: "ok" }))),
    ])
  ).rows[0].r as { id: string };
const resolve5 = async (c: Client, id: string, how: string, note: string | null = null) =>
  (await c.query("select public.resolve_issue($1, $2, $3, $4, 'resolved') as r", [ws, id, how, note])).rows[0].r as Record<string, unknown>;
const resolve6 = async (c: Client, id: string, how: string, solution: string | null, note: string | null = null) =>
  (await c.query("select public.resolve_issue($1, $2, $3, $4, 'resolved', $5) as r", [ws, id, how, note, solution])).rows[0].r as Record<string, unknown>;
const reopen = (c: Client, id: string) => c.query("select public.save_issue($1, $2, $3)", [ws, JSON.stringify({ status: "open" }), id]);
const events = async (c: Client, id: string) => (await c.query("select kind, actor, detail from issue_events where issue_id = $1 order by seq", [id])).rows;
const fails = async (c: Client, run: () => Promise<unknown>, pattern: RegExp) => {
  await c.query("savepoint s");
  try {
    await expect(run()).rejects.toThrow(pattern);
  } finally {
    await c.query("rollback to savepoint s");
  }
};

let foreignSolution = "";

beforeAll(async () => {
  db = await createTestDb();
  // A solution of another workspace, which no issue of Northbeam can name.
  const other = (await db.client.query("insert into workspaces (name, slug) values ('Elsewhere', 'elsewhere-rs') returning id")).rows[0].id as string;
  const process = randomUUID();
  const revision = randomUUID();
  await db.client.query("insert into processes (id, workspace_id, name) values ($1, $2, 'Theirs')", [process, other]);
  await db.client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 1, 'draft')", [revision, other, process]);
  await db.client.query("update process_revisions set status = 'published' where id = $1", [revision]);
  foreignSolution = (await db.client.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'Theirs', $4::jsonb) returning id", [other, process, revision, bundle])).rows[0].id;
  users.stranger = await createUser(db, "stranger@resolution-solution.example");
  for (const role of ["editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@resolution-solution.example`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
});
afterAll(async () => {
  await db?.close();
});

describe("resolve_issue with a solution", () => {
  it("stores the pick, shows it on the issue and names it in the resolved history entry", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const sol = await save(c, [issueA]);
      const r = await resolve6(c, issueA, "solution", sol.id, "Built into Sales v8");
      expect(r).toMatchObject({ status: "done", resolved_how: "solution", resolved_solution_id: sol.id, resolution_note: "Built into Sales v8" });
      const log = await events(c, issueA);
      expect(log.at(-1)).toMatchObject({ kind: "resolved", detail: { to: "resolved", how: "solution", solution_id: sol.id, solution: "Lead scoring", note: "Built into Sales v8" } });
      expect(log.filter((e) => e.kind === "resolved")).toHaveLength(1);
    });
  });

  it("reopening clears the pick; the history keeps the solution's name", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const sol = await save(c, [issueB], "Fast track");
      await resolve6(c, issueB, "solution", sol.id);
      await reopen(c, issueB);
      expect((await c.query("select resolved_how, resolved_solution_id from issues where id = $1", [issueB])).rows[0]).toEqual({ resolved_how: null, resolved_solution_id: null });
      expect((await events(c, issueB)).find((e) => e.kind === "resolved")!.detail).toMatchObject({ solution: "Fast track" });
    });
  });

  it("refuses a solution that is not linked to the issue, one named with another way, and one from another workspace", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const linkedToA = await save(c, [issueA], "Only A");
      await fails(c, () => resolve6(c, issueC, "solution", linkedToA.id), /not linked to this issue/);
      await fails(c, () => resolve6(c, issueA, "process_change", linkedToA.id), /only be named when a solution fixed it/);
      await fails(c, () => resolve6(c, issueC, "solution", randomUUID()), /not linked to this issue/);
      await fails(c, () => resolve6(c, issueC, "solution", foreignSolution), /not linked to this issue/);
      expect((await c.query("select status, resolved_solution_id from issues where id = $1", [issueC])).rows[0]).toEqual({ status: "open", resolved_solution_id: null });
    });
  });

  it("holds for every writer: a direct update names only a linked solution, and only with 'solution'", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const linked = await save(c, [issueC], "Linked to C");
      const unlinked = await save(c, [issueA], "Linked to A");
      await fails(c, () => c.query("update issues set status = 'done', resolved_how = 'solution', resolved_solution_id = $2 where id = $1", [issueC, unlinked.id]), /not linked to this issue/);
      // Another way, or still open: the pick is cleared rather than kept.
      await c.query("update issues set status = 'done', resolved_how = 'process_change', resolved_solution_id = $2 where id = $1", [issueC, linked.id]);
      expect((await c.query("select resolved_solution_id from issues where id = $1", [issueC])).rows[0].resolved_solution_id).toBeNull();
      await c.query("update issues set status = 'open' where id = $1", [issueC]);
    });
  });

  it("deleting the solution clears the pick but not the way, and the history keeps the name", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const sol = await save(c, [issueC], "Short lived");
      await resolve6(c, issueC, "solution", sol.id);
      await c.query("delete from solutions where id = $1", [sol.id]);
      expect((await c.query("select status, resolved_how, resolved_solution_id from issues where id = $1", [issueC])).rows[0]).toEqual({
        status: "done",
        resolved_how: "solution",
        resolved_solution_id: null,
      });
      expect((await events(c, issueC)).find((e) => e.kind === "resolved")!.detail).toMatchObject({ solution: "Short lived" });
      await reopen(c, issueC);
    });
  });

  it("keeps the five-argument function working for the app deployed before this migration", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await resolve5(c, issueC, "solution", "Old app");
      expect(r).toMatchObject({ status: "done", resolved_how: "solution", resolved_solution_id: null });
      expect((await events(c, issueC)).at(-1)!.detail).toEqual({ from: "open", to: "resolved", how: "solution", note: "Old app" });
      await reopen(c, issueC);
    });
  });

  it("refuses a viewer", async () => {
    await db.as(users.viewer!.claims, async (c) => {
      await expect(resolve6(c, issueA, "solution", null)).rejects.toThrow(/cannot change issues/);
    });
  });

  it("refuses won't fix with a named solution", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const sol = await save(c, [issueA], "Wont fix");
      await fails(c, () => c.query("select public.resolve_issue($1, $2, 'solution', null, 'wont_fix', $3)", [ws, issueA, sol.id]), /won't fix wasn't fixed by a solution/);
    });
  });

  it("refuses changing the pick once resolved, but lets reopening clear it and keeps it when the link is removed", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const first = await save(c, [issueA], "First");
      const second = await save(c, [issueA], "Second");
      await resolve6(c, issueA, "solution", first.id);
      await fails(c, () => c.query("update issues set resolved_solution_id = $2 where id = $1", [issueA, second.id]), /can't be changed/);
      expect((await c.query("select resolved_solution_id from issues where id = $1", [issueA])).rows[0].resolved_solution_id).toBe(first.id);
      // Unlinking afterwards keeps the pick.
      await c.query("delete from solution_issues where solution_id = $1 and issue_id = $2", [first.id, issueA]);
      expect((await c.query("select resolved_solution_id from issues where id = $1", [issueA])).rows[0].resolved_solution_id).toBe(first.id);
      // Reopen, then a new pick is allowed.
      await reopen(c, issueA);
      await resolve6(c, issueA, "solution", second.id);
      expect((await c.query("select resolved_solution_id from issues where id = $1", [issueA])).rows[0].resolved_solution_id).toBe(second.id);
    });
  });

  it("tells a stranger nothing about another workspace's links: only the row-level security error", async () => {
    // A linked pair that exists for real (made outside the per-test transaction).
    const sol = (await db.client.query("insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'Linked', $4::jsonb) returning id", [ws, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, bundle])).rows[0].id as string;
    await db.client.query("insert into solution_issues (solution_id, issue_id, workspace_id) values ($1, $2, $3)", [sol, issueB, ws]);
    const insert = "insert into issues (workspace_id, title, type, severity, source, status, resolved_how, resolved_solution_id) values ($1, 'x', 'delay', 'warning', 'manual', 'done', 'solution', $2)";
    try {
      await db.as(users.stranger!.claims, async (c) => {
        // The before-write trigger runs ahead of row-level security, so it must not answer first, whether or not the pair exists.
        await fails(c, () => c.query(insert, [ws, sol]), /row-level security/);
        await fails(c, () => c.query(insert, [ws, randomUUID()]), /row-level security/);
        // Update: the stranger can't see the row, so nothing changes and nothing is said.
        expect((await c.query("update issues set status = 'done', resolved_how = 'solution', resolved_solution_id = $2 where id = $1", [issueB, sol])).rowCount).toBe(0);
      });
      // A token with role authenticated but no user (`auth.uid()` null) is held to the same: the trigger doesn't answer for it either.
      await db.as({ role: "authenticated" }, async (c) => {
        await fails(c, () => c.query(insert, [ws, sol]), /row-level security/);
        await fails(c, () => c.query(insert, [ws, randomUUID()]), /row-level security/);
      });
    } finally {
      await db.client.query("delete from solutions where id = $1", [sol]);
    }
  });
});

describe("privileges, as a Supabase project grants them", () => {
  it("only authenticated may run either resolve_issue, and anon and public may not", async () => {
    const supa = await createTestDb({ supabaseDefaultPrivileges: true });
    try {
      const rows = (
        await supa.client.query(
          "select p.pronargs, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authed from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'resolve_issue' order by 1",
        )
      ).rows;
      expect(rows).toEqual([
        { pronargs: 5, anon: false, authed: true },
        { pronargs: 6, anon: false, authed: true },
      ]);
      const trig = (await supa.client.query("select has_function_privilege('authenticated', 'private.solution_verdict_logged()', 'execute') as a, has_function_privilege('anon', 'private.issues_resolved_solution_before_write()', 'execute') as b")).rows[0];
      expect(trig).toEqual({ a: false, b: false });
    } finally {
      await supa.close();
    }
  }, 60000);
});

describe("your verdict and notes on a solution are logged on the issue", () => {
  it("logs a changed verdict once, with the solution and what it was, and not an unchanged one", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const sol = await save(c, [issueB], "Verdict me");
      const before = (await events(c, issueB)).length;
      await c.query("update solution_issues set user_verdict = 'pass' where solution_id = $1 and issue_id = $2", [sol.id, issueB]);
      await c.query("update solution_issues set user_verdict = 'pass' where solution_id = $1 and issue_id = $2", [sol.id, issueB]);
      await c.query("update solution_issues set user_verdict = 'fail', user_notes = 'Too slow in a downturn' where solution_id = $1 and issue_id = $2", [sol.id, issueB]);
      const added = (await events(c, issueB)).slice(before);
      expect(added).toHaveLength(2);
      expect(added[0]).toMatchObject({ kind: "edited", actor: users.editor!.id, detail: { solution_verdict: { solution_id: sol.id, solution: "Verdict me", verdict: "pass", was: null, notes_changed: false } } });
      expect(added[1]!.detail).toEqual({ solution_verdict: { solution_id: sol.id, solution: "Verdict me", verdict: "fail", was: "pass", notes_changed: true } });
      // The note's text is not copied into the history.
      expect(JSON.stringify(added)).not.toContain("downturn");
      await c.query("update solution_issues set user_verdict = null where solution_id = $1 and issue_id = $2", [sol.id, issueB]);
      expect((await events(c, issueB)).at(-1)!.detail).toMatchObject({ solution_verdict: { verdict: null, was: "fail" } });
    });
  });

  it("lets only owners and editors save a verdict: a member or viewer changes nothing and logs nothing", async () => {
    let solId = "";
    await db.as(users.editor!.claims, async (c) => {
      solId = (await save(c, [issueA], "Read only")).id;
    });
    for (const role of ["member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        const n = (await events(c, issueA)).length;
        expect((await c.query("update solution_issues set user_verdict = 'pass' where solution_id = $1", [solId])).rowCount, role).toBe(0);
        expect((await events(c, issueA)).length, role).toBe(n);
      });
    }
  });

  it("cannot change the automatic verdict or which issue (column grants)", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const sol = await save(c, [issueB], "Fixed fields");
      await fails(c, () => c.query("update solution_issues set auto_verdict = 'fail' where solution_id = $1", [sol.id]), /permission denied/);
    });
  });
});

describe("the migration's header", () => {
  it("rolls back as written, restoring A48's log function in full", async () => {
    const sql = readFileSync(new URL("../migrations/20261125000000_resolution_solution.sql", import.meta.url), "utf8");
    const header = sql.slice(sql.indexOf("-- Rollback"), sql.indexOf("\nalter table public.issues add column"));
    const steps = header
      .split("\n")
      .filter((l) => l.startsWith("--   ") || l === "--")
      .map((l) => l.slice(5))
      .join("\n");
    const body = steps.slice(steps.indexOf("begin;") + 6, steps.indexOf("commit;")).replace(/delete from supabase_migrations\.schema_migrations[^;]*;/, "");
    const a48 = readFileSync(new URL("../migrations/20261121500000_issue_resolution.sql", import.meta.url), "utf8");
    const fn = (s: string, at: number) => s.slice(at, s.indexOf("\n$$;", at) + 4);
    const restored = fn(body, body.indexOf("create or replace function private.log_issue_change()"));
    const original = fn(a48, a48.lastIndexOf("create or replace function private.log_issue_change()"));
    const plain = (t: string) => t.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
    expect(plain(restored)).toBe(plain(original));
    await db.client.query("begin");
    try {
      await db.client.query(body);
      expect((await db.client.query("select count(*)::int as n from information_schema.columns where table_name = 'issues' and column_name = 'resolved_solution_id'")).rows[0].n).toBe(0);
      expect((await db.client.query("select count(*)::int as n from pg_proc where proname = 'resolve_issue'")).rows[0].n).toBe(1);
      // Status changes still log, and resolving still works, as A48 left it.
      await db.client.query("update issues set status = 'done', resolved_how = 'solution' where id = $1", [issueA]);
      await db.client.query("update issues set status = 'open' where id = $1", [issueA]);
      const kinds = (await db.client.query("select kind from issue_events where issue_id = $1 and kind in ('resolved', 'reopened') order by seq desc limit 2", [issueA])).rows.map((r) => r.kind);
      expect(kinds).toEqual(["reopened", "resolved"]);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("the production apply file carries the migration byte for byte, inside a lock timeout", () => {
    const body = readFileSync(new URL("../migrations/20261125000000_resolution_solution.sql", import.meta.url), "utf8");
    const apply = readFileSync(new URL("../scripts/apply/20261125000000_resolution_solution.sql", import.meta.url), "utf8");
    expect(apply).toContain("begin;\nset local lock_timeout = '5s';\n\n" + body + "\ninsert into supabase_migrations.schema_migrations");
    expect(apply).toContain("array[$mig$" + body + "$mig$]);\n\ncommit;\n");
  });
});

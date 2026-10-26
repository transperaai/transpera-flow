import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues, northbeamStepIds as ids, type IssueRow } from "@transpera-flow/db";
import { solutionCopy } from "@/lib/solutions/bundle";
import { issueAboutProcess } from "@/lib/solutions/area";
import { linkProblem, verdictForCopy } from "@/lib/solutions/server-verdict";
import { demoBundle } from "@/lib/sources/demo";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { addMember, signInAs, signOut, type TestUser } from "./action-harness";

// The Server Actions that save a solution (issue #114): they write only the solution's own rows, as the signed-in user, and
// never the process's live version or its draft (D18). The automatic verdict is worked out on the server; what the browser sends is ignored.
// Run against a real database with the seeded Northbeam workspace. The verdict simulation (`serverVerdict`) is stubbed so each test
// chooses the verdict; it has its own tests below and in the lib.

const db = vi.hoisted(() => ({
  verdict: { ok: true, verdict: { status: "fail", holdsPct: 12, note: "Hands-on time: 9 h on average, against under 3 hours.", value: 9 } } as unknown,
  verdictCalls: [] as unknown[],
  failWith: null as { code: string; message?: string } | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/solutions/server-verdict", async (orig) => ({
  ...(await orig<typeof import("@/lib/solutions/server-verdict")>()),
  serverVerdict: async (args: unknown) => (db.verdictCalls.push({ ...(args as object) }), { ...(db.verdict as object), base: { b: 1 }, run: { r: 1 } }),
}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
// Only for database errors the real database can't be made to give (a foreign-key failure, an unknown error).
vi.mock("@transpera-flow/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@transpera-flow/db/client")>();
  return { ...actual, rpc: (...args: Parameters<typeof actual.rpc>) => (db.failWith ? Promise.reject(db.failWith) : actual.rpc(...args)) };
});
const { createSolution, linkSolutionToIssue } = await import("@/app/w/[slug]/solution-actions");

const WS = NORTHBEAM_WORKSPACE_ID;
const [ISSUE, OTHER_ISSUE] = northbeamIssues().map((i) => i.id) as [string, string, string];
let tdb: TestDb;
let editor: TestUser;
let viewer: TestUser;
const live = demoBundle();
const input = () => ({
  name: "AI lead qualifier",
  processId: live.process.id,
  baseRevisionId: live.revision.id,
  copy: solutionCopy({ steps: live.steps.map((s) => (s.id === ids.audit ? { ...s, work_hours: 3 } : s)), edges: live.edges }),
  changedStepIds: [ids.audit],
  levers: [],
  // What a browser might claim: ignored.
  links: [{ issueId: ISSUE, autoVerdict: "pass", holdsPct: 95, autoNote: "ok" }],
});

beforeAll(async () => {
  tdb = await createTestDb();
  editor = await addMember(tdb, WS, "editor");
  viewer = await addMember(tdb, WS, "viewer");
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await tdb.client.query("delete from solutions");
  db.verdictCalls = [];
  db.failWith = null;
  db.verdict = { ok: true, verdict: { status: "fail", holdsPct: 12, note: "Hands-on time: 9 h on average, against under 3 hours.", value: 9 } };
  signInAs({ tdb }, editor);
});

const solutions = async () => (await tdb.client.query("select id, name, steps, process_id from solutions order by created_at")).rows;
const links = async (solution?: string) =>
  (await tdb.client.query("select issue_id, auto_verdict, holds_pct, auto_note from solution_issues where ($1::uuid is null or solution_id = $1) order by issue_id", [solution ?? null])).rows;
/** What the process itself holds: its revisions and their rows. Saving a solution must leave all of it as it was. */
const processState = async () =>
  JSON.stringify(
    (
      await tdb.client.query(
        `select (select json_agg(r order by r.id) from process_revisions r where r.process_id = $1) as revisions,
                (select count(*) from steps where process_id = $1) as steps,
                (select count(*) from edges where process_id = $1) as edges,
                (select row_to_json(p) from processes p where p.id = $1) as process`,
        [NORTHBEAM_PROCESS_ID],
      )
    ).rows[0],
  );

/** An issue of the workspace as the owner connection writes it, for the cases a closed or foreign issue is needed. */
async function issue(over: Record<string, unknown> = {}) {
  const row = { workspace_id: WS, process_id: NORTHBEAM_PROCESS_ID, title: "Extra", type: "delay", severity: "warning", source: "manual", ...over };
  const cols = Object.keys(row);
  return (await tdb.client.query(`insert into issues (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row))).rows[0].id as string;
}

describe("createSolution", () => {
  it("saves through save_solution with the server's verdict, not the browser's", async () => {
    const before = await processState();
    const r = await createSolution(WS, input());
    expect(r.status).toBe("ok");
    expect(await links()).toEqual([{ issue_id: ISSUE, auto_verdict: "fail", holds_pct: 12, auto_note: "Hands-on time: 9 h on average, against under 3 hours." }]);
    expect(db.verdictCalls).toHaveLength(1);
    expect(db.verdictCalls[0]).toMatchObject({ workspaceId: WS, processId: live.process.id, baseRevisionId: live.revision.id, issueId: ISSUE });
    // Nothing of the process: not its revisions, steps, edges or draft.
    expect(await processState()).toBe(before);
    if (r.status === "ok") expect(r.links).toHaveLength(1);
  });

  it("simulates the copy once for all the issues it is linked to", async () => {
    await createSolution(WS, { ...input(), links: [{ issueId: ISSUE }, { issueId: OTHER_ISSUE }] });
    expect(db.verdictCalls).toHaveLength(2);
    expect(db.verdictCalls[0]).toMatchObject({ base: undefined, run: undefined });
    expect(db.verdictCalls[1]).toMatchObject({ base: { b: 1 }, run: { r: 1 } });
    expect(await links()).toHaveLength(2);
  });

  it("stores no verdict, with the reason, when the target can't be checked", async () => {
    db.verdict = { ok: true, verdict: { status: "unchecked", holdsPct: null, note: "Couldn't read the goal.", value: null } };
    await createSolution(WS, input());
    expect(await links()).toEqual([{ issue_id: ISSUE, auto_verdict: null, holds_pct: null, auto_note: "Couldn't read the goal." }]);
  });

  it("refuses, without saving, an issue that is closed, a detection or about another process", async () => {
    db.verdict = { ok: false, message: "That issue is already resolved or marked won't fix, so a solution can't be linked to it. Reopen it first." };
    expect(await createSolution(WS, input())).toEqual({ status: "error", message: "That issue is already resolved or marked won't fix, so a solution can't be linked to it. Reopen it first." });
    expect(await solutions()).toEqual([]);
  });

  it("stores the copy as sent, apart from the live steps", async () => {
    await createSolution(WS, input());
    const stored = (await solutions())[0].steps as { steps: { id: string; work_hours: number }[] };
    expect(stored.steps.find((s) => s.id === ids.audit)!.work_hours).toBe(3);
    expect(live.steps.find((s) => s.id === ids.audit)!.work_hours).toBe(9);
  });

  it("saves a solution with no issue, without simulating", async () => {
    expect((await createSolution(WS, { ...input(), links: [] })).status).toBe("ok");
    expect(await links()).toEqual([]);
    expect(await solutions()).toHaveLength(1);
    expect(db.verdictCalls).toEqual([]);
  });

  it("refuses without calling the database when signed out, or when the input is bad", async () => {
    signOut({ tdb });
    expect(await createSolution(WS, input())).toEqual({ status: "error", message: "Your session has ended. Sign in again." });
    signInAs({ tdb }, editor);
    expect(await createSolution(WS, { ...input(), name: " " })).toEqual({ status: "error", message: "Name the solution first." });
    expect(await createSolution("nope", input())).toEqual({ status: "error", message: "That solution isn't valid." });
    expect(await solutions()).toEqual([]);
  });

  it("says in plain English what the database refused, and calls it a permission problem only when it is one", async () => {
    const attempt = async (who: TestUser, over: Record<string, unknown> = {}) => {
      signInAs({ tdb }, who);
      return (await createSolution(WS, { ...input(), ...over })) as { message: string };
    };
    expect((await attempt(viewer)).message).toBe("You don't have permission to save solutions here.");
    // The triggers on a link refuse these (the verdict is stubbed to pass, so only the database stands in the way).
    const detected = await issue({ source: "detected", detected_key: "delay:p:step1" });
    expect((await attempt(editor, { links: [{ issueId: detected }] })).message).toMatch(/only a detection/);
    const elsewhere = (await tdb.client.query("insert into processes (workspace_id, name) values ($1, 'Elsewhere') returning id", [WS])).rows[0].id;
    const foreign = await issue({ process_id: elsewhere });
    expect((await attempt(editor, { links: [{ issueId: foreign }] })).message).toMatch(/another process/);
    const closed = await issue({ title: "Closed" });
    await tdb.client.query("update issues set status = 'dismissed' where id = $1", [closed]);
    expect((await attempt(editor, { links: [{ issueId: closed }] })).message).toMatch(/resolved, marked won't fix or dismissed/);
    expect((await attempt(editor, { baseRevisionId: "5f1c2b4a-0000-4000-8000-0000000000aa" })).message).toMatch(/published version/);
    expect(await solutions()).toEqual([]);
    // Errors the database can't be made to give from here.
    signInAs({ tdb }, editor);
    db.failWith = { code: "23503" };
    expect((await createSolution(WS, input())) as { message: string }).toMatchObject({ message: expect.stringMatching(/no longer there/) });
    db.failWith = { code: "XX000" };
    expect((await createSolution(WS, input())) as { message: string }).toMatchObject({ message: "Couldn't save the solution. Try again." });
  });
});

describe("linkSolutionToIssue", () => {
  let SOL: string;
  beforeEach(async () => {
    const made = await createSolution(WS, { ...input(), links: [] });
    if (made.status !== "ok") throw new Error("setup failed");
    SOL = made.solution.id;
    db.verdictCalls = [];
  });

  it("links a saved solution to an issue with the server's verdict, whatever the browser claims", async () => {
    const r = await linkSolutionToIssue(WS, SOL, ISSUE);
    expect(r.status).toBe("ok");
    expect(await links(SOL)).toEqual([{ issue_id: ISSUE, auto_verdict: "fail", holds_pct: 12, auto_note: "Hands-on time: 9 h on average, against under 3 hours." }]);
    if (r.status === "ok") expect(r.link).toMatchObject({ solution_id: SOL, issue_id: ISSUE, workspace_id: WS, auto_verdict: "fail", holds_pct: 12 });
    expect(db.verdictCalls[0]).toMatchObject({ processId: live.process.id, issueId: ISSUE });
  });

  it("refuses a closed issue, another process's issue or a missing solution, and a second link to the same issue", async () => {
    db.verdict = { ok: false, message: "That issue is about another process, so this solution can't be linked to it." };
    expect(await linkSolutionToIssue(WS, SOL, ISSUE)).toEqual({ status: "error", message: "That issue is about another process, so this solution can't be linked to it." });
    expect(await links(SOL)).toEqual([]);
    expect(await linkSolutionToIssue(WS, "5f1c2b4a-0000-4000-8000-0000000000ff", ISSUE)).toEqual({ status: "error", message: "That solution isn't there any more." });
    db.verdict = { ok: true, verdict: { status: "pass", holdsPct: 90, note: "", value: 1 } };
    expect((await linkSolutionToIssue(WS, SOL, ISSUE)).status).toBe("ok");
    expect(await linkSolutionToIssue(WS, SOL, ISSUE)).toEqual({ status: "error", message: "That solution is already linked to this issue." });
  });

  it("refuses when signed out or given something that isn't an id", async () => {
    expect(await linkSolutionToIssue("x", SOL, ISSUE)).toMatchObject({ status: "error" });
    signOut({ tdb });
    expect(await linkSolutionToIssue(WS, SOL, ISSUE)).toMatchObject({ status: "error", message: "Your session has ended. Sign in again." });
  });
});

describe("what can be linked, and the verdict worked out from the stored copy", () => {
  const issue = (over: Partial<IssueRow>) => ({ ...northbeamIssues()[0]!, links: [], target_measure: "Hands-on time per proposal", target_now: "9 h", target_goal: "under 3 hours", ...over }) as IssueRow;
  const P = live.process.id;

  it("allows an open or testing issue about the process, and says why not otherwise", () => {
    expect(linkProblem(issue({ process_id: P, status: "open" }), P)).toBeNull();
    expect(linkProblem(issue({ process_id: null, status: "testing", links: [{ process_id: P, step_id: ids.audit }] }), P)).toBeNull();
    expect(linkProblem(null, P)).toMatch(/isn't there/);
    expect(linkProblem(issue({ process_id: P, status: "dismissed" }), P)).toMatch(/dismissed/);
    expect(linkProblem(issue({ process_id: P, status: "resolved" }), P)).toMatch(/resolved or marked won't fix/);
    expect(linkProblem(issue({ process_id: P, status: "wont_fix" }), P)).toMatch(/won't fix/);
    expect(linkProblem(issue({ process_id: P, source: "detected" }), P)).toMatch(/only a detection/);
    expect(linkProblem(issue({ process_id: "other", links: [{ process_id: "other", step_id: null }] }), P)).toMatch(/another process/);
    expect(issueAboutProcess(issue({ process_id: "other", links: [{ process_id: P, step_id: null }] }), P)).toBe(true);
  });

  it("simulates the stored copy on the base and checks the issue's target, from the database's own issue", () => {
    const a = issue({ process_id: P, links: [{ process_id: P, step_id: ids.audit }] });
    const slow = verdictForCopy({ base: live, copy: solutionCopy(live), issue: a, processId: P });
    const fast = verdictForCopy({ base: live, copy: input().copy, issue: a, processId: P });
    expect(slow).toMatchObject({ ok: true, verdict: { status: "fail", holdsPct: 0 } });
    expect(fast).toMatchObject({ ok: true, verdict: { status: "pass", holdsPct: 100 } });
    // Deterministic.
    expect(verdictForCopy({ base: live, copy: input().copy, issue: a, processId: P })).toEqual(fast);
  });
});

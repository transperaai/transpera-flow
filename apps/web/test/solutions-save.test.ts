import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues, northbeamStepIds as ids, parseStepChanges, toEngineStepChanges, type IssueRow, type StoredStepChange } from "@transpera-flow/db";
import { solutionCopy } from "@/lib/solutions/bundle";
import { issueAboutProcess } from "@/lib/solutions/area";
import { linkProblem, verdictForCopy } from "@/lib/solutions/server-verdict";
import { demoBundle } from "@/lib/sources/demo";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { addMember, signInAs, signOut, type TestUser } from "./action-harness";

// The Server Actions that save a solution (issue #114): they write only the solution's own rows, as the signed-in user, and
// never the process's live version or its draft (D18). No automatic verdict is stored (QA round 2), whatever the browser sends: each
// link is only checked (`linkCheck`). Run against a real database with the seeded Northbeam workspace.

const db = vi.hoisted(() => ({
  failWith: null as { code: string; message?: string } | null,
}));
vi.mock("server-only", () => ({}));
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
  db.failWith = null;
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

describe("createSolution with automations (D53)", () => {
  const change = (n: number, step: string, over: Partial<StoredStepChange> = {}): StoredStepChange => ({
    id: `0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9c${String(n).padStart(2, "0")}`,
    name: `Change ${n}`,
    kind: "automation",
    effects: [{ step, part: "automatable", remove: 0.8, residualHours: 0.05 }],
    adoption: 0.7,
    ramp_months: 2,
    tiers: null,
    cost_monthly: 300,
    ...over,
  });
  const stored = async () => parseStepChanges((await tdb.client.query("select step_changes from solutions")).rows[0].step_changes);

  it("saves the list the editor sent with the new solution, ids kept, and the Sandbox model of the saved row matches the list", async () => {
    const list = [change(1, ids.audit), change(2, ids.discovery, { kind: "augmentation", effects: [{ step: ids.discovery, part: "augmentable", factor: 2 }], tiers: ["T1"], cost_monthly: null })];
    const r = await createSolution(WS, { ...input(), stepChanges: list });
    expect(r.status).toBe("ok");
    expect(await stored()).toEqual(list);
    if (r.status === "ok") expect(r.solution.step_changes).toEqual(list);
    const row = (await tdb.client.query("select id from solutions")).rows[0];
    for (const month of [1, 5]) expect(toEngineStepChanges({ id: row.id, step_changes: await stored() }, month)).toEqual(toEngineStepChanges({ id: row.id, step_changes: list }, month));
  });

  it("an unsaved new solution with only automations saves them", async () => {
    // The map is as live has it (nothing changed); the automations are the whole solution.
    const r = await createSolution(WS, { ...input(), copy: solutionCopy({ steps: live.steps, edges: live.edges }), changedStepIds: [], stepChanges: [change(3, ids.audit)] });
    expect(r.status).toBe("ok");
    expect(await stored()).toEqual([change(3, ids.audit)]);
  });

  it("keeps only the effects on the saved copy's steps, and drops a change left with none", async () => {
    const gone = "0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9cff";
    const two = change(4, ids.audit, { effects: [{ step: ids.audit, part: "automatable", remove: 0.5 }, { step: gone, part: "augmentable", factor: 2 }] });
    const r = await createSolution(WS, { ...input(), stepChanges: [two, change(5, gone)] });
    expect(r.status).toBe("ok");
    const [only, ...rest] = await stored();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ id: two.id, effects: [{ step: ids.audit, part: "automatable", remove: 0.5 }] });
  });

  it("refuses more than 40 changes, and a change the checks refuse, saving nothing", async () => {
    const many = Array.from({ length: 41 }, (_, i) => change(i, ids.audit));
    expect(await createSolution(WS, { ...input(), stepChanges: many })).toEqual({ status: "error", message: "A solution can have at most 40 changes. Remove one first." });
    const bad = await createSolution(WS, { ...input(), stepChanges: [change(6, ids.audit, { adoption: 5 })] });
    expect(bad).toEqual({ status: "error", message: "Change 6: Adoption is a share from 0% to 100%." });
    expect(await solutions()).toHaveLength(0);
  });

  it("saves the solution and its automations together: when the automations are refused, no solution or link is left behind", async () => {
    // Stands in for any refusal of the second write (a check, a lost connection).
    await tdb.client.query(`create function public.test_refuse_step_changes() returns trigger language plpgsql as $$
      begin if new.step_changes is distinct from old.step_changes then raise exception 'refused' using errcode = '23514'; end if; return new; end $$`);
    await tdb.client.query("create trigger test_refuse_step_changes before update on public.solutions for each row execute function public.test_refuse_step_changes()");
    try {
      const r = await createSolution(WS, { ...input(), stepChanges: [change(7, ids.audit)] });
      expect(r).toEqual({ status: "error", message: "Some of those values aren't allowed." });
      expect(await solutions()).toHaveLength(0);
      expect(await links()).toHaveLength(0);
    } finally {
      await tdb.client.query("drop trigger test_refuse_step_changes on public.solutions; drop function public.test_refuse_step_changes()");
    }
  });
});

describe("createSolution", () => {
  it("saves through save_solution with no automatic verdict, whatever the browser claims (QA round 2)", async () => {
    const before = await processState();
    const r = await createSolution(WS, input());
    expect(r.status).toBe("ok");
    expect(await links()).toEqual([{ issue_id: ISSUE, auto_verdict: null, holds_pct: null, auto_note: "" }]);
    // Nothing of the process: not its revisions, steps, edges or draft.
    expect(await processState()).toBe(before);
    if (r.status === "ok") expect(r.links).toHaveLength(1);
  });

  it("links every issue it is for", async () => {
    await createSolution(WS, { ...input(), links: [{ issueId: ISSUE }, { issueId: OTHER_ISSUE }] });
    expect(await links()).toHaveLength(2);
  });

  it("refuses, without saving, an issue that is closed", async () => {
    const closed = await issue({ title: "Closed" });
    await tdb.client.query("update issues set status = 'done' where id = $1", [closed]);
    expect(await createSolution(WS, { ...input(), links: [{ issueId: closed }] })).toEqual({ status: "error", message: "That issue is already resolved or marked won't fix, so a solution can't be linked to it. Reopen it first." });
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
    // The link check refuses these before anything is written.
    const detected = await issue({ source: "detected", detected_key: "delay:p:step1" });
    expect((await attempt(editor, { links: [{ issueId: detected }] })).message).toMatch(/only a detection/);
    const elsewhere = (await tdb.client.query("insert into processes (workspace_id, name) values ($1, 'Elsewhere') returning id", [WS])).rows[0].id;
    const foreign = await issue({ process_id: elsewhere });
    expect((await attempt(editor, { links: [{ issueId: foreign }] })).message).toMatch(/another process/);
    const closed = await issue({ title: "Closed" });
    await tdb.client.query("update issues set status = 'dismissed' where id = $1", [closed]);
    expect((await attempt(editor, { links: [{ issueId: closed }] })).message).toMatch(/dismissed/);
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
  });

  it("links a saved solution to an issue with no automatic verdict", async () => {
    const r = await linkSolutionToIssue(WS, SOL, ISSUE);
    expect(r.status).toBe("ok");
    expect(await links(SOL)).toEqual([{ issue_id: ISSUE, auto_verdict: null, holds_pct: null, auto_note: "" }]);
    if (r.status === "ok") expect(r.link).toMatchObject({ solution_id: SOL, issue_id: ISSUE, workspace_id: WS, auto_verdict: null, holds_pct: null });
  });

  it("refuses a closed issue, another process's issue or a missing solution, and a second link to the same issue", async () => {
    const elsewhere = (await tdb.client.query("insert into processes (workspace_id, name) values ($1, 'Elsewhere') returning id", [WS])).rows[0].id;
    const foreign = await issue({ process_id: elsewhere });
    expect(await linkSolutionToIssue(WS, SOL, foreign)).toEqual({ status: "error", message: "That issue is about another process, so this solution can't be linked to it." });
    expect(await links(SOL)).toEqual([]);
    expect(await linkSolutionToIssue(WS, "5f1c2b4a-0000-4000-8000-0000000000ff", ISSUE)).toEqual({ status: "error", message: "That solution isn't there any more." });
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

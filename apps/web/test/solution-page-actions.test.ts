import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues } from "@transpera-flow/db";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { addMember, signInAs, signOut, type TestUser } from "./action-harness";

// The Server Actions the Solution page calls (issue #115, A50): your verdict and note on a link, and the notes on a solution.
// They write as the signed-in user; row-level security decides who may (an editor changes a row, anyone else changes none and is told).
// Runs against a real database with the seeded Northbeam workspace.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
const { saveSolutionNotes, saveSolutionVerdict } = await import("@/app/w/[slug]/solution-page-actions");

const WS = NORTHBEAM_WORKSPACE_ID;
const ISSUE = northbeamIssues()[0]!.id;
let SOL: string;
let tdb: TestDb;
let editor: TestUser;
let viewer: TestUser;

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
  SOL = (
    await tdb.client.query(
      "insert into solutions (workspace_id, process_id, base_revision_id, name, steps) values ($1, $2, $3, 'AI lead qualifier', $4::jsonb) returning id",
      [WS, NORTHBEAM_PROCESS_ID, NORTHBEAM_REVISION_ID, JSON.stringify({ steps: [], edges: [], entry_step_id: null })],
    )
  ).rows[0].id;
  await tdb.client.query("insert into solution_issues (solution_id, issue_id, workspace_id, auto_verdict, holds_pct, auto_note) values ($1, $2, $3, 'pass', 95, 'Holds')", [SOL, ISSUE, WS]);
  signInAs({ tdb }, editor);
});

const link = async () => (await tdb.client.query("select user_verdict, user_notes, auto_verdict, holds_pct, auto_note from solution_issues where solution_id = $1 and issue_id = $2", [SOL, ISSUE])).rows[0];

describe("saveSolutionVerdict", () => {
  it("saves a pass, a fail or a cleared verdict on that solution and issue only", async () => {
    // A second link, on another issue of the same solution, must stay as it was.
    const other = northbeamIssues()[1]!.id;
    await tdb.client.query("insert into solution_issues (solution_id, issue_id, workspace_id, auto_verdict, holds_pct) values ($1, $2, $3, 'pass', 80)", [SOL, other, WS]);
    for (const v of ["pass", "fail", null]) {
      const out = await saveSolutionVerdict(WS, SOL, ISSUE, { verdict: v });
      expect(out.status).toBe("ok");
      if (out.status === "ok") expect(out.link).toMatchObject({ solution_id: SOL, issue_id: ISSUE, user_verdict: v });
      expect((await link()).user_verdict).toBe(v);
      expect((await tdb.client.query("select user_verdict from solution_issues where issue_id = $1", [other])).rows[0].user_verdict).toBeNull();
    }
  });

  it("saves your note with it, or on its own, and never touches the automatic verdict", async () => {
    await saveSolutionVerdict(WS, SOL, ISSUE, { verdict: "fail", notes: "Too slow" });
    expect(await link()).toMatchObject({ user_verdict: "fail", user_notes: "Too slow" });
    // A note on its own does not write the verdict, and a verdict on its own does not write the note.
    await saveSolutionVerdict(WS, SOL, ISSUE, { notes: "Only a note" });
    expect(await link()).toMatchObject({ user_verdict: "fail", user_notes: "Only a note" });
    await saveSolutionVerdict(WS, SOL, ISSUE, { verdict: "pass" });
    expect(await link()).toMatchObject({ user_verdict: "pass", user_notes: "Only a note" });
    expect(await link()).toMatchObject({ auto_verdict: "pass", holds_pct: 95, auto_note: "Holds" });
  });

  it("refuses anything that isn't a pass, a fail or nothing, an id that isn't one, and a note that is too long", async () => {
    expect((await saveSolutionVerdict(WS, SOL, ISSUE, { verdict: "maybe" })).status).toBe("error");
    expect((await saveSolutionVerdict(WS, SOL, "nope", { verdict: "pass" })).status).toBe("error");
    expect((await saveSolutionVerdict(WS, SOL, ISSUE, { notes: "x".repeat(4001) })).status).toBe("error");
    expect((await saveSolutionVerdict(WS, SOL, ISSUE, {})).status).toBe("error");
    expect(await link()).toMatchObject({ user_verdict: null, user_notes: "" });
  });

  it("says so when no row changed (a viewer, or a solution that is gone) and when the session has ended", async () => {
    signInAs({ tdb }, viewer);
    expect(await saveSolutionVerdict(WS, SOL, ISSUE, { verdict: "pass" })).toEqual({ status: "error", message: expect.stringMatching(/permission/) });
    expect((await link()).user_verdict).toBeNull();
    signInAs({ tdb }, editor);
    expect(await saveSolutionVerdict(WS, "5f1c2b4a-0000-4000-8000-0000000000ff", ISSUE, { verdict: "pass" })).toEqual({ status: "error", message: expect.stringMatching(/permission/) });
    signOut({ tdb });
    expect(await saveSolutionVerdict(WS, SOL, ISSUE, { verdict: "pass" })).toEqual({ status: "error", message: expect.stringMatching(/session has ended/) });
  });
});

describe("saveSolutionNotes", () => {
  it("saves the notes on the solution", async () => {
    expect(await saveSolutionNotes(WS, SOL, "Needs a trial")).toEqual({ status: "ok", notes: "Needs a trial" });
    expect((await tdb.client.query("select notes from solutions where id = $1", [SOL])).rows[0].notes).toBe("Needs a trial");
  });

  it("refuses notes that are too long, and says so when no row changed", async () => {
    expect((await saveSolutionNotes(WS, SOL, "x".repeat(4001))).status).toBe("error");
    expect((await saveSolutionNotes(WS, SOL, 5)).status).toBe("error");
    signInAs({ tdb }, viewer);
    expect((await saveSolutionNotes(WS, SOL, "ok")).status).toBe("error");
    expect((await tdb.client.query("select notes from solutions where id = $1", [SOL])).rows[0].notes).not.toBe("ok");
  });
});

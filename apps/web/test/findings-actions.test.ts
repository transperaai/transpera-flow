import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamPersonIds } from "@transpera-flow/db";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { addMember, signInAs, type TestUser } from "./action-harness";

// An editor edits an AI finding that is stored with labels ("Team member A") and shown with names (B1 2b, issue #30): the
// edit turns names back into labels before it is stored, so saving without a change stores exactly the old words (and the
// database doesn't mark the finding edited), and what comes back is named again. Runs against a real database with the seeded
// Northbeam team; the finding is written directly, with its labels, as the owner connection.

const MAYA = northbeamPersonIds["Maya Collins"]!;
const ANN = northbeamPersonIds["Leah Brooks"]!;
const GONE = "00000000-0000-4000-8000-00000000000d";
const WS = NORTHBEAM_WORKSPACE_ID;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
const { decideFinding, editFinding } = await import("@/app/w/[slug]/findings-actions");

let tdb: TestDb;
let editor: TestUser;
let ownMember: TestUser;
let ID: string;

beforeAll(async () => {
  tdb = await createTestDb();
  editor = await addMember(tdb, WS, "editor");
  ownMember = await addMember(tdb, WS, "member", MAYA);
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

const draft = (over: Record<string, unknown> = {}) => ({ processId: null, stepId: null, rating: "bad", type: "delay", title: "", evidence: "", why: "", sourceIds: [], ...over });
const stored = async () => (await tdb.client.query("select title, evidence, why, status, person_labels from findings where id = $1", [ID])).rows[0];

async function seed(over: Record<string, unknown> = {}) {
  await tdb.client.query("delete from findings");
  const row = {
    workspace_id: WS,
    process_id: NORTHBEAM_PROCESS_ID,
    origin: "manual",
    status: "accepted",
    rating: "bad",
    type: "delay",
    title: "Team member A prices every pitch",
    evidence: "Team member B reviews it. Team member D is away.",
    why: "Team member A is on leave in March.",
    person_labels: JSON.stringify({ "Team member A": MAYA, "Team member B": ANN, "Team member D": GONE }),
    ...over,
  };
  const cols = Object.keys(row);
  ID = (await tdb.client.query(`insert into findings (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row))).rows[0].id;
}

beforeEach(async () => {
  await seed();
  signInAs({ tdb }, editor);
});

describe("editFinding", () => {
  it("stores exactly the old words when the editor saves without a change, 'A team member' for someone deleted included", async () => {
    const shown = { title: "Maya Collins prices every pitch", evidence: "Leah Brooks reviews it. A team member is away.", why: "Maya Collins is on leave in March." };
    const out = await editFinding(ID, draft(shown), false);
    expect(await stored()).toMatchObject({ title: "Team member A prices every pitch", evidence: "Team member B reviews it. Team member D is away.", why: "Team member A is on leave in March." });
    // What comes back is named for the editor again.
    expect(out.status).toBe("saved");
    if (out.status === "saved") expect(out.finding).toMatchObject({ title: shown.title, evidence: shown.evidence, why: shown.why });
  });

  it("turns a name an editor typed into the person's label: the full name, and a first name nobody else shares", async () => {
    await editFinding(ID, draft({ title: "Maya Collins and Leah Brooks price every pitch", evidence: "Leah Brooks reviews it. A team member is away.", why: "Maya is on leave in March." }), false);
    expect(await stored()).toMatchObject({
      title: "Team member A and Team member B price every pitch",
      // Unchanged as shown, so stored as it was: "A team member" must not replace the label of someone since deleted.
      evidence: "Team member B reviews it. Team member D is away.",
      why: "Team member A is on leave in March.",
    });
  });

  it("changes only the field that was changed", async () => {
    await editFinding(ID, draft({ title: "Maya Collins prices every pitch", evidence: "Nobody reviews it.", why: "Maya Collins is on leave in March." }), true);
    expect(await stored()).toMatchObject({ title: "Team member A prices every pitch", evidence: "Nobody reviews it.", why: "Team member A is on leave in March.", status: "accepted" });
  });

  it("leaves a finding with no labels (added by hand) as sent", async () => {
    await seed({ person_labels: "{}", title: "Maya Collins pitched" });
    const out = await editFinding(ID, draft({ title: "Maya Collins pitched alone", evidence: "", why: "Clients wait." }), false);
    expect(out.status).toBe("saved");
    expect(await stored()).toMatchObject({ title: "Maya Collins pitched alone" });
  });

  it("refuses a bad id or draft before touching the database", async () => {
    expect(await editFinding("nope", draft(), false)).toMatchObject({ status: "invalid" });
    expect(await editFinding(ID, { title: 3 }, false)).toMatchObject({ status: "invalid" });
    expect(await stored()).toMatchObject({ title: "Team member A prices every pitch" });
  });
});

describe("decideFinding", () => {
  it("returns the finding named for whoever decided it, a member's own name only", async () => {
    // A member sees only their own name; the editor (an owner or editor) is the one who may decide, so the decision is made as
    // the editor and read back as the member would see it.
    const out = await decideFinding(ID, "accepted");
    expect(out.status).toBe("saved");
    if (out.status === "saved") expect(out.finding).toMatchObject({ title: "Maya Collins prices every pitch", evidence: "Leah Brooks reviews it. A team member is away." });
    signInAs({ tdb }, ownMember);
    const seen = await decideFinding(ID, "accepted");
    // A member can't decide (RLS), so nothing is returned for them to read.
    expect(seen.status).not.toBe("saved");
  });

  it("returns a finding with no labels untouched", async () => {
    await seed({ person_labels: "{}" });
    const out = await decideFinding(ID, "dismissed");
    expect(out.status).toBe("saved");
    if (out.status === "saved") expect(out.finding.title).toBe("Team member A prices every pitch");
  });
});

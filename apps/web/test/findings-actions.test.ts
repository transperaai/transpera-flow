import { beforeEach, describe, expect, it, vi } from "vitest";

// An editor edits an AI finding that is stored with labels ("Team member A") and shown with names (B1 2b, issue #30): the
// edit turns names back into labels before it is stored, so saving without a change stores exactly the old words (and the
// database doesn't mark the finding edited), and what comes back is named again. A stand-in for Supabase records what is sent.

const MAYA = "00000000-0000-4000-8000-00000000000a";
const ANN = "00000000-0000-4000-8000-00000000000b";
const GONE = "00000000-0000-4000-8000-00000000000d";
const ID = "00000000-0000-4000-8000-0000000000f1";

const db = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>,
  updates: [] as Record<string, unknown>[],
  team: {} as unknown,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    let payload: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      update: (p: Record<string, unknown>) => ((payload = p), db.updates.push(p), chain),
      maybeSingle: async () => ({ data: db.stored, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: [{ ...db.stored, ...payload }], error: null }),
    };
    return { from: () => chain, rpc: async () => ({ data: db.team, error: null }) };
  },
}));
const { decideFinding, editFinding } = await import("@/app/w/[slug]/findings-actions");

const team = (people: { id: string; name: string }[], seesEveryone = true, own: string | null = null) => ({
  sees_everyone: seesEveryone,
  own_person_id: own,
  people: people.map((p) => ({ ...p, workspace_id: "w", fte: 1, capacity_hours_week: 40, cost_rate: null, active: true, start_date: null, end_date: null, provenance: {} })),
  person_roles: [],
  person_skills: [],
  person_leave: [],
  client_assignments: [],
});
const draft = (over: Record<string, unknown> = {}) => ({ processId: null, stepId: null, rating: "bad", type: "delay", title: "", evidence: "", why: "", sourceIds: [], ...over });

beforeEach(() => {
  db.updates.length = 0;
  db.stored = {
    id: ID,
    workspace_id: "w",
    title: "Team member A prices every pitch",
    evidence: "Team member B reviews it. Team member D is away.",
    why: "Team member A is on leave in March.",
    facts: [{ kind: "fact", key: "k", text: "Team member A works 4 h/wk overtime." }],
    person_labels: { "Team member A": MAYA, "Team member B": ANN, "Team member D": GONE },
  };
  db.team = team([{ id: MAYA, name: "Maya Collins" }, { id: ANN, name: "Ann Lee" }]);
});

describe("editFinding", () => {
  it("stores exactly the old words when the editor saves without a change, 'A team member' for someone deleted included", async () => {
    const shown = { title: "Maya Collins prices every pitch", evidence: "Ann Lee reviews it. A team member is away.", why: "Maya Collins is on leave in March." };
    const out = await editFinding(ID, draft(shown), false);
    expect(db.updates[0]).toMatchObject({ title: "Team member A prices every pitch", evidence: "Team member B reviews it. Team member D is away.", why: "Team member A is on leave in March." });
    // What comes back is named for the editor again.
    expect(out.status).toBe("saved");
    if (out.status === "saved") expect(out.finding).toMatchObject({ title: shown.title, evidence: shown.evidence, why: shown.why });
  });

  it("turns a name an editor typed into the person's label: the full name, and a first name nobody else shares", async () => {
    await editFinding(ID, draft({ title: "Maya Collins and Ann Lee price every pitch", evidence: "Ann Lee reviews it. A team member is away.", why: "Maya is on leave in March." }), false);
    expect(db.updates[0]).toMatchObject({
      title: "Team member A and Team member B price every pitch",
      // Unchanged as shown, so stored as it was: "A team member" must not replace the label of someone since deleted.
      evidence: "Team member B reviews it. Team member D is away.",
      why: "Team member A is on leave in March.",
    });
  });

  it("changes only the field that was changed", async () => {
    await editFinding(ID, draft({ title: "Maya Collins prices every pitch", evidence: "Nobody reviews it.", why: "Maya Collins is on leave in March." }), true);
    expect(db.updates[0]).toMatchObject({ title: "Team member A prices every pitch", evidence: "Nobody reviews it.", why: "Team member A is on leave in March.", status: "accepted" });
  });

  it("leaves a finding with no labels (added by hand) as sent, and asks for no team", async () => {
    db.stored = { ...db.stored, person_labels: {}, title: "Maya Collins pitched" };
    db.team = null;
    await editFinding(ID, draft({ title: "Maya Collins pitched alone" }), false);
    expect(db.updates[0]).toMatchObject({ title: "Maya Collins pitched alone" });
  });

  it("refuses a bad id or draft before touching the database", async () => {
    expect(await editFinding("nope", draft(), false)).toMatchObject({ status: "invalid" });
    expect(await editFinding(ID, { title: 3 }, false)).toMatchObject({ status: "invalid" });
    expect(db.updates).toEqual([]);
  });
});

describe("decideFinding", () => {
  it("returns the finding named for whoever decided it, a member's own name only", async () => {
    db.team = team([{ id: MAYA, name: "Maya Collins" }, { id: ANN, name: "Team member 2" }], false, MAYA);
    const out = await decideFinding(ID, "accepted");
    expect(out.status).toBe("saved");
    if (out.status === "saved") expect(out.finding).toMatchObject({ title: "Maya Collins prices every pitch", evidence: "A team member reviews it. A team member is away." });
  });

  it("returns a finding with no labels untouched", async () => {
    db.stored = { ...db.stored, person_labels: {} };
    const out = await decideFinding(ID, "dismissed");
    expect(out.status).toBe("saved");
    if (out.status === "saved") expect(out.finding.title).toBe("Team member A prices every pitch");
  });
});

import { describe, expect, it } from "vitest";
import { northbeamStepIds, type ProposalRow } from "@transpera-flow/db";
import { mapPlayChanges } from "@/lib/share/play-changes";
import { buildIdeaHref, ideaSeed, placeIdea, readIdea } from "@/lib/suggestions/idea";
import { describeProposal, hasHeld, heldSeen, withHeld } from "@/lib/suggestions/proposals";
import { demoBundle } from "@/lib/sources/demo";

// A visitor's idea (B4), as pure logic: what the payload carries, where Build it goes, how the card reads it, what an owner reads in
// place of the stand-ins, and what Build it keeps of the visitor's changes once checked against the live process.

const live = demoBundle();
const step = northbeamStepIds.qualify;
const LEADS = { path: "demand.leads_per_week", op: "set", value: 12 } as const;
const idea = (over: Partial<ProposalRow> = {}, payload: Record<string, unknown> = {}): ProposalRow =>
  ({
    id: "00000000-0000-4000-8000-0000000000f1",
    workspace_id: live.workspace.id,
    kind: "solution_idea",
    title: "One more strategist",
    detail: "With 3 strategists, leads wait under a day.",
    payload: { steps: [], edges: [], replaces_step_ids: [], levers: [LEADS], process_id: live.process.id, base_revision_id: live.revision.id, ...payload },
    evidence: [],
    note: null,
    issue_id: null,
    status: "pending",
    created_via: "play_link",
    import_source: null,
    proposer_name: "Marta Okoye",
    share_link_id: "00000000-0000-4000-8000-0000000000aa",
    applied: null,
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: "2026-10-06T09:00:00Z",
    created_by: null,
    ...over,
  }) as ProposalRow;

describe("readIdea reads lever changes", () => {
  it("keeps well-formed patches and drops anything else without throwing", () => {
    expect(readIdea({ steps: [], levers: [LEADS] }).levers).toEqual([LEADS]);
    expect(readIdea({ steps: [], levers: [{ path: "x", op: "set", value: 1 }] }).levers).toEqual([]);
    expect(readIdea({ steps: [], levers: "nope" }).levers).toEqual([]);
    expect(readIdea({ steps: [] }).levers).toEqual([]);
    expect(readIdea(null).levers).toEqual([]);
  });
  it("ideaSeed carries them", () => {
    expect(ideaSeed(idea(), live.roles)).toMatchObject({ levers: [LEADS], leverNotes: [], replaces: [] });
  });
});

describe("buildIdeaHref", () => {
  it("a visitor's idea builds on the process its link shared, with or without an issue", () => {
    const none = new URL(buildIdeaHref("/w/n", idea(), undefined, "/w/n/suggestions")!, "https://x.test");
    expect(none.pathname).toBe(`/w/n/p/${live.process.id}/edit`);
    expect(none.searchParams.get("mode")).toBe("solution");
    expect(none.searchParams.get("idea")).toBe(idea().id);
    expect(none.searchParams.has("issue")).toBe(false);
    const withIssue = new URL(buildIdeaHref("/w/n", idea({ issue_id: "00000000-0000-4000-8000-0000000000e1" }), undefined, "/w/n/suggestions")!, "https://x.test");
    expect(withIssue.searchParams.get("issue")).toBe("00000000-0000-4000-8000-0000000000e1");
  });
  it("an idea from anywhere else still needs an issue with a process", () => {
    expect(buildIdeaHref("/w/n", idea({ created_via: "mcp" }), undefined, "/x")).toBeNull();
    expect(buildIdeaHref("/w/n", idea({ created_via: "mcp", issue_id: "i1" }), { processId: "p1" }, "/x")).toContain("/p/p1/edit");
    expect(buildIdeaHref("/w/n", idea({}, { process_id: undefined }), undefined, "/x")).toBeNull();
  });
});

describe("describeProposal for a visitor's idea", () => {
  const lookups = { processes: { [live.process.id]: "Lead to live" }, steps: { [step]: "Check fit" }, issues: {}, roles: { r1: "Strategist" }, currency: "GBP" };

  it("reads the note, the changes in words and where it came from; no 'Proposed steps' line", () => {
    const v = describeProposal(idea({}, { levers: [LEADS, { path: "roles.r1.headcount", op: "set", value: 3 }, { path: `steps.${step}.work_hours`, op: "multiply", value: 0.8 }] }), lookups);
    expect(v).toMatchObject({ kind: "Visitor's idea", from: "Marta Okoye (play link)", title: "One more strategist", issue: null });
    expect(v.lines).toEqual(["With 3 strategists, leads wait under a day.", "Changes: Leads per week: 12; Strategist: 3 people; Hands-on time on Check fit: −20%.", "Sent from a link to Lead to live."]);
    expect(v.changes).toHaveLength(3);
    expect(v.lines.join(" ")).not.toMatch(/Proposed steps/);
  });

  it("a person's hours read 'a team member' unless the reader sees everyone", () => {
    const patch = { path: "people.p1.fte", op: "set", value: 0.8 };
    expect(describeProposal(idea({}, { levers: [patch] }), lookups).changes).toEqual(["Hours for a team member: 0.8 FTE"]);
    expect(describeProposal(idea({}, { levers: [patch] }), { ...lookups, people: { p1: "Marta Okoye" } }).changes).toEqual(["Hours for Marta Okoye: 0.8 FTE"]);
  });

  it("names the issue it is for when it has one, and a process that has gone", () => {
    expect(describeProposal(idea({ issue_id: "i1" }), { ...lookups, issues: { i1: { number: 4, title: "Leads wait", processId: null } } }).issue).toEqual({ id: "i1", number: 4, title: "Leads wait" });
    expect(describeProposal(idea(), { ...lookups, processes: {} }).lines.at(-1)).toBe("Sent from a link to a process that has gone.");
  });

  it("other ideas read as before", () => {
    const mcp = describeProposal(idea({ created_via: "mcp" }, { steps: [{ key: "a", name: "Do it" }] }), lookups);
    expect(mcp.kind).toBe("Solution idea");
    expect(mcp.changes).toEqual([]);
    expect(mcp.lines.join(" ")).toContain("Proposed steps: Do it");
  });
});

describe("what an owner reads in place of the stand-ins", () => {
  const held = idea({ title: "A visitor's idea", detail: null, proposer_name: "A visitor" });
  const contact = { email: "marta@example.com", held: { title: "Ask Priya", note: "Priya says £4,100", name: "Marta Okoye" } };

  it("withHeld puts the originals back for an owner and changes nothing for anyone else", () => {
    expect(withHeld(held, contact)).toMatchObject({ title: "Ask Priya", detail: "Priya says £4,100", proposer_name: "Marta Okoye" });
    expect(withHeld(held, undefined)).toBe(held);
    expect(withHeld(held, { email: "x@y.example", held: {} })).toBe(held);
    expect(withHeld(idea({ created_via: "mcp" }), contact).title).toBe("One more strategist");
    expect(withHeld(held, { email: null, held: { note: "n" } })).toMatchObject({ title: "A visitor's idea", detail: "n", proposer_name: "A visitor" });
  });

  it("says in words which fields members read as a stand-in", () => {
    expect(hasHeld(contact)).toBe(true);
    expect(hasHeld({ email: "a@b.example", held: {} })).toBe(false);
    expect(hasHeld(undefined)).toBe(false);
    expect(heldSeen(contact)).toBe("“A visitor's idea”, no note and “A visitor” as the name");
    expect(heldSeen({ email: null, held: { title: "x" } })).toBe("“A visitor's idea”");
    expect(heldSeen({ email: null, held: { note: "x" } })).toBe("no note");
  });
});

describe("placeIdea for an idea that only changes levers", () => {
  it("places nothing and says the levers are listed under Lever changes", () => {
    const placed = placeIdea(live, ideaSeed(idea(), live.roles));
    expect(placed).toEqual({ edit: null, id: null, note: "The idea changes levers only: they're listed under Lever changes. Adjust the map too if you like, simulate, then save." });
  });
  it("an idea with neither steps nor levers keeps the 'no usable steps' note", () => {
    expect(placeIdea(live, ideaSeed(idea({}, { levers: [] }), live.roles)).note).toContain("it has no usable steps");
  });
});

describe("mapPlayChanges: Build it checks the visitor's changes against the live process", () => {
  const role = live.roles[0]!.id;
  const person = live.people[0]!.id;
  const service = live.services[0]?.id;

  it("keeps changes whose step, role, person or service is still there, and any without an id", () => {
    const levers = [LEADS, { path: `steps.${step}.work_hours`, op: "multiply", value: 0.8 }, { path: `roles.${role}.headcount`, op: "set", value: 3 }, { path: `people.${person}.fte`, op: "set", value: 0.8 }, ...(service ? [{ path: `services.${service}.price`, op: "set", value: 2000 }] : [])];
    const r = mapPlayChanges(levers, live);
    expect(r.levers).toEqual(levers);
    expect(r.notes).toEqual([]);
  });

  it("drops the ones whose target has gone, with one note, and the malformed", () => {
    const gone = "00000000-0000-4000-8000-00000000dead";
    const r = mapPlayChanges([LEADS, { path: `steps.${gone}.work_hours`, op: "multiply", value: 0.8 }, { path: `roles.${gone}.headcount`, op: "set", value: 2 }, { path: "x", op: "set", value: 1 }, "nope"], live);
    expect(r.levers).toEqual([LEADS]);
    expect(r.notes).toEqual(["4 of the visitor's changes no longer apply (a step, role or service has gone since they sent it)."]);
  });

  it("a step of a process inside the live one counts, a retired step doesn't", () => {
    const inner = (live.otherProcesses ?? []).flatMap((p) => p.steps)[0];
    if (inner) expect(mapPlayChanges([{ path: `steps.${inner.id}.work_hours`, op: "multiply", value: 0.9 }], live).levers).toHaveLength(1);
    const retired = { ...live, steps: live.steps.filter((s) => s.id !== step) };
    expect(mapPlayChanges([{ path: `steps.${step}.work_hours`, op: "multiply", value: 0.9 }], retired).levers).toEqual([]);
  });

  it("not a list is none", () => {
    expect(mapPlayChanges(undefined, live)).toEqual({ levers: [], notes: [] });
    expect(mapPlayChanges("x", live)).toEqual({ levers: [], notes: [] });
  });
});

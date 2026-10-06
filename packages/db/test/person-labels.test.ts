import { describe, expect, it } from "vitest";
import { A_TEAM_MEMBER, labelNames, labelsUsed, nameAnalysisRow, nameFinding, nameLabels, readPersonLabels, type PersonLabels } from "../src";

// AI text saved with labels and named at render (B1 2b, issue #30): pure, no database.

const MAYA = "00000000-0000-4000-8000-00000000000a";
const ANN = "00000000-0000-4000-8000-00000000000b";
const ROSA = "00000000-0000-4000-8000-00000000000c";
const GONE = "00000000-0000-4000-8000-00000000000d";
const people = [
  { id: MAYA, name: "Maya Collins" },
  { id: ANN, name: "Ann Lee" },
  { id: ROSA, name: "Rosa Diaz" },
];
const labels: PersonLabels = { "Team member A": MAYA, "Team member B": ANN, "Team member C": ROSA, "Team member D": GONE };
const editor = { people };
const member = { viewer: { seesEveryone: false, ownPersonId: MAYA }, people: [{ id: MAYA, name: "Maya Collins" }] };
const stranger = { viewer: { seesEveryone: false, ownPersonId: null }, people: [] };

describe("nameLabels", () => {
  it("gives an editor the names", () => {
    expect(nameLabels("Team member A hands work to Team member B.", labels, editor)).toBe("Maya Collins hands work to Ann Lee.");
  });

  it("gives a member their own name, and 'A team member' for others: capital at the start, lower case mid-sentence", () => {
    expect(nameLabels("Team member A hands work to Team member B.", labels, member)).toBe("Maya Collins hands work to a team member.");
    expect(nameLabels("Team member B hands work to Team member A.", labels, member)).toBe("A team member hands work to Maya Collins.");
    expect(nameLabels("Busy. Team member B is away! Team member C too? Yes.\nTeam member B again; “Team member C” said so.", labels, member)).toBe(
      "Busy. A team member is away! A team member too? Yes.\nA team member again; “A team member” said so.",
    );
  });

  it("handles the possessive", () => {
    expect(nameLabels("Team member A's week and Team member B's week.", labels, member)).toBe("Maya Collins's week and a team member's week.");
    expect(nameLabels("Team member B's week", labels, member)).toBe("A team member's week");
  });

  it("names everyone 'A team member' for a member linked to no one", () => {
    expect(nameLabels("Team member A and Team member B", labels, stranger)).toBe("A team member and a team member");
  });

  it("says 'A team member' for a person since deleted, even to an editor", () => {
    expect(nameLabels("Team member D left.", labels, editor)).toBe("A team member left.");
    expect(nameLabels("Ask Team member D.", labels, editor)).toBe("Ask a team member.");
  });

  it("matches the longest label first: 'Team member 2' never matches inside 'Team member 27'", () => {
    const many: PersonLabels = { "Team member 2": MAYA, "Team member 27": ANN };
    expect(nameLabels("Team member 27 and Team member 2 and Team member 270", many, editor)).toBe("Ann Lee and Maya Collins and Team member 270");
  });

  it("matches a label only when no letter or digit follows it", () => {
    expect(nameLabels("Team member Alice, Team member A.", labels, editor)).toBe("Team member Alice, Maya Collins.");
  });

  it("leaves a label that isn't in the map alone", () => {
    expect(nameLabels("Team member Z and Team member A", labels, editor)).toBe("Team member Z and Maya Collins");
  });

  it("leaves text alone when there are no labels", () => {
    expect(nameLabels("Nothing here.", {}, editor)).toBe("Nothing here.");
  });

  it("treats a bundle with no viewer as seeing everyone", () => {
    expect(nameLabels("Team member B", labels, { people })).toBe("Ann Lee");
  });

  it("inserts a name that looks like a replacement pattern as it is", () => {
    expect(nameLabels("Team member A", { "Team member A": MAYA }, { people: [{ id: MAYA, name: "Pat $& $1 O'Neil" }] })).toBe("Pat $& $1 O'Neil");
  });
});

describe("labelsUsed", () => {
  it("returns the labels that occur in any text, with the same boundary rule", () => {
    const all: PersonLabels = { ...labels, "Team member 2": ROSA, "Team member 27": GONE };
    expect(labelsUsed(["Team member A works.", "Nothing", "and Team member 27"], all)).toEqual({ "Team member A": MAYA, "Team member 27": GONE });
    expect(labelsUsed(["Team member Alice"], all)).toEqual({});
    expect(labelsUsed([], all)).toEqual({});
    expect(labelsUsed(["Team member A"], {})).toEqual({});
  });
});

describe("readPersonLabels", () => {
  it("keeps label → uuid pairs and drops a bad key or a non-uuid value", () => {
    expect(readPersonLabels({ "Team member A": MAYA, "Team member 27": ANN, "Team member": ROSA, "Maya Collins": ROSA, "Team member B": "nope", "Team member C": 7 })).toEqual({
      "Team member A": MAYA,
      "Team member 27": ANN,
    });
  });
  it("reads nothing from a non-object", () => {
    expect(readPersonLabels(null)).toEqual({});
    expect(readPersonLabels([MAYA])).toEqual({});
    expect(readPersonLabels("x")).toEqual({});
  });
  it("keeps at most 500", () => {
    const big = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`Team member ${i + 1}`, MAYA]));
    expect(Object.keys(readPersonLabels(big))).toHaveLength(500);
  });
});

describe("labelNames", () => {
  const texts = [
    "Team member A works 4 h/wk overtime.",
    "Team member A and Team member B share the pitch; Team member C reviews it.",
    "Team member B's week is full. Team member A is the bottleneck.",
    "No people here at all.",
    "Team member A, Team member A, Team member A.",
  ];

  it("undoes nameLabels for an editor, for a range of texts", () => {
    for (const t of texts) expect(labelNames(nameLabels(t, labels, editor), labels, people), t).toBe(t);
  });

  it("turns a first name into the label too, when it is unambiguous and long enough", () => {
    expect(labelNames("Ask Maya about it; Maya agrees. Ann Lee is busy and Ann too.", labels, people)).toBe("Ask Team member A about it; Team member A agrees. Team member B is busy and Team member B too.");
  });

  it("matches a first name only as written: a word like 'will' is not a person, a full name still matches in any case", () => {
    const will = [{ id: MAYA, name: "Will Hart" }];
    const l = { "Team member A": MAYA };
    expect(labelNames("Will Hart is at capacity; this will get worse", l, will)).toBe("Team member A is at capacity; this will get worse");
    expect(labelNames("Will is at capacity; this will get worse", l, will)).toBe("Team member A is at capacity; this will get worse");
    expect(labelNames("WILL HART and will hart", l, will)).toBe("Team member A and Team member A");
  });

  it("leaves a first name alone when another person shares it, or it is under three letters", () => {
    const shared = [...people, { id: "00000000-0000-4000-8000-00000000000e", name: "Maya Brown" }];
    expect(labelNames("Maya Collins and Maya", labels, shared)).toBe("Team member A and Maya");
    expect(labelNames("Al Lee and Al", { "Team member A": MAYA }, [{ id: MAYA, name: "Al Lee" }])).toBe("Team member A and Al");
  });

  it("does not match inside a longer word", () => {
    expect(labelNames("Annual review with Annabel", labels, people)).toBe("Annual review with Annabel");
  });

  it("round trips with first-name aliases in the names a reader was shown", () => {
    const shown = nameLabels("Team member A works with Team member B.", labels, editor);
    expect(labelNames(shown, labels, people)).toBe("Team member A works with Team member B.");
  });

  it("leaves a name that isn't in the map alone", () => {
    expect(labelNames("Rosa Diaz is away.", { "Team member A": MAYA }, people)).toBe("Rosa Diaz is away.");
  });
});

const finding = {
  id: "f1",
  title: "Team member A is the only one who can price work",
  evidence: "Team member A prices every pitch; Team member B never does.",
  why: "Team member A is on leave in March.",
  facts: [
    { kind: "fact", key: "capacity:person:1", text: "Team member A works 4 h/wk overtime. Simulated." },
    { kind: "quote", key: "Price it", text: "ask Team member B" },
  ],
  person_labels: { "Team member A": MAYA, "Team member B": ANN },
  rating: "bad",
};

describe("nameFinding", () => {
  it("names the title, evidence, why and every fact's text, and touches nothing else", () => {
    const out = nameFinding(finding, member);
    expect(out.title).toBe("Maya Collins is the only one who can price work");
    expect(out.evidence).toBe("Maya Collins prices every pitch; a team member never does.");
    expect(out.why).toBe("Maya Collins is on leave in March.");
    expect(out.facts).toEqual([
      { kind: "fact", key: "capacity:person:1", text: "Maya Collins works 4 h/wk overtime. Simulated." },
      { kind: "quote", key: "Price it", text: "ask a team member" },
    ]);
    expect({ ...out, title: "", evidence: "", why: "", facts: [] }).toEqual({ ...finding, title: "", evidence: "", why: "", facts: [] });
  });

  it("gives an editor the real names and returns a finding with no labels as it is", () => {
    expect(nameFinding(finding, editor).evidence).toBe("Maya Collins prices every pitch; Ann Lee never does.");
    const byHand = { ...finding, person_labels: {} };
    expect(nameFinding(byHand, member)).toBe(byHand);
  });

  it("gives a member the finding's row id as its ai_key, not the hash of its real-name title; an editor keeps the stored key", () => {
    const keyed = { ...finding, ai_key: "ai:insight:9f3a" };
    expect(nameFinding(keyed, member).ai_key).toBe(keyed.id);
    expect(nameFinding(keyed, stranger).ai_key).toBe(keyed.id);
    expect(nameFinding({ ...keyed, person_labels: {} }, member).ai_key).toBe(keyed.id);
    expect(nameFinding(keyed, editor).ai_key).toBe("ai:insight:9f3a");
    expect(nameFinding({ ...finding, ai_key: null }, member).ai_key).toBeNull();
  });

  it("round trips every stored text through labelNames for an editor", () => {
    const named = nameFinding(finding, editor);
    for (const k of ["title", "evidence", "why"] as const) expect(labelNames(named[k], readPersonLabels(finding.person_labels), people), k).toBe(finding[k]);
  });
});

describe("nameAnalysisRow", () => {
  const row = {
    id: "00000000-0000-4000-8000-0000000000a1",
    summary: ["Team member A is overloaded.", "Team member B is not."],
    insights: [{ key: "ai:insight:x", title: "Team member A at the cap", evidence: "Team member A works late.", why: "Team member B can't cover.", stepId: null, facts: [{ kind: "fact", key: "k", text: "Team member A: 4 h" }] }],
    review: [{ step: "job", level: "note", text: "Team member B owns it." }],
    reason: "Rejected: “Team member A earns more”",
    person_labels: { "Team member A": MAYA, "Team member B": ANN },
    status: "ok",
    checked: 3,
  };

  it("names the summary, insights, review and reason for a member, and nothing else", () => {
    const out = nameAnalysisRow(row, member);
    expect(out.summary).toEqual(["Maya Collins is overloaded.", "A team member is not."]);
    expect(out.insights).toEqual([
      { key: "ai:insight:00000000-0000-4000-8000-0000000000a1:0", title: "Maya Collins at the cap", evidence: "Maya Collins works late.", why: "A team member can't cover.", stepId: null, facts: [{ kind: "fact", key: "k", text: "Maya Collins: 4 h" }] },
    ]);
    expect(out.review).toEqual([{ step: "job", level: "note", text: "A team member owns it." }]);
    expect(out.reason).toBe("Rejected: “Maya Collins earns more”");
    expect(out.status).toBe("ok");
    expect(out.checked).toBe(3);
  });

  it("gives a member an opaque insight key, not the stored hash of a real-name title; an editor keeps the stored key", () => {
    const two = { ...row, insights: [...row.insights, { ...row.insights[0]!, key: "ai:insight:def456" }] };
    expect((nameAnalysisRow(two, member).insights as { key: string }[]).map((i) => i.key)).toEqual([`ai:insight:${row.id}:0`, `ai:insight:${row.id}:1`]);
    expect((nameAnalysisRow(two, stranger).insights as { key: string }[]).map((i) => i.key)).toEqual([`ai:insight:${row.id}:0`, `ai:insight:${row.id}:1`]);
    expect((nameAnalysisRow(two, editor).insights as { key: string }[]).map((i) => i.key)).toEqual(["ai:insight:x", "ai:insight:def456"]);
    // Also where the row uses no labels.
    expect((nameAnalysisRow({ ...two, person_labels: {} }, member).insights as { key: string }[])[0]!.key).toBe(`ai:insight:${row.id}:0`);
  });

  it("gives an editor the names, and keeps a null reason null", () => {
    expect(nameAnalysisRow({ ...row, reason: null }, editor).reason).toBeNull();
    expect(nameAnalysisRow(row, editor).summary).toEqual(["Maya Collins is overloaded.", "Ann Lee is not."]);
  });

  it("returns the row as it is when it uses no labels", () => {
    const plain = { ...row, person_labels: {} };
    expect(nameAnalysisRow(plain, editor)).toBe(plain);
    expect(nameAnalysisRow(plain, member)).toEqual({ ...plain, insights: [{ ...plain.insights[0]!, key: `ai:insight:${plain.id}:0` }] });
  });

  it("never shows a label's letters: a reader sees a name or 'A team member'", () => {
    for (const who of [editor, member, stranger]) expect(JSON.stringify({ ...nameAnalysisRow(row, who), person_labels: {} })).not.toMatch(/Team member [A-Z]/);
    expect(A_TEAM_MEMBER).toBe("A team member");
  });
});

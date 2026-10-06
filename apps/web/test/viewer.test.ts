import { describe, expect, it } from "vitest";
import { A_TEAM_MEMBER } from "@transpera-flow/db";
import { SEES_EVERYONE, canSeePerson, namedForViewer, ownRowsOnly, personName, viewerOf } from "@/lib/viewer";

// Who sees which person (B1 2b, issue #30): a bundle with no viewer sees everyone; a member sees their own person only.

const jess = "00000000-0000-4000-8000-000000000001";
const maya = "00000000-0000-4000-8000-000000000002";
const member = { seesEveryone: false, ownPersonId: jess };
const unlinked = { seesEveryone: false, ownPersonId: null };
const people = [
  { id: jess, name: "Jess Monroe" },
  { id: maya, name: "Maya Collins" },
];

describe("viewerOf", () => {
  it("is everyone for a bundle with no viewer (the demo, fixtures) and for no bundle", () => {
    expect(viewerOf({})).toEqual(SEES_EVERYONE);
    expect(viewerOf(undefined)).toEqual(SEES_EVERYONE);
    expect(viewerOf(null)).toEqual(SEES_EVERYONE);
  });
  it("is the bundle's own viewer when it has one", () => {
    expect(viewerOf({ viewer: member })).toBe(member);
  });
});

describe("canSeePerson", () => {
  it("sees everyone when the viewer does", () => {
    expect(canSeePerson(SEES_EVERYONE, maya)).toBe(true);
  });
  it("sees only their own person otherwise, and never a missing id", () => {
    expect(canSeePerson(member, jess)).toBe(true);
    expect(canSeePerson(member, maya)).toBe(false);
    expect(canSeePerson(member, null)).toBe(false);
    expect(canSeePerson(member, undefined)).toBe(false);
    expect(canSeePerson(unlinked, jess)).toBe(false);
    expect(canSeePerson(unlinked, null)).toBe(false);
  });
});

describe("personName", () => {
  it("gives their own name, and 'A team member' for anyone else", () => {
    expect(personName(member, jess, "Jess Monroe")).toBe("Jess Monroe");
    expect(personName(member, maya, "Team member 2")).toBe(A_TEAM_MEMBER);
    expect(personName(SEES_EVERYONE, maya, "Maya Collins")).toBe("Maya Collins");
  });
});

describe("namedForViewer", () => {
  it("renames other people only, keeping every other field", () => {
    const list = [{ ...people[0]!, fte: 1 }, { ...people[1]!, fte: 0.5 }];
    expect(namedForViewer(member, list)).toEqual([
      { id: jess, name: "Jess Monroe", fte: 1 },
      { id: maya, name: "A team member", fte: 0.5 },
    ]);
    expect(namedForViewer(SEES_EVERYONE, list)).toEqual(list);
  });
  it("names everyone 'A team member' for a member linked to no one", () => {
    expect(namedForViewer(unlinked, people).map((p) => p.name)).toEqual([A_TEAM_MEMBER, A_TEAM_MEMBER]);
  });
});

describe("ownRowsOnly", () => {
  const rows = [{ person: jess }, { person: maya }];
  it("keeps every row for a viewer who sees everyone", () => {
    expect(ownRowsOnly(SEES_EVERYONE, rows, (r) => r.person)).toEqual(rows);
  });
  it("keeps only the member's own row", () => {
    expect(ownRowsOnly(member, rows, (r) => r.person)).toEqual([{ person: jess }]);
  });
  it("keeps no row for a member with no person", () => {
    expect(ownRowsOnly(unlinked, rows, (r) => r.person)).toEqual([]);
  });
});

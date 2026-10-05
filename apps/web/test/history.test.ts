import { describe, expect, it } from "vitest";
import { demoHistory } from "@/lib/history/demo";
import {
  authorLabel,
  describeChanges,
  formatPublished,
  parseChanges,
  type RevisionChanges,
} from "@/lib/history/versions";
import { NORTHBEAM_PROCESS_ID, northbeamServicingProcessIds } from "@transpera-flow/db";

// Process history (issue #105): who published, what changed, and the demo's versions.

const none = { added: 0, removed: 0, changed: 0 };
const changes = (c: Partial<RevisionChanges>): RevisionChanges => ({ steps: none, edges: none, ...c });

describe("authorLabel", () => {
  it("says Claude (MCP) for a publish through MCP, whatever the token's owner is called", () => {
    expect(authorLabel({ authorKind: "mcp", authorName: "Priya Shah" })).toBe("Claude (MCP)");
  });
  it("names the person, or a team member when the workspace has no name for them", () => {
    expect(authorLabel({ authorKind: "user", authorName: "Priya Shah" })).toBe("Priya Shah");
    expect(authorLabel({ authorKind: "user", authorName: null })).toBe("A team member");
  });
  it("calls a version nobody recorded as imported", () => {
    expect(authorLabel({ authorKind: null, authorName: null })).toBe("Imported");
    expect(authorLabel({ authorKind: "system", authorName: null })).toBe("System");
  });
});

describe("describeChanges", () => {
  it("counts steps and connections in plain words, with the noun on every part", () => {
    expect(describeChanges(changes({ steps: { added: 1, removed: 0, changed: 2 }, edges: { added: 3, removed: 1, changed: 1 } }), false)).toBe(
      "2 steps changed, 1 step added, 1 connection changed, 3 connections added, 1 connection removed",
    );
    expect(describeChanges(changes({ steps: { added: 3, removed: 0, changed: 0 }, edges: { added: 0, removed: 1, changed: 0 } }), false)).toBe("3 steps added, 1 connection removed");
  });
  it("says only 'First version' for the oldest version, whatever its counts (everything in it is new)", () => {
    expect(describeChanges(changes({ steps: { added: 7, removed: 0, changed: 0 }, edges: { added: 7, removed: 0, changed: 0 } }), true)).toBe("First version");
    expect(describeChanges(null, true)).toBe("First version");
  });
  it("says so when a version changed nothing, and when changes weren't recorded", () => {
    expect(describeChanges(changes({}), false)).toBe("Nothing changed (published again as it was)");
    expect(describeChanges(null, false)).toBe("Changes weren't recorded");
  });
});

describe("parseChanges", () => {
  it("reads the counts and ignores anything else", () => {
    expect(parseChanges({ steps: { added: 1, removed: 0, changed: 2 }, edges: { added: "x", removed: -1, changed: 4.7 } })).toEqual({
      steps: { added: 1, removed: 0, changed: 2 },
      edges: { added: 0, removed: 0, changed: 4 },
    });
    expect(parseChanges(null)).toBeNull();
    expect(parseChanges({})).toEqual({ steps: none, edges: none });
  });
});

describe("formatPublished", () => {
  it("prints the UTC day", () => {
    expect(formatPublished("2026-09-29T23:30:00Z")).toBe("29 Sep 2026");
    expect(formatPublished(null)).toBe("–");
  });
});

describe("demo history", () => {
  const history = demoHistory(NORTHBEAM_PROCESS_ID)!;

  it("has four versions, newest first, the newest live, ", () => {
    expect(history.versions.map((v) => [v.number, v.live])).toEqual([
      [4, true],
      [3, false],
      [2, false],
      [1, false],
    ]);
    expect(history.versions.map((v) => authorLabel(v))).toEqual(["Priya Shah", "Claude (MCP)", "Maya Collins", "Priya Shah"]);
  });
  it("works out each version's changes from its steps; the first has none to compare", () => {
    const byNumber = Object.fromEntries(history.versions.map((v) => [v.number, v]));
    expect(byNumber[1]!.changes).toBeNull();
    expect(byNumber[4]!.changes!.steps.changed).toBe(3);
    expect(describeChanges(byNumber[4]!.changes, false)).toBe("3 steps changed");
  });
  it("knows its servicing processes too, and nothing else", () => {
    for (const id of Object.values(northbeamServicingProcessIds)) expect(demoHistory(id)).not.toBeNull();
    expect(demoHistory(Object.values(northbeamServicingProcessIds)[0]!)!.kind).toBe("servicing");
    expect(demoHistory("not-a-process")).toBeNull();
  });
});

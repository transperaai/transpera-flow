import { describe, expect, it, vi } from "vitest";
import { larkspurBundle, type ProcessBundle } from "@transpera-flow/db";
import { analysisBaseHash } from "@/lib/ai/model-hash";
import { neutralBundle, payFreeBundle } from "@/lib/ai/neutral";

vi.mock("server-only", () => ({}));

// An analysis is "out of date" once what it read has changed (B17). A member's page builds its bundle from `team_capacity`
// (labels, no pay), so before B1 2b every analysis read as out of date to a member. The hash reads neither names nor pay, so an
// editor's page and a member's agree (B1 2b, issue #30).

const READS = { readSources: false, model: "claude-opus-5-5" };

/** The bundle as `team_capacity` hands it to a member linked to `ownIndex`: their own name, "Team member N" and no rate for the others. */
function asMember(bundle: ProcessBundle, ownIndex: number): ProcessBundle {
  const own = bundle.people[ownIndex]!;
  return {
    ...bundle,
    people: bundle.people.map((p, i) => (p.id === own.id ? p : { ...p, name: `Team member ${i + 1}`, cost_rate: null, provenance: {} })),
    viewer: { seesEveryone: false, ownPersonId: own.id },
  };
}

describe("analysisBaseHash", () => {
  const editor = larkspurBundle();

  it("is equal for an editor's bundle and a member's", () => {
    const hash = analysisBaseHash(editor, null, "process", READS);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    for (const i of [0, 3, editor.people.length - 1]) expect(analysisBaseHash(asMember(editor, i), null, "process", READS), `member ${i}`).toBe(hash);
    // A member linked to no one, too.
    expect(analysisBaseHash({ ...asMember(editor, 0), viewer: { seesEveryone: false, ownPersonId: null } }, null, "process", READS)).toBe(hash);
  });

  it("still changes when something that was entered changes: a person's hours, a step, the scope", () => {
    const hash = analysisBaseHash(editor, null, "process", READS);
    const fewerHours = { ...editor, people: editor.people.map((p, i) => (i === 0 ? { ...p, capacity_hours_week: 12 } : p)) };
    expect(analysisBaseHash(fewerHours, null, "process", READS)).not.toBe(hash);
    expect(analysisBaseHash(editor, null, "company", READS)).not.toBe(hash);
    expect(analysisBaseHash({ ...editor, steps: editor.steps.map((s, i) => (i === 2 ? { ...s, work_hours: 9 } : s)) }, null, "process", READS)).not.toBe(hash);
  });

  it("ignores a person's rate and name, which a member never has", () => {
    const hash = analysisBaseHash(editor, null, "process", READS);
    const renamed = { ...editor, people: editor.people.map((p) => ({ ...p, name: `Someone ${p.id.slice(-4)}`, cost_rate: 123 })) };
    expect(analysisBaseHash(renamed, null, "process", READS)).toBe(hash);
  });
});

describe("payFreeBundle and neutralBundle", () => {
  const bundle = larkspurBundle();

  it("payFreeBundle is the bundle as a member's browser builds it: the viewer sees no one's pay", () => {
    const free = payFreeBundle(bundle);
    expect(free.viewer).toEqual({ seesEveryone: false, ownPersonId: null });
    expect(free.people).toBe(bundle.people);
    expect(bundle.viewer).toBeUndefined();
  });

  it("neutralBundle also names everyone by id, and leaves the original alone", () => {
    const neutral = neutralBundle(bundle);
    expect(neutral.people.every((p, i) => p.name === bundle.people[i]!.id)).toBe(true);
    expect(bundle.people[0]!.name).not.toBe(bundle.people[0]!.id);
  });
});

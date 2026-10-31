import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PURPOSES, FIXED_PURPOSES, newPurposeKey, parsePurposes, resolvePurpose, workspacePurposes, type PurposeCategory } from "../src";
import { createTestDb, type TestDb } from "./harness";

// What a step achieves (sandbox phase 4): the pure rules, and the one table of cases that parsePurposes and
// private.is_purpose_list must agree on.

const keys = new Set(DEFAULT_PURPOSES.map((c) => c.key));
const step = (purpose: string | null, id = "s1") => ({ id, purpose });

describe("resolvePurpose", () => {
  it("a chosen key in the list wins", () => {
    expect(resolvePurpose(step("coordination"), "pipeline", keys)).toEqual({ key: "coordination", source: "chosen" });
  });
  it("a step with no chosen key follows its process", () => {
    expect(resolvePurpose(step(null), "servicing", keys)).toEqual({ key: "client_job", source: "process_kind" });
    expect(resolvePurpose(step(null), "pipeline", keys)).toEqual({ key: "winning", source: "process_kind" });
  });
  it("a pipeline step after the sale moves the client's job forward (the deciding step is not after, so it stays winning work)", () => {
    expect(resolvePurpose(step(null), "pipeline", keys, true)).toEqual({ key: "client_job", source: "process_kind" });
    expect(resolvePurpose(step(null), "pipeline", keys, false)).toEqual({ key: "winning", source: "process_kind" });
  });
  it("a stored key the list no longer has reads as Automatic, saying why", () => {
    expect(resolvePurpose(step("required"), "pipeline", new Set([...keys].filter((k) => k !== "required")))).toEqual({ key: "winning", source: "deleted_category" });
    expect(resolvePurpose(step("c0000abcd"), "servicing", keys)).toEqual({ key: "client_job", source: "deleted_category" });
  });
  it("client upkeep is never a step's purpose", () => {
    expect(resolvePurpose(step("client_upkeep"), "pipeline", keys).source).toBe("deleted_category");
  });
});

describe("workspacePurposes", () => {
  it("absent, null, invalid: the defaults", () => {
    expect(workspacePurposes({})).toEqual(DEFAULT_PURPOSES);
    expect(workspacePurposes({ purposes: null })).toEqual(DEFAULT_PURPOSES);
    expect(workspacePurposes({ purposes: "junk" as never })).toEqual(DEFAULT_PURPOSES);
    expect(workspacePurposes({ purposes: DEFAULT_PURPOSES.slice(2) as never })).toEqual(DEFAULT_PURPOSES);
  });
  it("a valid list is kept, in its order, renamed", () => {
    const list = [...DEFAULT_PURPOSES].reverse().map((c) => (c.key === "winning" ? { ...c, name: "Sales" } : c));
    expect(workspacePurposes({ purposes: list })).toEqual(list);
  });
  it("the defaults carry the five fixed categories", () => {
    for (const k of FIXED_PURPOSES) expect(keys.has(k)).toBe(true);
    expect(DEFAULT_PURPOSES.map((c) => c.name)).toContain("Client upkeep");
  });
  it("new keys look like c + 8 hex and avoid a clash", () => {
    const a = newPurposeKey();
    expect(a).toMatch(/^c[0-9a-f]{8}$/);
    expect(newPurposeKey([a])).not.toBe(a);
  });
});

const defaults = (): PurposeCategory[] => DEFAULT_PURPOSES.map((c) => ({ ...c }));
const extra = (n: number): PurposeCategory[] => Array.from({ length: n }, (_, i) => ({ key: `c${String(i).padStart(8, "0")}`, name: `Extra ${i}`, description: "" }));
const without = (key: string) => defaults().filter((c) => c.key !== key);

const CASES: [string, unknown, boolean][] = [
  ["the defaults", defaults(), true],
  ["the defaults reordered", defaults().reverse(), true],
  ["twelve items", [...defaults(), ...extra(5)], true],
  ["thirteen items", [...defaults(), ...extra(6)], false],
  ["four items", [...defaults()].slice(0, 4), false],
  ["five items, only the fixed ones", defaults().filter((c) => (FIXED_PURPOSES as readonly string[]).includes(c.key)), true],
  ["a missing fixed key: fixing", without("fixing"), false],
  ["a missing fixed key: client_upkeep", without("client_upkeep"), false],
  ["a deletable one removed", without("required"), true],
  ["a duplicate key", [...defaults().slice(0, 6), { key: "winning", name: "Again", description: "" }], false],
  ["a duplicate name ignoring case and spaces", [...defaults().slice(0, 6), { key: "c00000001", name: "  WINNING work ", description: "" }], false],
  ["a 60-character name", [...defaults(), { key: "c00000001", name: "n".repeat(60), description: "" }], true],
  ["a 61-character name", [...defaults(), { key: "c00000001", name: "n".repeat(61), description: "" }], false],
  // The database counts characters (code points) and trims spaces only: a list it accepts must read back, not fall to the defaults.
  ["a 60-emoji name", [...defaults(), { key: "c00000001", name: "🙂".repeat(60), description: "" }], true],
  ["a 61-emoji name", [...defaults(), { key: "c00000001", name: "🙂".repeat(61), description: "" }], false],
  ["a name that differs from another by a tab", [...without("coordination"), { key: "c00000001", name: "\tWinning work", description: "" }], true],
  ["a 200-emoji description", [...defaults(), { key: "c00000001", name: "X", description: "🙂".repeat(200) }], true],
  ["an empty name", [...defaults(), { key: "c00000001", name: "   ", description: "" }], false],
  ["a 200-character description", [...defaults(), { key: "c00000001", name: "X", description: "d".repeat(200) }], true],
  ["a 201-character description", [...defaults(), { key: "c00000001", name: "X", description: "d".repeat(201) }], false],
  ["an extra field", [...defaults(), { key: "c00000001", name: "X", description: "", color: "red" }], false],
  ["a c key with 7 hex", [...defaults(), { key: "c0000001", name: "X", description: "" }], false],
  ["a c key with upper-case hex", [...defaults(), { key: "c0000000A", name: "X", description: "" }], false],
  ["a made-up word key", [...defaults(), { key: "other", name: "X", description: "" }], false],
  ["not an array: a string", "junk", false],
  ["not an array: an object", { key: "winning" }, false],
  ["an item that is not an object", [...defaults(), "x"], false],
  ["a numeric name", [...defaults(), { key: "c00000001", name: 5, description: "" }], false],
];

describe("parsePurposes and private.is_purpose_list agree", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb({ seed: false });
  });
  afterAll(async () => {
    await db?.close();
  });
  for (const [name, input, ok] of CASES) {
    it(`${name}: ${ok ? "accepted" : "refused"} by both`, async () => {
      expect(parsePurposes(input).ok).toBe(ok);
      const { rows } = await db.client.query("select private.is_purpose_list($1::jsonb) as ok", [JSON.stringify(input)]);
      expect(rows[0].ok).toBe(ok);
    });
  }
  it("a list that is accepted comes back trimmed and unchanged otherwise", () => {
    const r = parsePurposes(defaults().map((c) => ({ ...c, name: ` ${c.name} ` })));
    expect(r.ok && r.purposes).toEqual(defaults());
  });
});

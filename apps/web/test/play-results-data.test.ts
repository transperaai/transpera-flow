import { describe, expect, it } from "vitest";
import type { PlayTeamLine } from "@transpera-flow/db";
import { busyTone, heatRows, purposeMoves, signedCount, signedHours, signedMoney, worstMonth, type PurposeSlice } from "@/lib/sandbox/play-results-data";

// What the Sandbox's result charts read (D54): the Capacity page's busy cut-offs, the heatmap's rows, the purposes that moved and the signed numbers.

const team = (id: string, values: (number | null)[], p90: (number | null)[] = values, line = 0.85): PlayTeamLine => ({ id, name: id.toUpperCase(), line, values, p90 });
const slice = (id: string, hours: number): PurposeSlice => ({ id, name: id, hours });

describe("busyTone", () => {
  it("is ok under the line, warn within ten points, bad at or over it", () => {
    expect(busyTone(0.7, 0.85)).toBe("ok");
    expect(busyTone(0.75, 0.85)).toBe("warn");
    expect(busyTone(0.85, 0.85)).toBe("bad");
    expect(busyTone(0.99, 0.85)).toBe("bad");
  });
});

describe("heatRows", () => {
  it("keeps the scene's order and takes the numbers of the run asked for, nulls for a team missing there", () => {
    const scene = [team("b", [0.9, 0.9]), team("a", [0.5, 0.5])];
    const today = [team("a", [0.4, 0.4], [0.6, 0.6])];
    const rows = heatRows(scene, today);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[0]!.busy).toEqual([null, null]);
    expect(rows[1]!.busy).toEqual([0.4, 0.4]);
    expect(rows[1]!.p90).toEqual([0.6, 0.6]);
    expect(rows[1]!.line).toBe(0.85);
  });
});

describe("purposeMoves", () => {
  it("lists the biggest moves first, up to three, and ignores under half an hour", () => {
    const today = [slice("fixing", 100), slice("coordination", 50), slice("winning", 30), slice("required", 20), slice("removable", 10)];
    const scene = [slice("fixing", 60), slice("coordination", 38), slice("winning", 30.2), slice("required", 25), slice("removable", 14)];
    expect(purposeMoves(today, scene).map((m) => [m.id, Math.round(m.delta)])).toEqual([
      ["fixing", -40],
      ["coordination", -12],
      ["required", 5],
    ]);
    expect(purposeMoves(today, today)).toEqual([]);
  });
});

describe("signed numbers", () => {
  it("uses a real minus and a plus for no change", () => {
    expect(signedCount(0)).toBe("+0");
    expect(signedCount(-2.4)).toBe("−2");
    expect(signedCount(3.6)).toBe("+4");
    expect(signedMoney(0, (v) => `A$${v}`)).toBe("+A$0");
    expect(signedMoney(-4000, (v) => `A$${v}`)).toBe("−A$4000");
    expect(signedHours(-40.2)).toBe("−40 h");
    expect(signedHours(12)).toBe("+12 h");
  });
});

describe("the worst month (QA round 2, A1)", () => {
  const p = (roleId: string, line: number, busy: (number | null)[]) => ({ roleId, line, busy });
  const names: Record<string, string> = { strat: "Strategists", ppc: "PPC managers" };
  it("is the month with the most people over their own threshold, the first on a tie, with the teams over, most first", () => {
    const people = [p("strat", 0.85, [0.9, 0.9, 0.7]), p("strat", 0.85, [0.5, 0.86, 0.9]), p("ppc", 0.8, [0.5, 0.8, 0.9]), p("ppc", 0.9, [null, 0.95, 0.6])];
    expect(worstMonth(people, 3, (id) => names[id])).toEqual({
      month: 1,
      count: 4,
      teams: [
        { id: "ppc", name: "PPC managers", count: 2 },
        { id: "strat", name: "Strategists", count: 2 },
      ],
    });
    // Only the months asked for count, and a tie goes to the first month.
    expect(worstMonth(people, 1, (id) => names[id])).toMatchObject({ month: 0, count: 1 });
    expect(worstMonth([p("x", 0.5, [0.6, 0.6])], 2, () => undefined)).toMatchObject({ month: 0, teams: [{ name: "Other", count: 1 }] });
  });
  it("is null when nobody is over", () => {
    expect(worstMonth([p("strat", 0.85, [0.84, null])], 2, (id) => names[id])).toBeNull();
  });
});

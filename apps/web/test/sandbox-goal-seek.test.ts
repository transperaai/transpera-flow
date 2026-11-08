import { describe, expect, it } from "vitest";
import { MAX_RUNS, addResult, answer, markAsked, maxRunsFor, monotone, nextProbes, startSearch, type SeekSpec, type SeekState } from "@/lib/sandbox/goal-seek";

// Goal seek's search (sandbox phase 5b) on fabricated measures: the state machine never runs anything, so a function stands in for the run.

const atMost = (limit: number) => ({ meets: (v: number) => v <= limit, gap: (v: number) => Math.max(0, v - limit) });
const atLeast = (limit: number) => ({ meets: (v: number) => v >= limit, gap: (v: number) => Math.max(0, limit - v) });
const spec = (over: Partial<SeekSpec>): SeekSpec => ({ lo: 0, hi: 10, step: 1, whole: true, today: 0, ...atMost(0.85), ...over });

/** Drive a search the way the dialog does: ask, run, answer, until nothing is left to ask. Returns the order the values were run in. */
function drive(s0: SeekState, f: (x: number) => number | null) {
  let s = s0;
  const ran: number[][] = [];
  for (let guard = 0; guard < 20; guard++) {
    const xs = nextProbes(s);
    if (!xs.length) break;
    ran.push(xs);
    s = markAsked(s, xs);
    for (const x of xs) s = addResult(s, x, f(x));
  }
  return { s, ran, runs: ran.flat().length, a: answer(s) };
}

describe("goal seek's search", () => {
  it("probes both ends together, then one value at a time", () => {
    const { ran } = drive(startSearch(spec({})), (x) => 1 - 0.06 * x);
    expect(ran[0]).toEqual([0, 10]);
    expect(ran.slice(1).every((r) => r.length === 1)).toBe(true);
  });

  it("whole people: finds the least number that meets the target within 6 runs over 0 to 10", () => {
    // busy = 1 - 0.06x <= 0.85 from x = 2.5, so 3 people.
    const { a, runs } = drive(startSearch(spec({})), (x) => 1 - 0.06 * x);
    expect(a).toMatchObject({ kind: "boundary", x: 3, failsAt: 2, side: "high", monotone: { ok: true } });
    expect(runs).toBeLessThanOrEqual(6);
  });

  it("every whole boundary over 0 to 10 is found exactly, in at most 6 runs", () => {
    for (let want = 1; want <= 10; want++) {
      const { a, runs } = drive(startSearch(spec({})), (x) => (x >= want ? 0.5 : 0.95));
      expect(a, `boundary ${want}`).toMatchObject({ kind: "boundary", x: want });
      expect(runs).toBeLessThanOrEqual(6);
    }
  });

  it("a lever where less meets the target (churn rises with the fee): the boundary is on the low side", () => {
    // churn = 0.02 + 0.001 * pct <= 0.03 up to +10 points; range -10..+30 step 1.
    const { a, runs } = drive(startSearch(spec({ lo: -10, hi: 30, step: 1, whole: true, today: 0, ...atMost(0.03) })), (x) => 0.02 + 0.001 * x);
    expect(a).toMatchObject({ kind: "boundary", x: 10, side: "low" });
    expect(runs).toBeLessThanOrEqual(MAX_RUNS);
  });

  it("both ends meet: already met, and the least change is the end nearest today's value", () => {
    const { a, runs } = drive(startSearch(spec({ lo: 1, hi: 9, today: 7 })), () => 0.5);
    expect(a).toMatchObject({ kind: "already", x: 9 });
    expect(runs).toBe(2);
    expect(drive(startSearch(spec({ lo: 1, hi: 9, today: 2 })), () => 0.5).a).toMatchObject({ kind: "already", x: 1 });
  });

  it("neither end meets: not reachable, and the closest value is named", () => {
    const { a, runs } = drive(startSearch(spec({})), (x) => 1.2 - 0.01 * x);
    expect(a).toMatchObject({ kind: "unreachable", closest: { x: 10 } });
    expect(runs).toBe(2);
  });

  it("a continuous lever stops after 8 runs in all, with the best value known so far", () => {
    // Price rise -20..+50 points in steps of 0.01 would need 13 bisections; 6 after the ends is all it gets.
    const { a, runs, s } = drive(startSearch(spec({ lo: -0.2, hi: 0.5, step: 0.01, whole: false, today: 0, ...atMost(0.03) })), (x) => 0.02 + 0.1 * (x + 0.2));
    expect(runs).toBe(MAX_RUNS);
    expect(a.kind).toBe("boundary");
    if (a.kind === "boundary") {
      // True boundary: x = -0.1, met below it. The answer is on the meeting side, within the width left after 6 halvings of 0.7.
      expect(a.side).toBe("low");
      expect(a.x).toBeLessThanOrEqual(-0.1 + 1e-9);
      expect(a.x).toBeGreaterThanOrEqual(-0.1 - 0.7 / 64 - 0.01);
      expect(Math.abs(a.x - a.failsAt)).toBeLessThanOrEqual(0.7 / 64 + 0.01);
    }
    expect(s.probes).toHaveLength(MAX_RUNS);
  });

  it("a continuous lever with a coarse range stops when the two sides are one step apart", () => {
    // 0.9 to 1.3 in steps of 0.1: 4 steps, so 2 more probes after the ends.
    const { runs, a } = drive(startSearch(spec({ lo: 0.9, hi: 1.3, step: 0.1, whole: false, today: 1, ...atLeast(1.12) })), (x) => x);
    expect(runs).toBeLessThanOrEqual(5);
    expect(a).toMatchObject({ kind: "boundary", x: 1.2 });
  });

  it("rounds every probe to the lever's step", () => {
    const { s } = drive(startSearch(spec({ lo: 0, hi: 1, step: 0.05, whole: false, ...atMost(0.5) })), (x) => x);
    for (const p of s.probes) expect(Math.abs(p.x / 0.05 - Math.round(p.x / 0.05))).toBeLessThan(1e-9);
  });

  it("a run that has no number (no costs) is reported, not guessed", () => {
    expect(drive(startSearch(spec({})), () => null).a).toMatchObject({ kind: "cannot" });
  });

  it("reports running until the ends are in, and counts the 'about N runs' honestly", () => {
    const s = startSearch(spec({}));
    expect(answer(s)).toMatchObject({ kind: "running" });
    expect(maxRunsFor({ lo: 0, hi: 10, step: 1, whole: true })).toBe(6);
    expect(maxRunsFor({ lo: -0.2, hi: 0.5, step: 0.01, whole: false })).toBe(MAX_RUNS);
    expect(maxRunsFor({ lo: 0, hi: 1, step: 1, whole: true })).toBe(2);
  });

  it("flags a measure that doesn't move steadily, with where it turned, and still answers", () => {
    // busy falls, then rises between 3 and 4 people (a hire that pulls work onto a new person), then is lower again at 5.
    const table: Record<number, number> = { 0: 1.0, 10: 0.7, 5: 0.8, 3: 0.9, 4: 0.95 };
    const { a } = drive(startSearch(spec({})), (x) => table[x] ?? 0.8);
    expect(a.kind).toBe("boundary");
    if (a.kind === "boundary") {
      expect(a.monotone.ok).toBe(false);
      if (!a.monotone.ok) {
        expect(a.monotone.direction).toBe("rose");
        expect(a.monotone.between[0]).toBeLessThan(a.monotone.between[1]);
      }
    }
  });

  it("noise inside the tolerance is not a turn (1% of the span; half a point for a share)", () => {
    let s = startSearch(spec({}));
    for (const [x, v] of [[0, 1.0], [5, 0.7], [10, 0.4], [7, 0.5]] as const) s = addResult(s, x, v);
    expect(monotone(s)).toEqual({ ok: true });
    // A tiny rise of 0.002 on a span of 0.6 is within 1% (0.006).
    s = addResult(s, 8, 0.482);
    expect(monotone(s).ok).toBe(true);
    let t = startSearch(spec({ share: true }));
    for (const [x, v] of [[0, 0.9], [5, 0.6], [6, 0.603], [10, 0.3]] as const) t = addResult(t, x, v);
    expect(monotone(t).ok).toBe(true);
    t = addResult(t, 7, 0.62);
    expect(monotone(t).ok).toBe(false);
  });
});

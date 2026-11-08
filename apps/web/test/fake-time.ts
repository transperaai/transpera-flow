import type { MonthlyResult, Stat, TimeSplit } from "@transpera-flow/engine";

const stat = (mean: number, spread = 0.1): Stat => ({ mean, p10: mean - spread, p90: mean + spread });

/** A hand-made `TimeSplit` of `n` months, moving with `level` so a splice shows which run a month came from. */
export function fakeSplit(n: number, level: number, uncovered = false): TimeSplit {
  const series = (f: (i: number) => number) => Array.from({ length: n }, (_, i) => stat(f(i)));
  return {
    purpose: { client_job: series(() => level * 10), winning: series(() => level * 4), fixing: series(() => level * 2) },
    rework: series(() => level),
    withRework: { client_job: series(() => level * 11), winning: series(() => level * 5), fixing: series(() => level * 3) },
    ongoing: series(() => level * 3),
    idle: series(() => 10),
    hours: series(() => level * 10 + level * 4 + level * 2 + level + level * 3 + 10),
    uncovered: uncovered ? series(() => 5) : null,
  };
}

/** `MonthlyResult.time` for a hand-made result: team, role `r` and person `p`. */
export function fakeTime(n: number, level: number): MonthlyResult["time"] {
  return {
    purposes: ["client_job", "winning", "fixing"],
    roles: { r: fakeSplit(n, level, true) },
    people: { p: fakeSplit(n, level) },
    team: fakeSplit(n, level, true),
  };
}

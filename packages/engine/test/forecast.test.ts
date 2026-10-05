import { describe, expect, it } from "vitest";
import {
  forecastAlerts,
  firstCrossing,
  larkspurModel,
  northbeamModel,
  northbeamWithClientGroups,
  northbeamWithServicing,
  ruleOfFinding,
  simulate,
  type EngineModel,
  type EnginePerson,
  type MonthBusy,
  type SimulationResult,
} from "../src";

// The forecast (issue #35, B6): a run month by month, and "who gets too busy, and when" from it.

const HPW = 40;
const MONTH = (52 / 12) * HPW;
const months = (n: number) => Math.round((n * 52) / 12);

const busy = (mean: number, p90 = mean): MonthBusy => ({ mean, p10: mean, p90, capacity: 40, work: mean * 40 });

/** A run's numbers without the month-by-month part, to compare with a run that wasn't asked for it. */
const withoutMonthly = ({ monthly: _monthly, ...rest }: SimulationResult) => rest;

/** Northbeam with named people instead of head-counts, the pooled client load, and `extra` people or changes. */
function named(extra: Record<string, Partial<EnginePerson> & { roles?: string[] }> = {}, weeks = months(12)): EngineModel {
  const base = northbeamModel();
  const people: Record<string, EnginePerson> = {};
  for (const [rid, role] of Object.entries(base.roles)) {
    for (let i = 1; i <= role.count; i++) people[`${rid}-${i}`] = { name: `${role.name} ${i}`, roles: [rid], capacity: base.hoursPerWeek };
  }
  for (const [id, p] of Object.entries(extra)) people[id] = { name: id, roles: [], capacity: base.hoursPerWeek, ...people[id], ...p };
  return { ...base, horizonWeeks: weeks, people };
}

describe("a run month by month", () => {
  it("is only there when asked for, and asking changes no other number", () => {
    for (const model of [northbeamWithServicing(), larkspurModel(), northbeamWithClientGroups()]) {
      const plain = simulate(model, 10, 1);
      const monthly = simulate(model, 10, 1, { monthly: true });
      expect(plain.monthly).toBeUndefined();
      expect(monthly.monthly).toBeDefined();
      expect(withoutMonthly(monthly)).toEqual(plain);
    }
  });

  it("is deterministic for a seed", () => {
    const m = { ...northbeamWithClientGroups(), horizonWeeks: months(6) };
    expect(simulate(m, 10, 3, { monthly: true }).monthly).toEqual(simulate(m, 10, 3, { monthly: true }).monthly);
  });

  it("has one entry per month of the horizon, the last ending at the horizon", () => {
    for (const [weeks, n] of [[4, 1], [13, 3], [26, 6], [52, 12], [104, 24]] as const) {
      const r = simulate({ ...northbeamModel(), horizonWeeks: weeks }, 3, 1, { monthly: true });
      const mo = r.monthly!;
      expect(mo.months).toHaveLength(n);
      expect(mo.months[0]!.start).toBe(0);
      expect(mo.months.at(-1)!.end).toBe(weeks * HPW);
      for (const series of Object.values(mo.roles)) expect(series).toHaveLength(n);
      expect(mo.lateTasks).toHaveLength(n);
    }
  });

  it("adds up to the run's own busy share over the year (no leave or planned changes)", () => {
    const m = { ...northbeamWithClientGroups(), horizonWeeks: months(12) };
    const r = simulate(m, 20, 1, { monthly: true });
    for (const rid of Object.keys(m.roles)) {
      const series = r.monthly!.roles[rid]!;
      const weeks = r.monthly!.months.map((x) => (x.end - x.start) / HPW);
      const work = series.reduce((a, s, i) => a + s!.work * weeks[i]!, 0);
      const cap = series.reduce((a, s, i) => a + s!.capacity * weeks[i]!, 0);
      // Work booked when it starts (the run) versus spread over the time it is worked (the months): close, not equal.
      expect(Math.abs(work / cap - r.kpi.roles[rid]!.util.mean)).toBeLessThan(0.03);
      expect(series[0]!.capacity).toBeCloseTo(r.resolvedPeople ? Object.values(r.resolvedPeople).filter((p) => p.roles.includes(rid)).reduce((a, p) => a + p.capacity, 0) : 0, 6);
    }
  });

  it("follows demand that grows: later months are busier, and active clients climb", () => {
    const m: EngineModel = { ...northbeamModel(), horizonWeeks: months(12), demand: { growthMonthly: 0.05 } };
    const mo = simulate(m, 20, 1, { monthly: true }).monthly!;
    expect(mo.roles.ppc![11]!.mean).toBeGreaterThan(mo.roles.ppc![0]!.mean + 0.2);
    expect(mo.clients[""]![11]!.mean).toBeGreaterThan(mo.clients[""]![0]!.mean + 10);
  });

  it("counts active clients by service with client groups, and late client tasks with servicing", () => {
    const mo = simulate({ ...northbeamWithClientGroups(), horizonWeeks: months(6) }, 10, 1, { monthly: true }).monthly!;
    expect(Object.keys(mo.clients).sort()).toEqual(["ppc", "seo"]);
    expect(mo.clients.seo![0]!.mean).toBeGreaterThan(15);
    expect(mo.lateTasks.some((s) => s.mean > 0)).toBe(true);
  });
});

describe("planned hires and leave change capacity in the right months", () => {
  it("a planned hire adds nothing before their start, and their hours from that month on", () => {
    const start = 6 * MONTH;
    const r = simulate(named({ "ppc-3": { roles: ["ppc"], from: start } }), 20, 1, { monthly: true });
    const role = r.monthly!.roles.ppc!;
    const hire = r.monthly!.people["ppc-3"]!;
    for (let m = 0; m < 6; m++) {
      expect(role[m]!.capacity).toBeCloseTo(80, 6);
      expect(hire[m]).toBeNull();
    }
    for (let m = 6; m < 12; m++) {
      expect(role[m]!.capacity).toBeCloseTo(120, 6);
      expect(hire[m]!.mean).toBeGreaterThan(0.3);
    }
    // The team is busier before the hire than after it.
    expect(role[5]!.mean).toBeGreaterThan(role[6]!.mean + 0.1);
    // They take no work before their start.
    const trace = simulate(named({ "ppc-3": { roles: ["ppc"], from: start } }), 1, 1).trace!;
    const theirs = trace.flatMap((e) => e.trace.filter((s) => s.person === "ppc-3"));
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((s) => s.tS! >= start)).toBe(true);
  });

  it("a planned hire carries none of the clients' work before their start, so the others carry it all", () => {
    const withHire = simulate(named({ "ppc-3": { roles: ["ppc"], from: 6 * MONTH } }), 20, 1, { monthly: true }).monthly!;
    const without = simulate(named(), 20, 1, { monthly: true }).monthly!;
    // Before the start, the two who are there face the same work as with no hire planned at all.
    for (let m = 0; m < 5; m++) expect(Math.abs(withHire.people["ppc-1"]![m]!.mean - without.people["ppc-1"]![m]!.mean)).toBeLessThan(0.03);
    expect(withHire.people["ppc-1"]![8]!.mean).toBeLessThan(without.people["ppc-1"]![8]!.mean - 0.1);
  });

  it("someone leaving for good takes their hours away from that month on", () => {
    const r = simulate(named({ "seo-3": { until: 3 * MONTH } }), 20, 1, { monthly: true });
    const role = r.monthly!.roles.seo!;
    expect(role[2]!.capacity).toBeCloseTo(120, 6);
    expect(role[3]!.capacity).toBeCloseTo(80, 6);
    expect(r.monthly!.people["seo-3"]![3]).toBeNull();
    expect(role[4]!.mean).toBeGreaterThan(role[1]!.mean + 0.1);
  });

  it("leave takes a person's hours away in the months it falls in, and their client work goes to the colleagues there", () => {
    const leave: [number, number] = [4 * MONTH, 5 * MONTH];
    const r = simulate(named({ "am-1": { leave: [leave] } }), 20, 1, { monthly: true });
    const base = simulate(named(), 20, 1, { monthly: true });
    const role = r.monthly!.roles.am!;
    expect(role[3]!.capacity).toBeCloseTo(80, 6);
    expect(role[4]!.capacity).toBeCloseTo(40, 6);
    expect(r.monthly!.people["am-1"]![4]).toBeNull();
    // The role is busier that month, and so is the colleague who covers.
    expect(role[4]!.mean).toBeGreaterThan(base.monthly!.roles.am![4]!.mean + 0.2);
    expect(r.monthly!.people["am-2"]![4]!.mean).toBeGreaterThan(base.monthly!.people["am-2"]![4]!.mean + 0.2);
    // The role's work that month is all still there.
    expect(Math.abs(role[4]!.work - base.monthly!.roles.am![4]!.work)).toBeLessThan(base.monthly!.roles.am![4]!.work * 0.1);
  });

  it("a start before the run, or an end date after it, changes nothing", () => {
    const plain = named();
    const early = named({ "ppc-1": { from: -1e9, until: 1e9 } });
    const { resolvedPeople: _a, ...a } = simulate(early, 5, 1, { monthly: true });
    const { resolvedPeople: _b, ...b } = simulate(plain, 5, 1, { monthly: true });
    expect(a).toEqual(b);
  });

  it("with a client roster, a new starter takes their share of the clients' work, and a leaver's clients go to their role", () => {
    const base = { ...northbeamWithClientGroups(), horizonWeeks: months(6) };
    const team = base.people!;
    const ppc = Object.keys(team).filter((id) => team[id]!.roles.includes("ppc"));
    const hired: EngineModel = { ...base, people: { ...team, hire: { name: "New PPC", roles: ["ppc"], capacity: 40, from: 3 * MONTH } } };
    const r = simulate(hired, 10, 1, { monthly: true }).monthly!;
    expect(r.people.hire![2]).toBeNull();
    expect(r.people.hire![4]!.work).toBeGreaterThan(5);
    expect(r.people[ppc[0]!]![4]!.mean).toBeLessThan(r.people[ppc[0]!]![2]!.mean - 0.05);
    const left: EngineModel = { ...base, people: { ...team, [ppc[1]!]: { ...team[ppc[1]!]!, until: 2 * MONTH } } };
    const l = simulate(left, 10, 1, { monthly: true }).monthly!;
    expect(l.roles.ppc![3]!.capacity).toBeCloseTo(40, 6);
    expect(l.people[ppc[0]!]![3]!.mean).toBeGreaterThan(l.people[ppc[0]!]![1]!.mean + 0.2);
  });
});

describe("who gets too busy, and when", () => {

  it("finds the first month on the average and in a bad month", () => {
    const series = [busy(0.6, 0.7), busy(0.7, 0.86), null, busy(0.86, 0.9), busy(0.8, 0.9)];
    expect(firstCrossing(series, [0.7, 0.85, 0.95])).toEqual({ average: { month: 3, value: 0.86 }, badMonth: { month: 1, value: 0.86 } });
    expect(firstCrossing([busy(0.5)], [0.7, 0.85, 0.95])).toEqual({ average: null, badMonth: null });
  });

  const growing: EngineModel = { ...northbeamModel(), horizonWeeks: months(12), demand: { growthMonthly: 0.05 } };
  const run = simulate(growing, 30, 1, { monthly: true });
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const alerts = forecastAlerts(growing, run, undefined, { monthName: (i) => names[i]! });

  it("writes an alert for each role that crosses the line after the first month, rated by the Too busy rule", () => {
    const ppc = alerts.find((a) => a.key === "forecast:role:ppc")!;
    expect(ppc).toBeDefined();
    expect(ppc.type).toBe("capacity");
    expect(ruleOfFinding(ppc)).toBe("busy");
    const { badMonth, average } = firstCrossing(run.monthly!.roles.ppc!, [0.7, 0.85, 0.95]);
    const month = Math.min(badMonth!.month, average!.month);
    expect(month).toBeGreaterThan(0);
    // Numbers from the run, never from the template.
    const m = run.monthly!.roles.ppc![month]!;
    expect(ppc.metrics.month).toBe(month + 1);
    expect(ppc.metrics.utilisation).toBe(m.mean);
    expect(ppc.metrics.utilisation_p90).toBe(m.p90);
    expect(ppc.title).toBe(`PPC specialist gets too busy in ${names[month]} (${Math.round(m.p90 * 100)}% in a bad month)`);
    expect(ppc.evidence).toContain(`On average PPC specialist crosses it in ${names[average!.month]} (${Math.round(average!.value * 100)}%).`);
    expect(ppc.evidence).toContain(`Hire or move work by ${names[month - 1]}`);
    // A bad month crosses before the average does: Bad, raised by the bad month.
    expect(ppc.rating).toBe("bad");
    expect(ppc.escalation.badMonth).toBe(true);
    // Fin and sales never get near it.
    expect(alerts.some((a) => a.key.endsWith(":fin") || a.key.endsWith(":sales"))).toBe(false);
  });

  it("leaves out a role already too busy on average in the first month: the run's own insight covers it", () => {
    const hot = simulate({ ...growing, activeClients: growing.activeClients * 2 }, 20, 1, { monthly: true });
    const first = hot.monthly!.roles.ppc![0]!;
    expect(first.mean).toBeGreaterThanOrEqual(0.85);
    expect(forecastAlerts(growing, hot).some((a) => a.key === "forecast:role:ppc")).toBe(false);
  });

  it("follows the workspace's cut-offs, and the rule switched off", () => {
    const high = forecastAlerts(growing, run, { rules: { busy: { cutoffs: [0.9, 1.1, 1.3] } } });
    const ppcHigh = high.find((a) => a.key === "forecast:role:ppc");
    const ppcDefault = alerts.find((a) => a.key === "forecast:role:ppc")!;
    expect(ppcHigh?.metrics.month ?? Infinity).toBeGreaterThan(ppcDefault.metrics.month!);
    expect(forecastAlerts(growing, run, { rules: { busy: { enabled: false } } })).toEqual([]);
    // Without the bad-month escalator only the average counts.
    const avgOnly = forecastAlerts(growing, run, { escalators: { badMonth: false, bottleneck: true } }).find((a) => a.key === "forecast:role:ppc")!;
    expect(avgOnly.title).toMatch(/on average\)$/);
  });

  it("says month 1, month 2… without month names, and nothing without a month-by-month run", () => {
    expect(forecastAlerts(growing, run).find((a) => a.key === "forecast:role:ppc")!.title).toMatch(/in month \d+ /);
    expect(forecastAlerts(growing, simulate(growing, 3, 1))).toEqual([]);
  });

  it("moves the alert later when a hire is planned before it", () => {
    // One SEO specialist with a heavy pinned step gets too busy while the role doesn't.
    const m = named({}, months(12));
    m.demand = { growthMonthly: 0.03 };
    const plain = simulate(m, 20, 1, { monthly: true });
    const before = forecastAlerts(m, plain).find((a) => a.key === "forecast:role:ppc");
    const hired = { ...m, people: { ...m.people!, "ppc-3": { name: "New PPC", roles: ["ppc"], capacity: 40, from: 0.5 * MONTH } } };
    const after = forecastAlerts(hired, simulate(hired, 20, 1, { monthly: true })).find((a) => a.key === "forecast:role:ppc");
    expect(before).toBeDefined();
    expect(after?.metrics.month ?? Infinity).toBeGreaterThan(before!.metrics.month!);
  });
});

describe("review fixes: calendar months, uncovered roles, the run's own insight, leave hand-back", () => {
  /** One role of client work only (no enquiries), two or three people: every hour is the pooled client load. */
  const clientWorkOnly = (people: Record<string, Partial<EnginePerson>>, weeks = months(3)): EngineModel => ({
    horizonWeeks: weeks,
    hoursPerWeek: HPW,
    leadsPerWeek: 0,
    activeClients: 30,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 0,
    roles: { am: { name: "Account manager", count: 1, cost: 50, ongoing: 1 } },
    people: Object.fromEntries(Object.entries(people).map(([id, p]) => [id, { name: id, roles: ["am"], capacity: HPW, ...p }])),
    entry: "s",
    sinks: { won: "won", lost: "lost" },
    steps: [{ id: "s", name: "S", role: "am", work: 1, wait: 0, rework: 0, next: [{ to: "won", p: 1 }] }],
  });

  it("takes the months' edges it is given (calendar months), first and last ones part of a month", () => {
    const m = { ...northbeamModel(), horizonWeeks: months(3) };
    const starts = [20, 200, 380];
    const mo = simulate(m, 3, 1, { monthly: true, monthStarts: starts }).monthly!;
    expect(mo.months.map((x) => [x.start, x.end])).toEqual([
      [0, 20],
      [20, 200],
      [200, 380],
      [380, months(3) * HPW],
    ]);
    // Asking for other months changes nothing else in the run.
    expect(withoutMonthly(simulate(m, 3, 1, { monthly: true, monthStarts: starts }))).toEqual(simulate(m, 3, 1));
  });

  it("gives a person's client hours on leave to the others in the role, not back to them", () => {
    // Two people, 15 client hours a week each. A's leave is the second half of the second month.
    const mid = 1.5 * MONTH;
    const two = simulate(clientWorkOnly({ a: { leave: [[mid, 2 * MONTH]] }, b: {} }), 1, 1, { monthly: true }).monthly!;
    const weeks = MONTH / HPW;
    expect(two.people.a![1]!.work * weeks).toBeCloseTo(15 * (weeks / 2), 6);
    expect(two.people.b![1]!.work * weeks).toBeCloseTo(15 * weeks + 15 * (weeks / 2), 6);
    // Three people (10 hours each): A's half month goes to B and C, by their hours (C is part-time).
    const three = simulate(clientWorkOnly({ a: { leave: [[mid, 2 * MONTH]] }, b: {}, c: { capacity: 20 } }), 1, 1, { monthly: true }).monthly!;
    const load = (cap: number) => (30 * cap) / 100;
    const away = load(40) * (weeks / 2);
    expect(three.people.a![1]!.work * weeks).toBeCloseTo(load(40) * (weeks / 2), 6);
    expect(three.people.b![1]!.work * weeks).toBeCloseTo(load(40) * weeks + (away * 40) / 60, 6);
    expect(three.people.c![1]!.work * weeks).toBeCloseTo(load(20) * weeks + (away * 20) / 60, 6);
  });

  it("says a role is uncovered when its only person leaves: no one there to do its work, at Operational risk", () => {
    const m = named({ "strat-1": { until: 3 * MONTH } });
    const r = simulate(m, 20, 1, { monthly: true });
    const uncovered = r.monthly!.uncovered.strat!;
    expect(uncovered.slice(0, 3)).toEqual([null, null, null]);
    for (const h of uncovered.slice(3)) expect(h).toBeGreaterThan(5);
    expect(r.monthly!.roles.strat![5]).toBeNull();
    const alerts = forecastAlerts(m, r);
    const alert = alerts.find((a) => a.key === "forecast:uncovered:strat")!;
    expect(alert.rating).toBe("risk");
    expect(alert.title).toBe(`Uncovered from month 4: no one in Strategist to do ${Math.round(uncovered[3]!)} hours of work a week`);
    expect(alert.metrics.uncovered_hours_week).toBe(uncovered[3]);
    // It speaks for the role: no "too busy" alert beside it.
    expect(alerts.some((a) => a.key === "forecast:role:strat")).toBe(false);
    expect(ruleOfFinding(alert)).toBe("busy");
  });

  it("says nothing new for a role the run's own insight covers when it is too busy from the first month, on the average or a bad month", () => {
    const flat = { ...northbeamModel(), horizonWeeks: months(12) };
    const r = simulate(flat, 20, 1, { monthly: true });
    // The strategist is too busy over the whole run, and in a bad month from the first month.
    expect(r.kpi.roles.strat!.util.p90).toBeGreaterThanOrEqual(0.85);
    expect(r.monthly!.roles.strat![0]!.p90).toBeGreaterThanOrEqual(0.85);
    const strat = forecastAlerts(flat, r).find((a) => a.key === "forecast:role:strat");
    // No "Act now" from the first month; at most when the average crosses later.
    expect(strat?.metrics.month ?? Infinity).toBeGreaterThan(1);
    expect(strat?.evidence ?? "").not.toContain("Act now");
    expect(strat?.metrics.bad_month).toBeUndefined();
    // Each measure on its own: a bad month from the start is known, the average crossing later is news.
    const series = [busy(0.7, 0.9), busy(0.8, 0.9), busy(0.9, 0.95)];
    expect(firstCrossing(series, [0.7, 0.85, 0.95], { skipFirst: true })).toEqual({ average: { month: 2, value: 0.9 }, badMonth: null });
  });
});

describe("performance (docs/PRD.md §6.7, scaled by horizon as for the 24-month picker)", { tags: ["perf"] }, () => {
  // The seeded Northbeam's target is 250 ms for 13 weeks; 104 weeks is 8 times that (apps/web/test/horizon-performance.test.ts).
  // The timeout bounds the harness (a warm-up and three runs on a loaded machine), not the target.
  it("the seeded Northbeam month by month over 24 months, 30 runs: < 8 × 250 ms", { timeout: 20_000 }, () => {
    const m = { ...northbeamWithClientGroups(), horizonWeeks: months(24) };
    simulate(m, 30, 1, { monthly: true });
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      simulate({ ...m, leadsPerWeek: m.leadsPerWeek + i * 0.1 }, 30, 1, { monthly: true });
      best = Math.min(best, performance.now() - t);
    }
    console.info(`24 months month by month, seeded Northbeam: ${best.toFixed(0)} ms (limit 2000)`);
    expect(best).toBeLessThan(8 * 250);
  });
});

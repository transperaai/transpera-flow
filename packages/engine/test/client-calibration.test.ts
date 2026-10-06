import { describe, expect, it } from "vitest";
import {
  BUILTIN_CHURN_DRIVER_IDS,
  CHURN_WINDOW_WEEKS,
  MARKET_PRESETS,
  backSolveChurn,
  churnMultipliers,
  churnProposals,
  estimatedParameters,
  measureChurn,
  northbeamWithClientGroups,
  servicingChecks,
  simulate,
  withMarketCondition,
  type BackSolvedChurn,
  type ChurnServiceInput,
  type ClientRow,
  type EngineModel,
  type ServicingLinkInput,
  type ServicingRow,
} from "../src";

// Calibration of churn and servicing checks from a clients file and a servicing
// log (docs/PRD.md §6.6; issue #41, part 2): small hand-built inputs whose
// answers are worked out by hand, then Northbeam for the back-solve.

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** The counted-up-to date: Monday 28 December 2026. The 52-week window starts at W0. */
const ASOF = Date.UTC(2026, 11, 28);
const W0 = ASOF - CHURN_WINDOW_WEEKS * WEEK;
/** Working hours as calendar time, at 40 hours a week. */
const wh = (h: number) => (h / 40) * WEEK;

const SEO: ChurnServiceInput = {
  serviceId: "seo",
  name: "SEO retainer",
  pricingModel: "retainer",
  group: { id: "g-seo", churnMonthly: 0.03, count: 17, source: "estimated" },
};
const PPC: ChurnServiceInput = {
  serviceId: "ppc",
  name: "PPC management",
  pricingModel: "retainer",
  group: { id: "g-ppc", churnMonthly: 0.04, count: 12, source: "entered" },
};

const row = (client: string, service: string, started: number, ended: number | null = null): ClientRow => ({ client, service, started, ended });

/**
 * 20 clients of "SEO retainer", asOf 28 Dec 2026, so the window is the 52 weeks from W0:
 *   14 were clients before W0 and stay (one has an end date 10 days after asOf: still a client): 14 x 52 = 728 weeks
 *    4 were clients before W0 and left 26 weeks in:                                               4 x 26 = 104 weeks
 *    2 joined 26 weeks in and stay:                                                                2 x 26 =  52 weeks
 *   exposure 884 weeks = 884 / 4.33 client-months; leavers 4
 *   monthly = 4 / (884 / 4.33) = 4 x 4.33 / 884 = 0.019593
 */
function twentyClients(): ClientRow[] {
  const rows: ClientRow[] = [];
  for (let i = 0; i < 14; i++) rows.push(row(`s${i}`, "SEO retainer", W0 - (10 + i) * WEEK, i === 0 ? ASOF + 10 * DAY : null));
  for (let i = 0; i < 4; i++) rows.push(row(`l${i}`, "SEO retainer", W0 - 30 * WEEK, W0 + 26 * WEEK));
  for (let i = 0; i < 2; i++) rows.push(row(`n${i}`, "SEO retainer", W0 + 26 * WEEK));
  return rows;
}

const measure = (rows: ClientRow[], services: ChurnServiceInput[] = [SEO, PPC], extra: { minSample?: number } = {}) =>
  measureChurn({ rows, services, asOf: ASOF, ...extra });
const seoOf = (r: ReturnType<typeof measure>) => r.services.find((s) => s.serviceId === "seo")!;

describe("measureChurn", () => {
  it("measures leavers over client-months by hand", () => {
    const r = measure(twentyClients());
    const seo = seoOf(r);
    expect(r.window?.weeks).toBeCloseTo(52, 9);
    expect(seo.clients).toBe(20);
    expect(seo.leavers).toBe(4);
    expect(seo.clientMonths).toBeCloseTo(884 / 4.33, 9);
    expect(seo.monthly).toBeCloseTo((4 * 4.33) / 884, 9);
    expect(seo.enough).toBe(true);
    expect(seo.blocked).toBeNull();
    // 16 are clients on asOf: the 14 stayers (one has an end date after asOf: still a client) and the 2 joiners.
    expect(seo.activeAtAsOf).toBe(16);
    expect(seo.note).toContain("4 of 20 clients left over 52 weeks (2% a month).");
    expect(seo.note).toContain("16 are clients on 28 December 2026, and Client groups counts 17.");
    expect(r.rows).toBe(20);
    expect(r.clients).toBe(20);
  });

  it("counts clients from before the window from its start, and a spell ending after asOf is not a leaver", () => {
    const rows = [row("a", "SEO retainer", W0 - 100 * WEEK, ASOF + DAY), row("b", "SEO retainer", W0 - 100 * WEEK, W0 - DAY)];
    const seo = seoOf(measure(rows, [SEO], { minSample: 1 }));
    // a: exposure 52 weeks, still a client. b left before the window: no exposure, no leave, not counted.
    expect(seo.leavers).toBe(0);
    expect(seo.clients).toBe(1);
    expect(seo.clientMonths).toBeCloseTo(52 / 4.33, 9);
  });

  it("merges overlapping and touching spells; a gap makes two and the first one's end is a leave", () => {
    const base = W0 - 10 * WEEK;
    const merged = seoOf(
      measure([row("a", "SEO retainer", base, base + 20 * WEEK), row("a", "SEO retainer", base + 15 * WEEK, base + 30 * WEEK), row("a", "SEO retainer", base + 30 * WEEK)], [SEO], { minSample: 1 }),
    );
    expect(merged.leavers).toBe(0);
    expect(merged.clients).toBe(1);
    expect(merged.clientMonths).toBeCloseTo(52 / 4.33, 9);
    const gap = seoOf(
      measure([row("a", "SEO retainer", base, base + 20 * WEEK), row("a", "SEO retainer", base + 25 * WEEK)], [SEO], { minSample: 1 }),
    );
    // Spell 1 runs 10 weeks into the window and ends there (a leave); spell 2 starts 15 weeks in: 37 weeks. Together 10 + 37 = 47.
    expect(gap.leavers).toBe(1);
    expect(gap.clients).toBe(1);
    expect(gap.clientMonths).toBeCloseTo(47 / 4.33, 9);
  });

  it("drops starts after asOf and counts them", () => {
    const r = measure([...twentyClients(), row("late", "SEO retainer", ASOF + DAY)]);
    expect(r.startsAfterAsOf).toBe(1);
    expect(seoOf(r).clients).toBe(20);
  });

  it("matches services by name ignoring case and spacing, and counts the names it can't match", () => {
    const rows = twentyClients().map((r) => ({ ...r, service: "  seo   RETAINER " }));
    rows.push(row("x", "Web design", W0), row("y", "Web design", W0), row("z", "web  design", W0));
    const r = measure(rows);
    expect(seoOf(r).clients).toBe(20);
    expect(r.unmatchedServices).toEqual([{ name: "Web design", rows: 3 }]);
    // A name two services share matches neither.
    const twin = measure(twentyClients(), [SEO, { ...PPC, name: "seo RETAINER" }]);
    expect(twin.services.every((s) => s.clients === 0)).toBe(true);
    expect(twin.unmatchedServices).toEqual([{ name: "SEO retainer", rows: 20 }]);
  });

  it("does not depend on the order of the rows", () => {
    const rows = twentyClients();
    expect(measure([...rows].reverse())).toEqual(measure(rows));
    const shuffled = [...rows].sort((a, b) => (a.client < b.client ? 1 : -1));
    expect(measure(shuffled)).toEqual(measure(rows));
  });

  describe("blocks, in this order", () => {
    it("one-off work", () => {
      const r = measure(twentyClients(), [{ ...SEO, pricingModel: "one_off" }]);
      expect(r.services[0]!.blocked).toBe("One-off work ends by design, so churn isn't measured for it.");
      expect(r.services[0]!.monthly).toBeNull();
    });
    it("a file covering under 13 weeks", () => {
      const rows = Array.from({ length: 12 }, (_, i) => row(`c${i}`, "SEO retainer", ASOF - 5 * WEEK, i < 4 ? ASOF - WEEK : null));
      const seo = seoOf(measure(rows));
      expect(seo.blocked).toBe("The file covers 5 weeks; at least 13 are needed.");
      expect(seo.enough).toBe(false);
      expect(seo.monthly).toBeNull();
    });
    it("under 10 clients", () => {
      const rows = twentyClients().filter((r) => ["s0", "s1", "s2", "l0", "l1", "l2", "l3"].includes(r.client));
      expect(seoOf(measure(rows)).blocked).toBe("Too few to measure: 7 of the 10 clients needed.");
    });
    it("under 3 leavers, saying a file of current clients can't show churn", () => {
      const two = twentyClients().filter((r) => r.client !== "l2" && r.client !== "l3");
      expect(seoOf(measure(two)).blocked).toMatch(/^Only 2 clients left in the period; at least 3 are needed\. A file of current clients only can't show churn/);
      const one = twentyClients().filter((r) => !["l1", "l2", "l3"].includes(r.client));
      expect(seoOf(measure(one)).blocked).toMatch(/^Only 1 client left in the period/);
    });
    it("more than every client leaving each month", () => {
      const rows = [
        row("old", "SEO retainer", ASOF - 20 * WEEK),
        ...Array.from({ length: 12 }, (_, i) => row(`c${i}`, "SEO retainer", ASOF - 2 * WEEK, ASOF - WEEK)),
      ];
      const seo = seoOf(measure(rows));
      expect(seo.leavers).toBe(12);
      expect(seo.blocked).toBe("More than every client leaving each month: check the dates.");
      expect(seo.monthly).toBeNull();
    });
  });

  it("measures a window shorter than 52 weeks from the file's first start", () => {
    const rows = [row("a", "SEO retainer", ASOF - 20 * WEEK), ...Array.from({ length: 10 }, (_, i) => row(`c${i}`, "SEO retainer", ASOF - 10 * WEEK, i < 3 ? ASOF - 5 * WEEK : null))];
    const r = measure(rows);
    expect(r.window?.weeks).toBeCloseTo(20, 9);
    // a: 20 weeks; 3 leavers x 5 weeks; 7 stayers x 10 weeks = 20 + 15 + 70 = 105 weeks.
    expect(seoOf(r).clientMonths).toBeCloseTo(105 / 4.33, 9);
    expect(seoOf(r).leavers).toBe(3);
    expect(seoOf(r).enough).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const link = (serviceId: string, processName: string, slaHours: number, adhoc: boolean): ServicingLinkInput => ({
  serviceId,
  processId: `p-${processName}`,
  processName,
  slaHours,
  adhoc,
});
const LINKS = [link("seo", "Monthly report", 40, false), link("seo", "Ad-hoc request", 16, true), link("ppc", "Monthly report", 40, false)];
const task = (name: string, client: string, due: number, done: number | null, requested: number | null = null): ServicingRow => ({ task: name, client, due, done, requested });
const checks = (log: ServicingRow[], clients: ClientRow[] | null = null, links = LINKS, minSample?: number) =>
  servicingChecks({ log, clients, links, services: [SEO, PPC], hoursPerWeek: 40, asOf: ASOF, ...(minSample ? { minSample } : {}) });
const byId = (r: ReturnType<typeof checks>, id: string) => r.checks.find((c) => c.id === id)!;

describe("servicingChecks", () => {
  const T = ASOF - 60 * DAY;

  it("late share: a date-only due is the end of its day, an open task past due is bad, one not yet due is left out", () => {
    const endOfDay = (t: number) => t + DAY - 1;
    const log: ServicingRow[] = [];
    for (let i = 0; i < 8; i++) log.push(task("Monthly report", `c${i}`, T + i * DAY, T + i * DAY - 3_600_000));
    log.push(task("Monthly report", "c8", endOfDay(T + 10 * DAY), T + 10 * DAY + 17 * 3_600_000)); // done 17:00 on its due day: on time
    log.push(task("Monthly report", "c9", endOfDay(T + 11 * DAY), T + 12 * DAY)); // a day late
    log.push(task("Monthly report", "c10", endOfDay(T + 12 * DAY), T + 20 * DAY)); // late
    log.push(task("Monthly report", "c11", endOfDay(T + 13 * DAY), null)); // open past due
    log.push(task("Monthly report", "c12", ASOF + 5 * DAY, null)); // not yet due
    const late = byId(checks(log), "late");
    expect(late.n).toBe(12);
    expect(late.value).toBeCloseTo(3 / 12, 12);
    expect(late.enough).toBe(true);
    expect(late.note).toContain("3 of 12 tasks due by 28 December 2026");
  });

  it("flags under 10 and gives no value", () => {
    const log = Array.from({ length: 9 }, (_, i) => task("Monthly report", `c${i}`, T + i * DAY, T + i * DAY));
    const late = byId(checks(log), "late");
    expect(late.n).toBe(9);
    expect(late.enough).toBe(false);
    expect(late.value).toBeNull();
    expect(late.blocked).toBe("Too few to measure: 9 of the 10 needed.");
  });

  describe("response time to ad-hoc requests", () => {
    const clients: ClientRow[] = [row("a1", "SEO retainer", T - 100 * DAY), row("b1", "PPC management", T - 100 * DAY)];

    it("uses the requested column when it is there", () => {
      // 12 requests, each done 5 working hours after it was requested.
      const log = Array.from({ length: 12 }, (_, i) => task("Ad-hoc request", "a1", T + i * DAY + wh(30), T + i * DAY + wh(5), T + i * DAY));
      const resp = byId(checks(log, clients), "resp");
      expect(resp.n).toBe(12);
      expect(resp.value).toBeCloseTo(5, 9);
    });

    it("infers the request as coming in one SLA before it was due when there is no requested column", () => {
      // Done 4 working hours after the due time, SLA 16: 20 working hours.
      const log = Array.from({ length: 10 }, (_, i) => task("Ad-hoc request", "a1", T + i * DAY, T + i * DAY + wh(4)));
      expect(byId(checks(log, clients), "resp").value).toBeCloseTo(20, 9);
    });

    it("counts only ad-hoc links, and only for services the client takes", () => {
      const log = [
        ...Array.from({ length: 10 }, (_, i) => task("Ad-hoc request", "a1", T + i * DAY, T + i * DAY + wh(4))),
        // PPC clients have no ad-hoc link, and a monthly report isn't an ad-hoc request.
        ...Array.from({ length: 5 }, (_, i) => task("Ad-hoc request", "b1", T + i * DAY, T + i * DAY + wh(100))),
        ...Array.from({ length: 5 }, (_, i) => task("Monthly report", "a1", T + i * DAY, T + i * DAY + wh(100))),
      ];
      const withClients = byId(checks(log, clients), "resp");
      expect(withClients.n).toBe(10);
      expect(withClients.value).toBeCloseTo(20, 9);
      // Without the clients file any ad-hoc link to the process will do.
      expect(byId(checks(log, null), "resp").n).toBe(15);
    });

    it("uses the smallest SLA when links disagree, and says so", () => {
      const links = [...LINKS, link("ppc", "Ad-hoc request", 8, true)];
      const log = Array.from({ length: 10 }, (_, i) => task("Ad-hoc request", "x", T + i * DAY, T + i * DAY + wh(4)));
      const resp = byId(checks(log, null, links), "resp");
      expect(resp.value).toBeCloseTo(12, 9);
      expect(resp.note).toContain("different SLAs");
    });

    it("is blocked when nothing is set to come in as ad-hoc requests", () => {
      const resp = byId(checks([task("Monthly report", "a1", T, T)], clients, [LINKS[0]!]), "resp");
      expect(resp.blocked).toBe("No servicing work is set to come in as ad-hoc requests.");
      expect(resp.value).toBeNull();
    });

    it("flags under 10", () => {
      const log = Array.from({ length: 4 }, (_, i) => task("Ad-hoc request", "a1", T + i * DAY, T + i * DAY + wh(4)));
      const resp = byId(checks(log, clients), "resp");
      expect(resp.enough).toBe(false);
      expect(resp.value).toBeNull();
    });
  });

  describe("onboarding speed", () => {
    // The log starts at `old`'s task, so clients that started before it are not new.
    const newClients = Array.from({ length: 12 }, (_, i) => row(`n${i}`, "SEO retainer", T + (i + 1) * DAY));
    const clients: ClientRow[] = [row("old", "SEO retainer", T - 400 * DAY), ...newClients];
    const log: ServicingRow[] = [
      task("Monthly report", "old", T, T + DAY),
      // 3 working days (3/5 of a week) after each new client started, due a week after it started.
      ...newClients.slice(0, 10).map((c) => task("Monthly report", c.client, c.started + 7 * DAY, c.started + 0.6 * WEEK)),
    ];

    it("is the mean from a new client starting to their first delivery, with those with nothing done left out", () => {
      const onb = byId(checks(log, clients), "onb");
      expect(onb.n).toBe(10);
      expect(onb.value).toBeCloseTo(3, 9);
      expect(onb.note).toContain("2 with nothing done yet left out");
    });

    it("needs the clients file", () => {
      const onb = byId(checks(log, null), "onb");
      expect(onb.blocked).toBe("Needs the clients file too.");
      expect(onb.value).toBeNull();
    });

    it("flags under 10", () => {
      const onb = byId(checks(log.slice(0, 6), clients), "onb");
      expect(onb.n).toBe(5);
      expect(onb.enough).toBe(false);
      expect(onb.value).toBeNull();
    });
  });

  it("lists task names that match no servicing process, and still counts them for late", () => {
    const log = [
      ...Array.from({ length: 10 }, (_, i) => task("Monthly report", `c${i}`, T + i * DAY, T + i * DAY)),
      task("Ad hoc favour", "c1", T, null),
      task("ad  hoc FAVOUR", "c2", T, null),
    ];
    const r = checks(log);
    expect(r.unmatchedTasks).toEqual([{ name: "Ad hoc favour", rows: 2 }]);
    expect(byId(r, "late").n).toBe(12);
    expect(r.tasks).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Back-solving, on Northbeam with client groups and servicing
// ---------------------------------------------------------------------------

const MEASURED = { seo: 0.04, ppc: 0.07 };
const withDrivers = (m: EngineModel, enabled: boolean): EngineModel => ({
  ...m,
  churnDrivers: BUILTIN_CHURN_DRIVER_IDS.map((id) => ({ id, weight: 1, enabled })),
});
const withBases = (m: EngineModel, bases: Record<string, number>): EngineModel => ({
  ...m,
  clientGroups: Object.fromEntries(Object.entries(m.clientGroups!).map(([sid, g]) => [sid, sid in bases ? { ...g, churnMonthly: bases[sid]! } : g])),
});
/** Today's model as the back-solve sees it: no market, no planned price rise. */
const noMarket = (m: EngineModel): EngineModel => ({ ...m, market: undefined });

describe("churnMultipliers", () => {
  it("is 1 for every service when every driver is off", () => {
    const m = withDrivers(northbeamWithClientGroups(), false);
    const M = churnMultipliers(simulate(m, 6, 1));
    expect(Object.keys(M).sort()).toEqual(["ppc", "seo"]);
    expect(M.seo).toBeCloseTo(1, 9);
    expect(M.ppc).toBeCloseTo(1, 9);
  });

  it("is above 1 with the defaults (late work on)", () => {
    const M = churnMultipliers(simulate(noMarket(northbeamWithClientGroups()), 6, 1));
    expect(M.seo).toBeGreaterThan(1);
    expect(M.ppc).toBeGreaterThan(M.seo!);
  });
});

describe("backSolveChurn", () => {
  const model = northbeamWithClientGroups();
  const solved = backSolveChurn(model, MEASURED);

  it("proposes less than the measured churn, since drivers add to it", () => {
    expect(solved.bases.seo).toBeLessThan(MEASURED.seo);
    expect(solved.bases.ppc).toBeLessThan(MEASURED.ppc);
    expect(solved.why).toEqual({});
    expect(solved.runs).toBeGreaterThanOrEqual(2);
    expect(solved.runs).toBeLessThanOrEqual(4);
    expect(solved.seed).toBe(1);
    expect(solved.reps).toBe(30);
    expect(solved.horizonWeeks).toBe(model.horizonWeeks);
    expect(solved.simulated.late).not.toBeNull();
  });

  it("gives the measured churn when the proposed bases are simulated: base x multiplier is within 2%", () => {
    const M = churnMultipliers(simulate(noMarket(withBases(model, solved.bases)), 30, 1));
    for (const sid of ["seo", "ppc"] as const) {
      expect((solved.bases[sid]! * M[sid]!) / MEASURED[sid]).toBeGreaterThan(0.98);
      expect((solved.bases[sid]! * M[sid]!) / MEASURED[sid]).toBeLessThan(1.02);
      expect(solved.multipliers[sid]).toBeGreaterThan(1);
    }
  });

  it("is deterministic, and does not change its input", () => {
    const before = JSON.stringify(model);
    expect(backSolveChurn(model, MEASURED)).toEqual(solved);
    expect(JSON.stringify(model)).toBe(before);
  });

  it("proposes the measured churn when the drivers are off", () => {
    const off = backSolveChurn(withDrivers(model, false), MEASURED, { reps: 6 });
    expect(off.bases).toEqual(MEASURED);
    expect(off.multipliers.seo).toBeCloseTo(1, 9);
    expect(off.converged).toBe(true);
  });

  it("ignores the market and a planned price rise: they are not today", () => {
    const planned: EngineModel = {
      ...withBases(model, {}),
      market: withMarketCondition(model, MARKET_PRESETS.downturn.factors).market,
      churnDrivers: [
        { id: "late", weight: 1, enabled: true },
        { id: "price", weight: 1, enabled: true, value: 20, month: 2 },
        { id: "market", weight: 1, enabled: true },
      ],
    };
    const plain: EngineModel = { ...model, churnDrivers: [{ id: "late", weight: 1, enabled: true }] };
    expect(planned.market).toBeDefined();
    const a = backSolveChurn(planned, MEASURED, { reps: 10 });
    const b = backSolveChurn(plain, MEASURED, { reps: 10 });
    expect(a).toEqual(b);
  });

  it("still solves a group whose normal churn is 0%", () => {
    const zero = backSolveChurn({ ...model, clientGroups: { ...model.clientGroups!, seo: { ...model.clientGroups!.seo!, churnMonthly: 0 } } }, { seo: MEASURED.seo }, { reps: 10 });
    expect(zero.bases.seo).toBeGreaterThan(0);
    expect(zero.bases.seo).toBeLessThan(MEASURED.seo);
    expect(zero.why).toEqual({});
  });

  it("says why a group with no simulated clients is not solved", () => {
    const empty = backSolveChurn({ ...model, clientGroups: { ...model.clientGroups!, seo: { ...model.clientGroups!.seo!, count: 0 } } }, MEASURED, { reps: 10 });
    expect(empty.bases.seo).toBeUndefined();
    expect(empty.why.seo).toBe("No clients of this service are simulated here. Count them in Settings → Client groups first.");
    expect(empty.bases.ppc).toBeDefined();
    const unknown = backSolveChurn(model, { nonesuch: 0.02 }, { reps: 4 });
    expect(unknown.bases).toEqual({});
    expect(unknown.why.nonesuch).toBeDefined();
  });

  it("refuses a measured churn outside 0 to 1", () => {
    expect(() => backSolveChurn(model, { seo: 0 })).toThrow(RangeError);
    expect(() => backSolveChurn(model, { seo: -0.01 })).toThrow(RangeError);
    expect(() => backSolveChurn(model, { seo: 1.2 })).toThrow(RangeError);
  });

  it("reports each run", () => {
    const seen: number[] = [];
    backSolveChurn(model, MEASURED, { reps: 4, onRun: (r) => seen.push(r) });
    expect(seen[0]).toBe(0);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("makes the calibrated churn the Stable market level", () => {
    // After applying the proposal, a Stable market (100% in every month) runs exactly as no market: the calibrated churn
    // is the Stable level. Late payments are untouched by design (decision 5: no cash model yet).
    const calibrated = withBases(model, solved.bases);
    expect(simulate(withMarketCondition(calibrated, MARKET_PRESETS.stable.factors), 6, 1)).toEqual(simulate(calibrated, 6, 1));
  });

  it("leaves robustness as it was: a group's normal churn is never perturbed, sensitivity still is", () => {
    const calibrated = withBases(model, solved.bases);
    const paths = estimatedParameters(calibrated).map((p) => p.path);
    expect(paths).toEqual(estimatedParameters(model).map((p) => p.path));
    expect(paths.filter((p) => /client_group|group/.test(p))).toEqual([]);
    expect(paths).toContain("services.seo.churn_health_sensitivity");
    expect(paths).toContain("services.ppc.churn_health_sensitivity");
  });
});

// ---------------------------------------------------------------------------

describe("churnProposals", () => {
  const measured = measure(twentyClients()).services;
  const solvedFor = (bases: Record<string, number>, multipliers: Record<string, number>, extra: Partial<BackSolvedChurn> = {}): BackSolvedChurn => ({
    bases,
    multipliers,
    why: {},
    runs: 2,
    converged: true,
    simulated: { late: 0.1, resp: null, onb: null },
    engineVersion: "x",
    seed: 1,
    reps: 30,
    horizonWeeks: 104,
    ...extra,
  });

  it("proposes the back-solved value with its keys, columns and compare-and-set", () => {
    const m = measured.find((s) => s.serviceId === "seo")!;
    const { proposals, noGroup } = churnProposals([SEO, PPC], measured, solvedFor({ seo: 0.0157 }, { seo: 1.25 }));
    expect(noGroup).toEqual([]);
    const p = proposals.find((x) => x.key === "churn:g-seo")!;
    expect(p).toMatchObject({
      kind: "churn",
      target: { table: "client_groups", id: "g-seo" },
      subject: "SEO retainer",
      n: 20,
      leavers: 4,
      enough: true,
      currentSource: "estimated",
      current: 0.03,
      measured: m.monthly,
      multiplier: 1.25,
      proposed: 0.0157,
      changed: true,
      blocked: null,
      set: { churn_monthly: 0.0157 },
      before: { churn_monthly: 0.03 },
    });
    expect(p.note).toContain("Today's drivers add 25% to it, so normal churn is 1.6%: 1.6% × 1.25 gives the 2% measured.");
    // PPC isn't in the file: blocked, nothing to write.
    const ppc = proposals.find((x) => x.key === "churn:g-ppc")!;
    expect(ppc.enough).toBe(false);
    expect(ppc.proposed).toBeNull();
    expect(ppc.set).toBeNull();
    expect(ppc.before).toBeNull();
    expect(ppc.blocked).toBe("Too few to measure: 0 of the 10 clients needed.");
  });

  it("is unchanged when the proposal is today's value to 4 places", () => {
    const { proposals } = churnProposals([{ ...SEO, group: { ...SEO.group!, churnMonthly: 0.01570004 } }], measured, solvedFor({ seo: 0.0157 }, { seo: 1.25 }));
    expect(proposals[0]!.changed).toBe(false);
  });

  it("says no driver adds churn when the multiplier is 1", () => {
    const { proposals } = churnProposals([SEO], measured, solvedFor({ seo: 0.0196 }, { seo: 1 }));
    expect(proposals[0]!.note).toContain("No driver adds churn today, so normal churn is the measured churn.");
  });

  it("warns when today's drivers more than double churn, and when the solve was approximate", () => {
    const { proposals } = churnProposals([SEO], measured, solvedFor({ seo: 0.0065 }, { seo: 3 }, { converged: false }));
    expect(proposals[0]!.note).toContain("Today's drivers more than double this service's churn, so normal churn is under half of what was measured. Check the driver weights.");
    expect(proposals[0]!.note).toContain("Approximate: the simulation moved a little between runs.");
  });

  it("blocks with the reason it couldn't be solved, and before it is solved", () => {
    const why = churnProposals([SEO], measured, solvedFor({}, {}, { why: { seo: "Its clients couldn't leave in the simulation." } }));
    expect(why.proposals[0]!.blocked).toBe("Its clients couldn't leave in the simulation.");
    expect(why.proposals[0]!.enough).toBe(false);
    const unsolved = churnProposals([SEO], measured, null);
    expect(unsolved.proposals[0]!.proposed).toBeNull();
    expect(unsolved.proposals[0]!.blocked).not.toBeNull();
  });

  it("names services in the file that have no client group, and skips one-off services", () => {
    const rows = [...twentyClients(), ...twentyClients().map((r) => ({ ...r, service: "Web design", client: `w${r.client}` }))];
    const services: ChurnServiceInput[] = [SEO, { serviceId: "web", name: "Web design", pricingModel: "retainer", group: null }, { serviceId: "once", name: "Audit", pricingModel: "one_off", group: null }];
    const { proposals, noGroup } = churnProposals(services, measureChurn({ rows, services, asOf: ASOF }).services, solvedFor({ seo: 0.0157 }, { seo: 1.25 }));
    expect(proposals.map((p) => p.key)).toEqual(["churn:g-seo"]);
    expect(noGroup).toEqual(["Web design"]);
  });
});

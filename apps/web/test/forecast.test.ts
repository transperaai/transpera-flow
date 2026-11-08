import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { northbeamPersonIds, type MarketConditionRow, type MarketScheduleRow } from "@transpera-flow/db";
import { simulate, type EngineModel } from "@transpera-flow/engine";
import { COSTS_HIDDEN_NOTE, ForecastMoney } from "@/components/forecast/forecast-money";
import { ForecastTimeline } from "@/components/forecast/forecast-timeline";
import { DEMO_FORECAST_START, DEMO_HIRE_ID, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastInsights, forecastModel } from "@/lib/forecast/forecast";
import { forecastMoney } from "@/lib/forecast/money";
import { spliceMonthly, calendarMonthStarts, dateAtHour } from "@transpera-flow/db/sandbox";
import { marketBands, timelineData, timelineMonths } from "@/lib/forecast/timeline";
import { demoBundle } from "@/lib/sources/demo";

// The Forecast (issue #35, B6): the model it runs, its alerts as insights, and the timeline's data and chart.

const built = forecastModel(demoForecastBundle(), 12, DEMO_FORECAST_START);
const model = built.model!;
const result = simulate(model, 30, 1, { monthly: true, monthStarts: built.monthStarts! });
const CUTOFFS = [0.7, 0.85, 0.95] as const;

describe("the forecast's model", () => {
  it("runs the horizon picked, with the planned hire and the leave", () => {
    expect(model.horizonWeeks).toBe(52);
    expect(model.people![DEMO_HIRE_ID]!.from).toBeGreaterThan(0);
    expect(model.people![northbeamPersonIds["Leah Brooks"]!]!.leave).toHaveLength(1);
    expect(model.market).toBeDefined();
    // Other screens simulate today's team: the hire isn't in it.
    expect(forecastModel(demoBundle(), 12, DEMO_FORECAST_START).model!.people![DEMO_HIRE_ID]).toBeUndefined();
  });

  it("says why when the model can't be simulated", () => {
    const b = demoForecastBundle();
    const broken = forecastModel({ ...b, process: { ...b.process, is_company: true } }, 12, DEMO_FORECAST_START);
    expect(broken.model).toBeNull();
    expect(broken.error).toMatch(/company map/);
  });
});

describe("alerts as insights", () => {
  const alerts = forecastInsights(model, result, {}, DEMO_FORECAST_START);

  it("names calendar months, with numbers from the run", () => {
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) {
      expect(a.key).toMatch(/^forecast:(role|person):/);
      const month = timelineMonths(DEMO_FORECAST_START, result.monthly!.months, 40)[a.metrics.month! - 1]!;
      expect(a.title).toContain(`too busy in ${month.name} (`);
      const series = a.personId && a.key.startsWith("forecast:person") ? result.monthly!.people[a.personId]! : result.monthly!.roles[a.roleId!]!;
      expect(a.metrics.utilisation).toBe(series[a.metrics.month! - 1]!.mean);
    }
  });

  it("follows the workspace's rules: none with Too busy switched off, and names the year over 24 months", () => {
    expect(forecastInsights(model, result, { rules: { busy: { enabled: false } } }, DEMO_FORECAST_START)).toEqual([]);
    const long = forecastModel(demoForecastBundle(), 24, DEMO_FORECAST_START);
    const twoYears = forecastInsights(long.model!, simulate(long.model!, 10, 1, { monthly: true, monthStarts: long.monthStarts! }), {}, DEMO_FORECAST_START);
    for (const a of twoYears) expect(a.title).toMatch(/in [A-Z][a-z]+ 20\d\d \(/);
  });
});

describe("the timeline's data", () => {
  it("runs calendar months: the rest of the first month, then each month from its 1st, in working hours", () => {
    // 5 October 2026 (a Monday) to 1 November is 20 working days; to 1 December 41.
    expect(calendarMonthStarts("2026-10-05", 22, 40).slice(0, 2)).toEqual([20 * 8, 41 * 8]);
    // A first part shorter than a working week joins the next month: from 28 October, the first month is November.
    const late = calendarMonthStarts("2026-10-28", 13, 40);
    expect(late[0]).toBe(24 * 8);
    const months = [0, ...late, 13 * 40].slice(0, -1).map((start, i, all) => ({ start, end: all[i + 1] ?? 13 * 40 }));
    expect(timelineMonths("2026-10-28", months, 40).map((m) => m.long)).toEqual(["November 2026", "December 2026", "January 2027"]);
  });

  it("names each month by the calendar month it is, with the year on the first and on January", () => {
    expect(timelineMonths(DEMO_FORECAST_START, result.monthly!.months, 40).map((m) => m.short)).toEqual([
      "Oct 26",
      "Nov",
      "Dec",
      "Jan 27",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
    ]);
  });

  it("turns working hours into calendar dates, skipping weekends", () => {
    expect(dateAtHour("2026-10-05", 0, 40).toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(dateAtHour("2026-10-05", 5 * 8, 40).toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(dateAtHour("2026-10-03", 0, 40).toISOString().slice(0, 10)).toBe("2026-10-05");
  });

  it("collapses the market schedule into bands, leaving Stable out and letting later entries win", () => {
    const c = (id: string, name: string, preset: MarketConditionRow["preset"]) => ({ id, name, preset }) as MarketConditionRow;
    const e = (from_month: number, to_month: number, condition_id: string) => ({ from_month, to_month, condition_id }) as MarketScheduleRow;
    // The schedule's months are the engine's 52/12-week months; here the forecast's months are those same months.
    const engineMonths = Array.from({ length: 12 }, (_, i) => ({ start: (i * 52 * 40) / 12, end: ((i + 1) * 52 * 40) / 12 }));
    const bands = marketBands(
      { marketConditions: [c("s", "Soft", "soft"), c("d", "Downturn", "downturn"), c("st", "Stable", "stable")], marketSchedule: [e(3, 8, "s"), e(6, 7, "d"), e(9, 12, "st")] },
      engineMonths,
      40,
    );
    expect(bands).toEqual([
      { from: 2, to: 4, name: "Soft" },
      { from: 5, to: 6, name: "Downturn" },
      { from: 7, to: 7, name: "Soft" },
    ]);
  });

  const data = timelineData(model, result, demoForecastBundle(), DEMO_FORECAST_START)!;

  it("has the roles and people with work, the client groups by service, the market and the plan", () => {
    expect(data.months).toHaveLength(12);
    expect(data.roles.map((r) => r.name)).toContain("PPC specialist");
    expect(data.people.find((p) => p.id === DEMO_HIRE_ID)!.series.slice(0, 3)).toEqual([null, null, null]);
    expect(data.clients.map((c) => c.name).sort()).toEqual(["PPC management", "SEO retainer"]);
    expect(data.market).toEqual([{ from: 6, to: 11, name: "Soft" }]);
    const hire = data.markers.find((m) => m.kind === "hire")!;
    expect(hire).toMatchObject({ personId: DEMO_HIRE_ID, label: "Jade Hart starts", when: "1 Feb 2027", from: 4 });
    const leave = data.markers.find((m) => m.kind === "leave")!;
    expect(leave).toMatchObject({ label: "Leah Brooks on leave", when: "14 Dec 2026 to 8 Jan 2027", from: 2, to: 3 });
    // The hire on 1 February is in February (a corrected expectation: the months used to be 52/12-week blocks named
    // as calendar months, which put it in "January").
    expect(data.months[hire.from]!.long).toBe("February 2027");
    // A marker sits on its role's row and its person's.
    expect(data.roles.find((r) => r.name === "PPC specialist")!.markers).toContainEqual(hire);
    expect(data.people.find((p) => p.id === DEMO_HIRE_ID)!.markers).toEqual([hire]);
  });

  it("draws the chart with a row per role or person, the market and a table for screen readers", () => {
    const roles = renderToStaticMarkup(createElement(ForecastTimeline, { data, rows: "roles", cutoffs: CUTOFFS, label: "Forecast" }));
    expect(roles.match(/data-row=/g)).toHaveLength(data.roles.length);
    expect(roles).toContain("data-market-band");
    expect(roles).toContain("Jade Hart starts: 1 Feb 2027");
    expect(roles).toContain("<table");
    expect(roles).toContain("October 2026");
    const people = renderToStaticMarkup(createElement(ForecastTimeline, { data, rows: "people", cutoffs: CUTOFFS, label: "Forecast" }));
    expect(people.match(/data-row=/g)).toHaveLength(data.people.length);
    expect(people).toContain("not there");
  });
});

describe("a role left with nobody", () => {
  it("says so as an Operational risk alert and on the timeline, when the only strategist leaves", () => {
    const b = demoForecastBundle();
    const maya = northbeamPersonIds["Maya Collins"]!;
    const leaving = { ...b, people: b.people.map((p) => (p.id === maya ? { ...p, end_date: "2027-01-29" } : p)) };
    const f = forecastModel(leaving, 12, DEMO_FORECAST_START);
    const m: EngineModel = f.model!;
    const r = simulate(m, 10, 1, { monthly: true, monthStarts: f.monthStarts! });
    const alerts = forecastInsights(m, r, {}, DEMO_FORECAST_START);
    const strat = Object.keys(m.roles).find((rid) => m.roles[rid]!.name === "Strategist")!;
    const uncovered = alerts.find((a) => a.key === `forecast:uncovered:${strat}`)!;
    expect(uncovered.rating).toBe("risk");
    expect(uncovered.title).toMatch(/^Uncovered from February: no one in Strategist to do \d+ hours of work a week$/);
    const d = timelineData(m, r, leaving, DEMO_FORECAST_START)!;
    const row = d.roles.find((x) => x.id === strat)!;
    expect(row.uncovered!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(row.uncovered![5]).toBeGreaterThan(5);
    const html = renderToStaticMarkup(createElement(ForecastTimeline, { data: d, rows: "roles", cutoffs: CUTOFFS, label: "Forecast" }));
    expect(html).toContain("data-uncovered");
    expect(html).toContain("no one in Strategist to do about");
  });
});

describe("sales and money (sandbox phase 2)", () => {
  const names = timelineMonths(DEMO_FORECAST_START, result.monthly!.months, 40);
  const run = (m: EngineModel) => simulate(m, 10, 1, { monthly: true, monthStarts: built.monthStarts! });
  const withOverheads = { ...model, overheadMonthly: 18000 };
  const rich = run(withOverheads);
  const rowOf = (view: NonNullable<ReturnType<typeof forecastMoney>>, id: string) => view.rows.find((r) => r.id === id)!;

  it("has four tiles and a row per figure, months as columns", () => {
    const view = forecastMoney(rich, names)!;
    expect(view.tiles.map((t) => t.id)).toEqual(["revenue", "labour", "overheads", "profit"]);
    expect(view.rows.map((r) => r.id)).toEqual([
      "opportunities", "won", "lost", "conversion", "revenue", "recurring", "oneOff", "hourly", "fromNew", "lostToChurn", "clientsWon", "clientsLost", "overtimeHours", "labour", "overtimeCost", "overheads", "profit",
    ]);
    for (const r of view.rows) expect(r.cells, r.id).toHaveLength(names.length);
    expect(view.months).toBe(names);
    expect(view.costsHidden).toBe(false);
    expect(view.profit).toBe(rich.monthly!.money!.profit);
  });

  it("takes its tiles from the run: revenue, labour with overtime, overheads and profit", () => {
    const view = forecastMoney(rich, names)!;
    const tile = (id: string) => view.tiles.find((t) => t.id === id)!.stat;
    expect(tile("revenue")).toBe(rich.kpi.revenue);
    expect(tile("profit")).toBe(rich.kpi.profit);
    expect(tile("overheads")).toEqual({ mean: 216_000, p10: 216_000, p90: 216_000 });
    expect(tile("labour").mean).toBeCloseTo(rich.kpi.labourCost!.mean + rich.kpi.overtimeCost!.mean, 6);
    // Revenue less labour and overheads is the profit.
    expect(tile("revenue").mean - tile("labour").mean - tile("overheads").mean).toBeCloseTo(tile("profit").mean, 4);
  });

  it("adds the months up in each row's total, except the ratio", () => {
    const view = forecastMoney(rich, names)!;
    expect(rowOf(view, "revenue").total).toBeCloseTo(rich.kpi.revenue.mean, 4);
    expect(rowOf(view, "won").total).toBeCloseTo(rich.kpi.won.mean, 6);
    expect(rowOf(view, "overheads").total).toBeCloseTo(216_000, 4);
    expect(rowOf(view, "conversion").total).toBeNull();
    // The revenue by kind adds to the revenue.
    expect(rowOf(view, "recurring").total! + rowOf(view, "oneOff").total! + rowOf(view, "hourly").total!).toBeCloseTo(rowOf(view, "revenue").total!, 4);
  });

  it("says no overheads are set until they are", () => {
    expect(forecastMoney(result, names)!.noOverheads).toBe(true);
    expect(forecastMoney(rich, names)!.noOverheads).toBe(false);
  });

  it("a Viewer's run (pay hidden) has revenue, sales and clients but no cost rows, labour, overtime cost or profit", () => {
    const hidden = forecastMoney(run({ ...withOverheads, payHidden: true }), names)!;
    expect(hidden.costsHidden).toBe(true);
    expect(hidden.tiles.map((t) => t.id)).toEqual(["revenue"]);
    expect(hidden.profit).toBeNull();
    expect(hidden.rows.some((r) => r.cost)).toBe(false);
    expect(hidden.rows.map((r) => r.id)).toContain("revenue");
    expect(hidden.rows.map((r) => r.id)).toContain("opportunities");
    expect(hidden.rows.map((r) => r.id)).toContain("overtimeHours");
    // Their revenue is the same as an Agency admin's, and the "no overheads" note isn't theirs to read.
    expect(hidden.tiles[0]!.stat).toEqual(forecastMoney(rich, names)!.tiles[0]!.stat);
    expect(forecastMoney(run({ ...model, payHidden: true }), names)!.noOverheads).toBe(false);
  });

  it("names an hourly service that earned nothing", () => {
    const quiet = { ...rich, kpi: { ...rich.kpi, hourly: { ppc: { hours: { mean: 0, p10: 0, p90: 0 }, revenue: { mean: 0, p10: 0, p90: 0 } }, seo: { hours: { mean: 5, p10: 4, p90: 6 }, revenue: { mean: 500, p10: 400, p90: 600 } } } } };
    expect(forecastMoney(quiet, names, (id) => (id === "ppc" ? "PPC management" : id))!.hourlyWithoutHours).toEqual(["PPC management"]);
    expect(forecastMoney(rich, names)!.hourlyWithoutHours).toEqual([]);
  });

  it("a plan's spliced run takes its tiles from the spliced months, not from the first segment's run", () => {
    // A plan whose second segment (from month 6) adds overheads: the first segment's own kpi knows nothing of them.
    const monthly = spliceMonthly([
      { from: 0, monthly: result.monthly! },
      { from: 6, monthly: rich.monthly! },
    ]);
    const plan = { ...result, monthly };
    const view = forecastMoney(plan, names, undefined, { spliced: true })!;
    const tile = (id: string) => view.tiles.find((t) => t.id === id)!;
    const months = (id: string) => view.rows.find((r) => r.id === id)!.total!;
    expect(tile("overheads").stat.mean).toBeCloseTo(months("overheads"), 6);
    expect(tile("overheads").stat.mean).toBeGreaterThan(0);
    expect(result.kpi.overheads).toBe(0);
    expect(tile("revenue").stat.mean).toBeCloseTo(months("revenue"), 6);
    expect(tile("profit").stat.mean).toBeCloseTo(months("profit"), 6);
    expect(tile("labour").stat.mean).toBeCloseTo(months("labour") + months("overtimeCost"), 6);
    expect(tile("profit").stat.mean).not.toBeCloseTo(result.kpi.profit!.mean, 0);
    // No run-wide range is made up from the months' percentiles.
    expect(tile("profit").ranged).toBe(false);
    expect(tile("profit").stat.p10).toBe(tile("profit").stat.mean);
    // The live run keeps the run's own figures and ranges.
    const live = forecastMoney(rich, names)!;
    expect(live.tiles.every((t) => t.ranged)).toBe(true);
  });

  it("gives nothing for a run saved before profit existed", () => {
    const older: Partial<NonNullable<typeof rich.monthly>> = { ...rich.monthly! };
    delete older.revenue;
    expect(forecastMoney({ ...rich, monthly: older as typeof rich.monthly }, names)).toBeNull();
  });

  describe("the section", () => {
    const html = (props: Partial<Parameters<typeof ForecastMoney>[0]> & { run?: typeof rich } = {}) =>
      renderToStaticMarkup(createElement(ForecastMoney, { view: forecastMoney(props.run ?? result, names, (id) => (id === "ppc" ? "PPC management" : id))!, currency: "GBP", span: "12 months", overheadsHref: "/w/acme/settings#workspace", ...props }));

    it("shows the tiles, the profit chart and the table", () => {
      const out = html({ run: rich });
      expect(out).toContain("Sales and money");
      for (const tile of ["revenue", "labour", "overheads", "profit"]) expect(out).toContain(`data-money-tile="${tile}"`);
      expect(out).toContain("data-money-profit-chart");
      expect(out).toContain('data-money-row="profit"');
      expect(out).not.toContain("No overheads set");
      // Monthly overtime (and so its cost and profit) needn't add up to the run's: the note names both.
      expect(out).toContain("except overtime cost and profit");
    });

    it("a plan's tiles say they add up the months, and a figure with no spread says it is the same in every run", () => {
      const plan = { ...rich, monthly: spliceMonthly([{ from: 0, monthly: result.monthly! }, { from: 6, monthly: rich.monthly! }]) };
      const out = renderToStaticMarkup(createElement(ForecastMoney, { view: forecastMoney(plan, names, undefined, { spliced: true })!, currency: "GBP", span: "12 months" }));
      expect(out).toContain("The months added up");
      expect(out).not.toContain("Fixed each month");
      expect(html({ run: rich })).toContain("The same in every run");
    });

    it("says No overheads set, with a link to Settings for someone who can set them", () => {
      const out = html();
      expect(out).toContain("No overheads set");
      expect(out).toContain('href="/w/acme/settings#workspace"');
      expect(html({ overheadsHref: null })).not.toContain("/settings#workspace");
    });

    it("says an hourly service earned nothing", () => {
      const quiet = { ...rich, kpi: { ...rich.kpi, hourly: { ppc: { hours: { mean: 0, p10: 0, p90: 0 }, revenue: { mean: 0, p10: 0, p90: 0 } } } } };
      expect(html({ run: quiet })).toContain("Hourly service PPC management earned nothing: no client work is modelled for its clients");
    });

    it("gives a Viewer the note instead of costs and profit", () => {
      const out = html({ run: run({ ...withOverheads, payHidden: true }) });
      expect(out).toContain(COSTS_HIDDEN_NOTE);
      expect(COSTS_HIDDEN_NOTE).toBe("Costs and profit are shown to Agency admins and the Owner.");
      expect(out).toContain('data-money-tile="revenue"');
      for (const gone of ['data-money-tile="profit"', 'data-money-tile="labour"', 'data-money-row="labour"', 'data-money-row="profit"', "data-money-profit-chart", "No overheads set"]) expect(out, gone).not.toContain(gone);
    });
  });
});

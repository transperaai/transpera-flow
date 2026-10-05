import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { northbeamPersonIds, type MarketConditionRow, type MarketScheduleRow } from "@transpera-flow/db";
import { simulate, type EngineModel } from "@transpera-flow/engine";
import { ForecastTimeline } from "@/components/forecast/forecast-timeline";
import { DEMO_FORECAST_START, DEMO_HIRE_ID, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastInsights, forecastModel } from "@/lib/forecast/forecast";
import { calendarMonthStarts, dateAtHour, marketBands, timelineData, timelineMonths } from "@/lib/forecast/timeline";
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

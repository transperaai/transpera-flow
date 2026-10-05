import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { northbeamPersonIds, type MarketConditionRow, type MarketScheduleRow } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { ForecastTimeline } from "@/components/forecast/forecast-timeline";
import { DEMO_FORECAST_START, DEMO_HIRE_ID, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastInsights, forecastModel } from "@/lib/forecast/forecast";
import { dateAtHour, marketBands, timelineData, timelineMonths } from "@/lib/forecast/timeline";
import { demoBundle } from "@/lib/sources/demo";

// The Forecast (issue #35, B6): the model it runs, its alerts as insights, and the timeline's data and chart.

const built = forecastModel(demoForecastBundle(), 12, DEMO_FORECAST_START);
const model = built.model!;
const result = simulate(model, 30, 1, { monthly: true });

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
      const month = timelineMonths(DEMO_FORECAST_START, 12)[a.metrics.month! - 1]!;
      expect(a.title).toContain(`too busy in ${month.name} (`);
      const series = a.personId && a.key.startsWith("forecast:person") ? result.monthly!.people[a.personId]! : result.monthly!.roles[a.roleId!]!;
      expect(a.metrics.utilisation).toBe(series[a.metrics.month! - 1]!.mean);
    }
  });

  it("follows the workspace's rules: none with Too busy switched off, and names the year over 24 months", () => {
    expect(forecastInsights(model, result, { rules: { busy: { enabled: false } } }, DEMO_FORECAST_START)).toEqual([]);
    const long = forecastModel(demoForecastBundle(), 24, DEMO_FORECAST_START).model!;
    const twoYears = forecastInsights(long, simulate(long, 10, 1, { monthly: true }), {}, DEMO_FORECAST_START);
    for (const a of twoYears) expect(a.title).toMatch(/in [A-Z][a-z]+ 20\d\d \(/);
  });
});

describe("the timeline's data", () => {
  it("names months from the start date, with the year on the first and on January", () => {
    expect(timelineMonths("2026-10-05", 5).map((m) => m.short)).toEqual(["Oct 26", "Nov", "Dec", "Jan 27", "Feb"]);
    expect(timelineMonths("2026-10-05", 1)[0]!.long).toBe("October 2026");
  });

  it("turns working hours into calendar dates, skipping weekends", () => {
    expect(dateAtHour("2026-10-05", 0, 40).toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(dateAtHour("2026-10-05", 5 * 8, 40).toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(dateAtHour("2026-10-03", 0, 40).toISOString().slice(0, 10)).toBe("2026-10-05");
  });

  it("collapses the market schedule into bands, leaving Stable out and letting later entries win", () => {
    const c = (id: string, name: string, preset: MarketConditionRow["preset"]) => ({ id, name, preset }) as MarketConditionRow;
    const e = (from_month: number, to_month: number, condition_id: string) => ({ from_month, to_month, condition_id }) as MarketScheduleRow;
    const bands = marketBands(
      { marketConditions: [c("s", "Soft", "soft"), c("d", "Downturn", "downturn"), c("st", "Stable", "stable")], marketSchedule: [e(3, 8, "s"), e(6, 7, "d"), e(9, 12, "st")] },
      12,
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
    expect(hire).toMatchObject({ personId: DEMO_HIRE_ID, label: "Jade Hart starts", when: "1 Feb 2027", from: 3 });
    const leave = data.markers.find((m) => m.kind === "leave")!;
    expect(leave).toMatchObject({ label: "Leah Brooks on leave", when: "14 Dec 2026 to 8 Jan 2027", from: 2, to: 3 });
    // A marker sits on its role's row and its person's.
    expect(data.roles.find((r) => r.name === "PPC specialist")!.markers).toContainEqual(hire);
    expect(data.people.find((p) => p.id === DEMO_HIRE_ID)!.markers).toEqual([hire]);
  });

  it("draws the chart with a row per role or person, the market and a table for screen readers", () => {
    const roles = renderToStaticMarkup(createElement(ForecastTimeline, { data, rows: "roles", busyLine: 0.85, label: "Forecast" }));
    expect(roles.match(/data-row=/g)).toHaveLength(data.roles.length);
    expect(roles).toContain("data-market-band");
    expect(roles).toContain("Jade Hart starts: 1 Feb 2027");
    expect(roles).toContain("<table");
    expect(roles).toContain("October 2026");
    const people = renderToStaticMarkup(createElement(ForecastTimeline, { data, rows: "people", busyLine: 0.85, label: "Forecast" }));
    expect(people.match(/data-row=/g)).toHaveLength(data.people.length);
    expect(people).toContain("not there");
  });
});

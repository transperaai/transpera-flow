// The Sandbox's numbers as files (docs/plans/sandbox-p5-brief.md §6): the numbers CSV (tidy: one row per scenario x measure x group x
// month, then a "Whole run" row where a total means something) and the changes-and-notes CSV. Both are made from runs already on screen.
// Pure: no React. Written through `csvText`, so a scenario's name or a change's note can't run as a spreadsheet formula.
//
// What is left out, whoever asks: anything by person (busy share, labour, time), and labour by role. An export is for sending, and the pay of
// a one-person role is that person's. Costs (labour with overtime, overheads, profit) are in only when `costs` is on and the run has them
// (a Viewer's run has none). The time split is the team's, by category.

import type { PurposeCategory } from "@transpera-flow/db";
import { timeRows, type EffectiveChange, type PriceRiseTradeoff } from "@transpera-flow/db/sandbox";
import type { EngineModel, MonthlyResult, Stat } from "@transpera-flow/engine";
import { csvText, type CsvCell } from "@/lib/export/csv";
import type { TimelineMonth } from "@/lib/forecast/timeline";
import { describeChange, whenOf, type DescribeContext } from "./describe";

export interface ExportColumn {
  name: string;
  monthly: MonthlyResult;
  priceRise: PriceRiseTradeoff | null;
}

export interface ExportOptions {
  currency: string;
  /** Include labour with overtime, overheads and profit (when the run has them). */
  costs: boolean;
  categories: readonly PurposeCategory[];
}

export const NUMBERS_HEADER = ["Scenario", "Measure", "Group", "Month", "Average", "Low (10%)", "High (90%)", "Unit"] as const;

const round = (v: number): number => Math.round(v * 1e6) / 1e6;
const pct = (v: number): number => round(v * 100);

/** The month a row is for: its label (a part month says what it covers). */
const monthName = (m: TimelineMonth): string => m.label;

export function sandboxCsv(columns: readonly ExportColumn[], months: readonly TimelineMonth[], model: Pick<EngineModel, "roles" | "services">, o: ExportOptions): string {
  const rows: CsvCell[][] = [];
  for (const col of columns) {
    const m = col.monthly;
    const n = months.length;
    /** A series with a range, one row a month; with `total`, a "Whole run" row (the months' means added up; no range). */
    const series = (measure: string, group: string, stats: readonly Stat[], unit: string, o2: { scale?: (v: number) => number; total?: boolean | number } = {}) => {
      const f = o2.scale ?? round;
      stats.slice(0, n).forEach((s, i) => rows.push([col.name, measure, group, monthName(months[i]!), f(s.mean), f(s.p10), f(s.p90), unit]));
      if (o2.total) rows.push([col.name, measure, group, "Whole run", f(typeof o2.total === "number" ? o2.total : stats.reduce((a, s) => a + s.mean, 0)), "", "", unit]);
    };
    /** A series with no range (fixed numbers). */
    const plain = (measure: string, group: string, values: readonly (number | null)[], unit: string, total = false) => {
      values.slice(0, n).forEach((v, i) => rows.push([col.name, measure, group, monthName(months[i]!), v === null ? "" : round(v), "", "", unit]));
      if (total) rows.push([col.name, measure, group, "Whole run", round(values.reduce<number>((a, v) => a + (v ?? 0), 0)), "", "", unit]);
    };
    const sum = (list: readonly Stat[]) => list.reduce((a, s) => a + s.mean, 0);

    // Sales.
    series("Opportunities", "", m.sales.opportunities, "count", { total: true });
    series("Wins", "", m.sales.won, "count", { total: true });
    series("Losses", "", m.sales.lost, "count", { total: true });
    const won = sum(m.sales.won);
    const decided = won + sum(m.sales.lost);
    series("Conversion", "", m.sales.conversion, "%", { scale: pct, total: decided > 0 ? pct(won / decided) : 0 });
    // Revenue.
    const revenue: [string, Stat[]][] = [
      ["Total", m.revenue.total],
      ["Recurring", m.revenue.recurring],
      ["One-off", m.revenue.oneOff],
      ["Hourly", m.revenue.hourly],
      ["From new clients", m.revenue.fromNew],
      ["Lost to churn", m.revenue.lostToChurn],
      ["From price rises", m.revenue.rise],
    ];
    for (const [group, stats] of revenue) series("Billed revenue", group, stats, o.currency, { total: true });
    series("Monthly recurring revenue", "", m.mrr, o.currency);
    // Clients.
    for (const key of Object.keys(m.clients).sort()) series("Active clients", serviceName(model, key), m.clients[key]!, "clients");
    series("Clients won", "", m.clientsWon, "clients", { total: true });
    series("Clients lost", "", m.clientsLost, "clients", { total: true });
    for (const key of Object.keys(m.atRisk).sort()) series("Clients at risk", serviceName(model, key), m.atRisk[key]!, "clients");
    // Work.
    for (const [id, role] of Object.entries(model.roles)) {
      const busy = m.roles[id];
      if (busy?.some((b) => b !== null)) {
        busy.slice(0, n).forEach((b, i) => rows.push([col.name, "Busy share", role.name, monthName(months[i]!), b ? pct(b.mean) : "", b ? pct(b.p10) : "", b ? pct(b.p90) : "", "%"]));
      }
      const uncovered = m.uncovered[id];
      if (uncovered?.some((h) => h !== null && h > 0)) plain("Work with nobody there to do it", role.name, uncovered, "hours a week");
    }
    series("Late tasks", "", m.lateTasks, "count", { total: true });
    series("Overtime hours", "", m.overtimeHours, "hours", { total: true });
    // Costs: totals only, never by role or person.
    if (o.costs && m.money) {
      const labour = m.money.labour.map((v, i) => ({ mean: v + m.money!.overtimeCost[i]!.mean, p10: v + m.money!.overtimeCost[i]!.p10, p90: v + m.money!.overtimeCost[i]!.p90 }));
      series("Labour and overtime", "", labour, o.currency, { total: true });
      plain("Overheads", "", m.money.overheads, o.currency, true);
      series("Profit", "", m.money.profit, o.currency, { total: true });
    }
    // A price rise (revenue, not pay): what it gains, loses and nets, and the extra leavers.
    if (col.priceRise) {
      const p = col.priceRise;
      series("Price rise", "Gained", p.gained, o.currency, { total: p.total.gained.mean });
      series("Price rise", "Lost", p.lost, o.currency, { total: p.total.lost.mean });
      series("Price rise", "Net", p.net, o.currency, { total: p.total.net.mean });
      series("Price rise", "Extra leavers", p.extraLeavers, "clients", { total: p.total.extraLeavers.mean });
    }
    // Where the time goes: the team's hours and share of the hours available, by what the work achieves.
    const time = timeRows(m, n, o.categories, { kind: "team" });
    for (const r of time.rows) {
      series(`Time: ${r.name}`, "Team", r.hours, "hours", { total: r.runHours });
      plain(`Time share: ${r.name}`, "Team", r.share.map((s) => pct(s)), "% of hours available");
      rows.push([col.name, `Time share: ${r.name}`, "Team", "Whole run", pct(r.runShare), "", "", "% of hours available"]);
    }
  }
  return csvText(NUMBERS_HEADER, rows);
}

const serviceName = (model: Pick<EngineModel, "services">, key: string): string => (key ? (model.services?.[key]?.name ?? "Other") : "Clients");

export const CHANGES_HEADER = ["Scenario", "Change", "When", "Note", "From scenario"] as const;

/** One row per effective change of each column ("No changes" has none): the change in words, when, the note saying why, and the scenario it comes from when that is a parent. */
export function changesCsv(columns: readonly { name: string; changes: readonly EffectiveChange[] }[], ctx: Omit<DescribeContext, "changes">): string {
  const rows: CsvCell[][] = [];
  for (const col of columns) {
    const all = col.changes.map((e) => e.change);
    for (const e of col.changes) {
      rows.push([col.name, describeChange(e.change, { ...ctx, changes: all }), whenOf(e.change) ?? "the whole run", e.change.note ?? "", e.inherited ? e.scenarioName : ""]);
    }
  }
  return csvText(CHANGES_HEADER, rows);
}

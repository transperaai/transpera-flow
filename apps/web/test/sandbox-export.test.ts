import { describe, expect, it } from "vitest";
import { DEFAULT_PURPOSES, northbeamRoleIds, type SandboxChange } from "@transpera-flow/db";
import { prepareScenario, priceRiseTradeoff } from "@transpera-flow/db/sandbox";
import { simulate, type MonthlyResult } from "@transpera-flow/engine";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { timelineMonths } from "@/lib/forecast/timeline";
import { changesCsv, sandboxCsv, CHANGES_HEADER, NUMBERS_HEADER, type ExportColumn } from "@/lib/sandbox/export";

// The Sandbox's files (sandbox phase 5a, docs/plans/sandbox-p5-brief.md §6): the numbers CSV and the changes-and-notes CSV, made from
// runs already made. Pure.

const START = DEMO_FORECAST_START;
const base = demoForecastBundle();
const hiddenPay = { ...base, viewer: { seesEveryone: false, ownPersonId: null } };
const PPC = northbeamRoleIds.ppc;
const hire: SandboxChange = { id: "7e000000-0000-4000-8000-000000000001", lever: "D1", target: PPC, op: "set", value: 1, from: "2027-01", note: "Assumes we can hire by January." };
const rise: SandboxChange = { id: "7e000000-0000-4000-8000-000000000002", lever: "B5", target: null, op: "set", value: 0.08, from: "2027-03", note: '=HYPERLINK("http://evil.example","x"), "quoted"' };
const eff = (list: SandboxChange[], name = "S") => list.map((c) => ({ change: c, scenarioId: "s", scenarioName: name, inherited: false }));

function column(bundle: typeof base, name: string, changes: SandboxChange[]): ExportColumn & { prepared: ReturnType<typeof prepareScenario> } {
  const prepared = prepareScenario(bundle, eff(changes), [], 6, START);
  if (prepared.error !== null) throw new Error(prepared.error);
  const go = (m: (typeof prepared.segments)[number]["model"]) => simulate(m, 4, 1, { monthly: true, monthStarts: prepared.monthStarts, ...(prepared.start ? { initialState: prepared.start } : {}) });
  const run = go(prepared.segments[0]!.model);
  const pair = prepared.pair ? go(prepared.pair[0]!.model) : null;
  const priceRise = pair ? priceRiseTradeoff(run.monthlySamples!, pair.monthlySamples!, prepared.riseMonths) : null;
  return { name, monthly: run.monthly as MonthlyResult, priceRise, prepared };
}

/** A small CSV reader: quoted cells (with "" for a quote), CRLF rows, the byte order mark dropped. */
function parse(csv: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const text = csv.replace(/^\ufeff/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (row.push(cell), (cell = ""));
    else if (ch === "\r" && text[i + 1] === "\n") (row.push(cell), out.push(row), (row = []), (cell = ""), i++);
    else cell += ch;
  }
  return out;
}
const hasAll = (set: Set<string>, ...items: string[]) => items.every((i) => set.has(i));

const open = [column(base, "No changes", []), column(base, 'Hire & "rise"', [hire, rise])];
const closed = [column(hiddenPay, "No changes", []), column(hiddenPay, "Viewer hire", [hire])];
const months = timelineMonths(START, open[0]!.monthly.months, base.workspace.settings.hours_per_week);
const model = open[0]!.prepared.segments[0]!.model;
const o = { currency: "GBP", costs: true, categories: DEFAULT_PURPOSES };
const rowsOf = (cols: ExportColumn[], opts = o) => parse(sandboxCsv(cols, months, model, opts)).slice(1);

describe("the numbers CSV", () => {
  const csv = sandboxCsv(open, months, model, o);
  const rows = rowsOf(open);

  it("starts with the byte order mark, the agreed header and CRLF line ends", () => {
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.split("\r\n")[0]).toBe(`﻿${NUMBERS_HEADER.join(",")}`);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("has a row per scenario, measure, group and month, then a Whole run row where a total means something", () => {
    const scenarios = new Set(rows.map((r) => r[0]));
    expect([...scenarios]).toEqual(["No changes", 'Hire & "rise"']);
    const wins = rows.filter((r) => r[0] === "No changes" && r[1] === "Wins");
    expect(wins).toHaveLength(months.length + 1);
    expect(wins.slice(0, -1).map((r) => r[3])).toEqual(months.map((m) => m.label));
    const whole = wins[wins.length - 1]!;
    expect(whole.slice(3)).toEqual(["Whole run", String(Number(whole[4])), "", "", "count"]);
    const sum = wins.slice(0, -1).reduce((a, r) => a + Number(r[4]), 0);
    expect(Number(whole[4])).toBeCloseTo(sum, 4);
    // A stock has no whole-run row.
    expect(rows.filter((r) => r[1] === "Monthly recurring revenue" && r[3] === "Whole run")).toEqual([]);
    expect(rows.filter((r) => r[1] === "Active clients" && r[3] === "Whole run")).toEqual([]);
  });

  it("carries a range on each month (low at most the average, at most the high) and the unit", () => {
    for (const r of rows.filter((x) => x[1] === "Billed revenue" && x[3] !== "Whole run")) {
      expect(Number(r[5])).toBeLessThanOrEqual(Number(r[4]) + 1e-6);
      expect(Number(r[6])).toBeGreaterThanOrEqual(Number(r[4]) - 1e-6);
      expect(r[7]).toBe("GBP");
    }
    expect(new Set(rows.filter((x) => x[1] === "Busy share").map((x) => x[7]))).toEqual(new Set(["%"]));
    expect(rows.filter((x) => x[1] === "Conversion").every((x) => x[7] === "%")).toBe(true);
  });

  it("has revenue split three ways and by where it came from", () => {
    const groups = new Set(rows.filter((r) => r[1] === "Billed revenue").map((r) => r[2]));
    expect(groups).toEqual(new Set(["Total", "Recurring", "One-off", "Hourly", "From new clients", "Lost to churn", "From price rises"]));
  });

  it("has the price rise's gained, lost, net and extra leavers for the column that has one", () => {
    const groups = (name: string) => new Set(rows.filter((r) => r[0] === name && r[1] === "Price rise").map((r) => r[2]));
    expect(groups('Hire & "rise"')).toEqual(new Set(["Gained", "Lost", "Net", "Extra leavers"]));
    expect(groups("No changes").size).toBe(0);
  });

  it("has the team's time by purpose, hours and share, with Idle and the work nobody was there for", () => {
    const hours = rows.filter((r) => r[0] === "No changes" && r[1].startsWith("Time: "));
    expect(hasAll(new Set(hours.map((r) => r[1])), "Time: Fixing", "Time: Client upkeep", "Time: Idle")).toBe(true);
    expect(new Set(hours.map((r) => r[2]))).toEqual(new Set(["Team"]));
    expect(rows.filter((r) => r[1] === "Time share: Fixing" && r[3] === "Whole run")).toHaveLength(2);
    expect(hours.every((r) => ["hours"].includes(r[7]))).toBe(true);
  });

  it("includes costs only when asked, and only as totals: labour with overtime, overheads and profit", () => {
    const withCosts = new Set(rows.map((r) => r[1]));
    expect(hasAll(withCosts, "Labour and overtime", "Overheads", "Profit")).toBe(true);
    const without = new Set(rowsOf(open, { ...o, costs: false }).map((r) => r[1]));
    for (const m of ["Labour and overtime", "Overheads", "Profit"]) expect(without.has(m), m).toBe(false);
    expect(without.has("Billed revenue")).toBe(true);
  });

  it("never has a row by person, or labour by role or person", () => {
    const text = csv;
    for (const person of ["Dan Okafor", "Maya Collins", "Leah Brooks"]) expect(text).not.toContain(person);
    const measures = new Set(rows.map((r) => r[1]));
    for (const m of measures) expect(m, m).not.toMatch(/labour.*(role|person)|by person/i);
    // The only group names under a pay measure are none: labour and overheads are one total.
    expect(new Set(rows.filter((r) => r[1] === "Labour and overtime" || r[1] === "Profit").map((r) => r[2]))).toEqual(new Set([""]));
  });

  it("has no cost rows for a reader who may not see pay, even when asked", () => {
    const viewerRows = rowsOf(closed);
    const measures = new Set(viewerRows.map((r) => r[1]));
    for (const m of ["Labour and overtime", "Overheads", "Profit"]) expect(measures.has(m), m).toBe(false);
    expect(measures.has("Billed revenue")).toBe(true);
    expect(measures.has("Time: Fixing")).toBe(true);
  });

  it("writes a scenario name that starts like a formula as text, and quotes one with commas and quotes", () => {
    const evil = [{ ...open[0]!, name: "=cmd|' /C calc'!A0" }, { ...open[1]!, name: '+1,"x"' }];
    const raw = sandboxCsv(evil, months, model, o);
    expect(raw).toContain("'=cmd|' /C calc'!A0,");
    expect(raw).toContain(`"'+1,""x"""`);
    expect(raw.split("\r\n").some((l) => /^[=+\-@]/.test(l))).toBe(false);
  });
});

describe("the changes and notes CSV", () => {
  const ctx = { bundle: base, solutions: [] };
  const columns = [
    { name: "No changes", changes: [] },
    { name: 'Hire & "rise"', changes: [...eff([hire], "Parent").map((e) => ({ ...e, inherited: true })), ...eff([rise], 'Hire & "rise"')] },
  ];
  const csv = changesCsv(columns, ctx);
  const rows = parse(csv);

  it("has the agreed header and a row per effective change, worded, with when, the note and where it comes from", () => {
    expect(rows[0]).toEqual([...CHANGES_HEADER]);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(['Hire & "rise"', expect.stringMatching(/New PPC specialist starts/), "from Jan 2027", "Assumes we can hire by January.", "Parent"]);
    expect(rows[2]![0]).toBe('Hire & "rise"');
    expect(rows[2]![1]).toMatch(/Price rise of 8/);
    expect(rows[2]![4]).toBe("");
  });

  it("has no row for No changes, and writes a note that looks like a formula as text", () => {
    expect(rows.some((r) => r[0] === "No changes")).toBe(false);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x""), ""quoted"""`);
  });
});

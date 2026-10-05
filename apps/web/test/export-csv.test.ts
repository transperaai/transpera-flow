import { describe, expect, it } from "vitest";
import { northbeamIssues, type IssueRow } from "@transpera-flow/db";
import { noCost, type IssueCost } from "@transpera-flow/engine";
import { csvCell, csvText } from "@/lib/export/csv";
import { ISSUES_CSV_HEADER, issuesCsv } from "@/lib/issues/csv";
import { listIssues } from "@/lib/issues/pages";

// The issues CSV (issue #39, B10): the listed columns and headers, the Issues list's filters, and cells a spreadsheet
// can't run as formulas.

const names = { processes: new Map([["p1", "Intake"]]), steps: new Map([["s1", "Check fit"], ["s2", "Send quote"]]), people: new Map([["u1", "Rosa"], ["u2", "Kofi"]]) };
const issue = (n: number, extra: Partial<IssueRow> = {}): IssueRow => ({ ...northbeamIssues()[0]!, title: `Issue ${n}`, target_measure: null, target_now: null, target_goal: null, links: [], owner_ids: [], process_id: null, step_id: null, number: n, id: `00000000-0000-4000-8000-0000000000${n}`, ...extra });
const parse = (csv: string) => csv.replace(/^﻿/, "").trimEnd().split("\r\n");

describe("CSV cells", () => {
  it.each(["=SUM(A1)", "+1", "-2", "@cmd", "\tx", "\rx"])("defuses a cell that starts with %j", (v) => {
    const cell = csvCell(v);
    expect(cell.replace(/^"/, "").startsWith("'")).toBe(true);
    expect(cell).toContain(v.replace(/"/g, '""'));
  });
  it("leaves ordinary text alone, quotes what needs it and writes numbers as numbers", () => {
    expect(csvCell("Wait at Check fit")).toBe("Wait at Check fit");
    expect(csvCell('a "quoted", line\nbreak')).toBe('"a ""quoted"", line\nbreak"');
    expect(csvCell(12)).toBe("12");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(NaN)).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell("a=b")).toBe("a=b");
  });
  it("starts with a byte order mark and ends lines with CRLF", () => {
    const t = csvText(["a", "b"], [[1, "x"]]);
    expect(t.startsWith("﻿")).toBe(true);
    expect(t).toBe("﻿a,b\r\n1,x\r\n");
  });
});

describe("issues CSV", () => {
  it("has the listed columns, in order, with correct headers", () => {
    expect(ISSUES_CSV_HEADER.slice(0, 13)).toEqual([
      "Number", "Title", "Rating", "Status", "Process", "Steps", "Owners", "Target measure", "Target now", "Target goal", "Estimated cost per month", "Currency", "Created",
    ]);
    expect(ISSUES_CSV_HEADER[13]).toBe("Resolved");
    const lines = parse(issuesCsv([], names, () => null, "GBP"));
    expect(lines).toEqual([ISSUES_CSV_HEADER.join(",")]);
  });

  it("writes one row per issue with names, owners, target, cost and dates", () => {
    const i = issue(7, {
      title: "Quotes wait for sign-off",
      severity: "serious",
      status: "resolved",
      process_id: "p1",
      links: [{ process_id: "p1", step_id: "s1" }, { process_id: "p1", step_id: "s2" }],
      owner_ids: ["u1", "u2"],
      target_measure: "Wait at Check fit",
      target_now: "1.4 d",
      target_goal: "under 4 hours",
      created_at: "2026-09-01T10:00:00Z",
      resolved_at: "2026-09-20T10:00:00Z",
    });
    const cost: IssueCost = { perMonth: 1234.56, hoursPerMonth: null, method: "x" };
    const [, row] = parse(issuesCsv([i], names, () => cost, "GBP"));
    expect(row).toBe(`7,Quotes wait for sign-off,"Bad, not urgent",Resolved,Intake,Check fit; Send quote,Rosa; Kofi,Wait at Check fit,1.4 d,under 4 hours,1235,GBP,2026-09-01,2026-09-20`);
  });

  it("writes a time-only cost as hours and no cost as empty", () => {
    const a = issue(1);
    const b = issue(2);
    const cost = (i: IssueRow): IssueCost => (i.number === 1 ? { perMonth: null, hoursPerMonth: 12.34, method: "" } : noCost(""));
    const rows = parse(issuesCsv([a, b], names, cost, "GBP")).slice(1);
    expect(rows[0]!.split(",")).toContain("12.3 h");
    expect(rows[1]!.split(",")[10]).toBe("");
  });

  it("is safe to open in a spreadsheet: hostile titles, targets and names are defused", () => {
    const i = issue(3, { title: '=HYPERLINK("http://evil.example","x")', target_goal: "@SUM(A1)", target_now: "+1+1", owner_ids: ["u9"] });
    const text = issuesCsv([i], { ...names, people: new Map([["u9", "-cmd|' /C calc'!A0"]]) }, () => null, "GBP");
    const cells = (text.split("\r\n")[1] ?? "");
    expect(cells).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(cells).toContain("'@SUM(A1)");
    expect(cells).toContain("'+1+1");
    expect(cells).toContain("'-cmd|' /C calc'!A0");
    // No cell of the file starts with a formula character after the header (the number column is a number).
    for (const line of parse(text).slice(1)) for (const c of line.split(",")) expect(/^[=+@\t\r]/.test(c)).toBe(false);
  });

  it("honours the list's filters: exactly the issues the list shows, in its order", () => {
    const rows = [
      issue(1, { severity: "serious", status: "open" }),
      issue(2, { severity: "critical", status: "open" }),
      issue(3, { severity: "serious", status: "resolved", resolved_at: "2026-09-30T00:00:00Z" }),
      issue(4, { severity: "warning", status: "wont_fix", resolved_at: "2026-09-30T00:00:00Z" }),
    ];
    const numbers = (list: IssueRow[]) => parse(issuesCsv(list, names, () => null, "GBP")).slice(1).map((l) => l.split(",")[0]);
    expect(numbers(listIssues(rows, { show: "open", rating: "" }))).toEqual(["2", "1"]);
    expect(numbers(listIssues(rows, { show: "resolved", rating: "" }))).toEqual(["3", "4"]);
    expect(numbers(listIssues(rows, { show: "all", rating: "bad" }))).toEqual(["1", "3"]);
    expect(numbers(listIssues(rows, { show: "all", rating: "" }))).toHaveLength(4);
  });
});

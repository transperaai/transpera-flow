import { describe, expect, it } from "vitest";
import { calibrate } from "@transpera-flow/engine";
import {
  calibrationInput,
  decodeLogFile,
  detectDateOrder,
  leadsArriveAt,
  northbeamBundle,
  parseLogTime,
  parseStepLog,
  routingSource,
  splitCsv,
  STEP_LOG_TEMPLATE,
  type EdgeRow,
  type StepRow,
} from "../src";

// Reading a step log for calibration (issue #41) and turning stored rows into the engine's input. No database.

describe("splitCsv", () => {
  it("reads commas, quotes and line endings", () => {
    expect(splitCsv('a,b\r\n"x, y","say ""hi"""\n1,\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", ""],
    ]);
  });

  it("reads tabs (pasted from a spreadsheet) and semicolons", () => {
    expect(splitCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(splitCsv("a;b\n1,5;2")).toEqual([
      ["a", "b"],
      ["1,5", "2"],
    ]);
  });
});

describe("parseLogTime", () => {
  it("reads ISO dates and times, with or without a zone", () => {
    expect(parseLogTime("2026-03-02")).toBe(Date.UTC(2026, 2, 2));
    expect(parseLogTime("2026-03-02 09:30")).toBe(Date.UTC(2026, 2, 2, 9, 30));
    expect(parseLogTime("2026-03-02T09:30:15Z")).toBe(Date.UTC(2026, 2, 2, 9, 30, 15));
    expect(parseLogTime("2026-03-02T09:30:00+10:00")).toBe(Date.UTC(2026, 2, 1, 23, 30));
  });

  it("reads slashes day first", () => {
    expect(parseLogTime("02/03/2026")).toBe(Date.UTC(2026, 2, 2));
    expect(parseLogTime("2/3/2026 17:05")).toBe(Date.UTC(2026, 2, 2, 17, 5));
  });

  it("refuses what isn't a date", () => {
    for (const s of ["", "yesterday", "2026-02-31", "13/13/2026", "2026-03-02 25:00"]) expect(parseLogTime(s), s).toBeNull();
  });
});

describe("parseStepLog", () => {
  it("finds the columns by common names and reads the rows", () => {
    const log = parseStepLog("Deal ID,Stage,Start time,Completed at,Hours spent,Lead source\nD1,Qualify,2026-03-02 09:00,2026-03-02 10:30,1.5,Website\n\nD1,Lost,2026-03-03,,,\n");
    expect(log.missing).toEqual([]);
    expect(log.columns).toEqual({ item: "Deal ID", step: "Stage", started: "Start time", finished: "Completed at", hours: "Hours spent", source: "Lead source" });
    expect(log.lines).toBe(2);
    expect(log.errors).toEqual([]);
    expect(log.rows).toEqual([
      { item: "D1", step: "Qualify", started: Date.UTC(2026, 2, 2, 9), finished: Date.UTC(2026, 2, 2, 10, 30), hours: 1.5, source: "Website" },
      { item: "D1", step: "Lost", started: Date.UTC(2026, 2, 3), finished: null, hours: null, source: null },
    ]);
  });

  it("says which required columns are missing, and reads nothing then", () => {
    const log = parseStepLog("when,what\n2026-03-02,Qualify");
    expect(log.missing).toEqual(["item", "step", "started"]);
    expect(log.rows).toEqual([]);
  });

  it("reports bad rows by line and keeps the good ones", () => {
    const log = parseStepLog(
      ["item,step,started,finished,hours", "D1,Qualify,2026-03-02,2026-03-01,", "D2,,2026-03-02,,", "D3,Qualify,next week,,", "D4,Qualify,2026-03-02,,-1", "D5,Qualify,2026-03-02,,2,5"].join("\n"),
    );
    expect(log.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(log.errors[0]!.message).toBe("It finished before it started.");
    expect(log.errors[1]!.message).toBe("Missing step.");
    expect(log.rows.map((r) => r.item)).toEqual(["D5"]);
  });

  it("reads its own template", () => {
    const log = parseStepLog(STEP_LOG_TEMPLATE);
    expect(log.errors).toEqual([]);
    expect(log.rows).toHaveLength(6);
  });
});

describe("day and month order", () => {
  const log = (...dates: string[]) => ["item,step,started", ...dates.map((d, i) => `I${i},Qualify,${d}`)].join("\n");

  it("is found from the whole file", () => {
    expect(detectDateOrder(["02/03/2026", "13/03/2026"])).toBe("dmy");
    expect(detectDateOrder(["02/03/2026", "03/13/2026"])).toBe("mdy");
    expect(detectDateOrder(["02/03/2026", "04/05/2026 10:00"])).toBe("ambiguous");
    expect(detectDateOrder(["13/03/2026", "03/13/2026"])).toBe("mixed");
    expect(detectDateOrder(["2026-03-02"])).toBeNull();
  });

  it("reads every date the same way round", () => {
    const dmy = parseStepLog(log("02/03/2026", "13/03/2026"));
    expect(dmy.dateOrder).toBe("dmy");
    expect(dmy.rows.map((r) => r.started)).toEqual([Date.UTC(2026, 2, 2), Date.UTC(2026, 2, 13)]);
    const mdy = parseStepLog(log("02/03/2026", "03/13/2026"));
    expect(mdy.dateOrder).toBe("mdy");
    expect(mdy.rows.map((r) => r.started)).toEqual([Date.UTC(2026, 1, 3), Date.UTC(2026, 2, 13)]);
  });

  it("asks when the file can't tell, and reads nothing until told", () => {
    const asked = parseStepLog(log("02/03/2026", "04/05/2026"));
    expect(asked.dateProblem).toBe("ambiguous");
    expect(asked.rows).toEqual([]);
    const told = parseStepLog(log("02/03/2026", "04/05/2026"), { dateOrder: "mdy" });
    expect(told.dateProblem).toBeNull();
    expect(told.rows.map((r) => r.started)).toEqual([Date.UTC(2026, 1, 3), Date.UTC(2026, 3, 5)]);
  });

  it("refuses a file that has dates both ways round", () => {
    const mixed = parseStepLog(log("13/03/2026", "03/13/2026"), { dateOrder: "dmy" });
    expect(mixed.dateProblem).toBe("mixed");
    expect(mixed.rows).toEqual([]);
  });
});

describe("decodeLogFile", () => {
  it("reads UTF-8, UTF-16 with a byte-order mark, and falls back to Windows text with a note", () => {
    expect(decodeLogFile(new TextEncoder().encode("\uFEFFitem,step\nA,Café"))).toEqual({ text: "item,step\nA,Café", note: null });
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from("a,é").flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(decodeLogFile(utf16)).toEqual({ text: "a,é", note: null });
    const latin1 = decodeLogFile(new Uint8Array([0x61, 0x2c, 0xe9]));
    expect(latin1.text).toBe("a,é");
    expect(latin1.note).toMatch(/CSV UTF-8/);
  });
});

describe("calibrationInput", () => {
  const bundle = northbeamBundle();

  it("maps Northbeam's rows: steps with their sources, edges, and lead sources (leads arrive at the pipeline)", () => {
    const input = calibrationInput(
      {
        process: bundle.process,
        steps: bundle.steps,
        edges: bundle.edges,
        services: bundle.services,
        leadSources: bundle.leadSources ?? [],
        seasonality: [{ month: 12, multiplier: 0.5 }],
        hoursPerWeek: 40,
      },
      [],
    );
    const audit = input.steps.find((s) => s.name === "Audit & proposal")!;
    expect(audit).toMatchObject({ kind: "task", worked: true, workHours: 6, rework: 0.15, sources: { work: "estimated" } });
    expect(input.steps.find((s) => s.name === "Client decision")!.worked).toBe(false);
    expect(input.leadSources!.map((s) => s.name).sort()).toEqual(["Client referrals", "Google Ads", "Website enquiries"]);
    expect(input.seasonality![11]).toBe(0.5);
    expect(input.seasonality![0]).toBe(1);
  });

  it("measures leads only where they arrive", () => {
    const services = [{ active: true, entry_process_id: null }];
    expect(leadsArriveAt({ id: "p", kind: "pipeline", parent_process_id: null }, services)).toBe(true);
    expect(leadsArriveAt({ id: "p", kind: "servicing", parent_process_id: null }, services)).toBe(false);
    expect(leadsArriveAt({ id: "p", kind: "pipeline", parent_process_id: "q" }, services)).toBe(false);
    expect(leadsArriveAt({ id: "p", kind: "pipeline", parent_process_id: null }, [{ active: true, entry_process_id: "other" }])).toBe(false);
    expect(leadsArriveAt({ id: "p", kind: "pipeline", parent_process_id: null }, [{ active: true, entry_process_id: "p" }])).toBe(true);
  });

  it("calls branch odds measured only while they match what was measured, and estimated while any are missing", () => {
    const step = { id: "s", provenance: {} } as Pick<StepRow, "id" | "provenance">;
    const edges = [
      { id: "e1", from_step_id: "s", probability: 0.6 },
      { id: "e2", from_step_id: "s", probability: 0.4 },
    ] as Pick<EdgeRow, "id" | "from_step_id" | "probability">[];
    expect(routingSource(step, edges)).toBe("entered");
    const measured = { ...step, provenance: { routing: { source: "measured", probabilities: { e1: 0.6, e2: 0.4 } } } } as unknown as StepRow;
    expect(routingSource(measured, edges)).toBe("measured");
    expect(routingSource(measured, [edges[0]!, { ...edges[1]!, probability: 0.3 }])).toBe("entered");
    expect(routingSource({ ...step, provenance: { branch_odds: { was: {} } } } as unknown as StepRow, edges)).toBe("estimated");
  });

  it("feeds the engine: a Northbeam log gives proposals for its steps", () => {
    const rows = parseStepLog(
      ["item,step,started,finished,hours", ...Array.from({ length: 12 }, (_, i) => `L${i},Qualify lead,2026-03-${String(i + 1).padStart(2, "0")} 09:00,2026-03-${String(i + 1).padStart(2, "0")} 10:00,1`)].join("\n"),
    ).rows;
    const result = calibrate(
      calibrationInput(
        { process: bundle.process, steps: bundle.steps, edges: bundle.edges, services: bundle.services, leadSources: [], seasonality: [], hoursPerWeek: 40 },
        rows,
      ),
    );
    const qualify = result.proposals.find((p) => p.kind === "work" && p.subject === "Qualify lead")!;
    expect(qualify).toMatchObject({ n: 12, enough: true, current: 0.5, proposed: 1 });
  });
});

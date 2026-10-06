import { describe, expect, it } from "vitest";
import {
  IMPORT_KINDS,
  IMPORT_KIND_LIST,
  applyNameMap,
  applyNameMapCounted,
  columnMapValue,
  dealsNote,
  dealsToStepLog,
  decodeImportFile,
  displayHeaders,
  importDetails,
  invoicesSummary,
  jobsToServicing,
  leadsSummary,
  loadTable,
  parseAmount,
  parseDuration,
  readImport,
  storedInvoicesSummary,
  storedLeadsSummary,
  suggestMapping,
  suggestNameMap,
  timeLogToStepLog,
  type DealRow,
  type ImportKind,
  type ImportRead,
  type InvoiceRow,
  type JobRow,
  type LeadRow,
  type TimeLogRow,
} from "../src/csv-import";
import { detectDateOrder, detectDelimiter, hasTimeOfDay, parseLogTime, splitCsv } from "../src/calibration";
import { parseServicingLog } from "../src/client-calibration";

// The import wizard's pure core (issue #40): suggesting a mapping, reading eight kinds of file, converting them into the
// shapes calibration reads, and what may be stored. No database.

const d = (y: number, m: number, day: number, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, day, h, mi, s);
const read = (text: string, kind: ImportKind, index?: Record<string, number | null>, options: Parameters<typeof readImport>[3] = {}): ImportRead => {
  const table = splitCsv(text);
  const header = table.find((r) => r.some((c) => c.trim() !== "")) ?? [];
  return readImport(table, kind, index ?? suggestMapping(header, kind).index, options);
};

describe("suggestMapping", () => {
  it("maps each kind's template fully, with no previous import", () => {
    for (const kind of IMPORT_KIND_LIST) {
      const spec = IMPORT_KINDS[kind];
      const header = splitCsv(spec.template)[0]!;
      const { index, how } = suggestMapping(header, kind);
      for (const c of spec.columns) {
        expect(index[c.id], `${kind}.${c.id}`).not.toBeNull();
        expect(how[c.id], `${kind}.${c.id}`).toBe("name");
      }
      expect(new Set(Object.values(index)).size).toBe(spec.columns.length);
    }
  });

  it("maps a HubSpot-like deals export", () => {
    const header = ["Record ID", "Deal Name", "Deal Stage", "Date entered stage", "Original Source", "Amount", "Deal owner"];
    const { index, how } = suggestMapping(header, "deals");
    expect(index).toEqual({ deal: 0, stage: 2, entered: 3, left: null, source: 4, amount: 5, owner: 6 });
    expect(how.entered).toBe("partial");
    expect(how.stage).toBe("name");
    expect(how.left).toBeNull();
  });

  it("prefers the earlier import's choice, then a name, then a partial match", () => {
    const header = ["Stage", "Pipeline Stage", "Deal Stage Name", "Deal", "Entered"];
    expect(suggestMapping(header, "deals", { stage: "pipeline  stage" }).index.stage).toBe(1);
    expect(suggestMapping(header, "deals", { stage: "pipeline  stage" }).how.stage).toBe("previous");
    expect(suggestMapping(header, "deals").index.stage).toBe(0);
    expect(suggestMapping(["Deal Stage Name", "Deal", "Entered"], "deals").how.stage).toBe("partial");
    // A previous header that is no longer in the file falls back to the suggestion.
    expect(suggestMapping(header, "deals", { stage: "Gone" }).how.stage).toBe("name");
  });

  it("never uses a header twice", () => {
    const { index } = suggestMapping(["Date", "Source"], "leads");
    expect(index.created).toBe(0);
    expect(index.source).toBe(1);
    const { index: two } = suggestMapping(["Stage", "Entered"], "deals");
    expect(Object.values(two).filter((v) => v !== null)).toHaveLength(new Set(Object.values(two).filter((v) => v !== null)).size);
    // One "Date" header can't be both the date entered and the date left.
    const one = suggestMapping(["Deal", "Stage", "Date"], "deals");
    expect(one.index.entered).toBe(2);
    expect(one.index.left).toBeNull();
  });

  it("matches required columns before optional ones", () => {
    // "Reference" is an alias of both the job (optional) and, as a whole word, nothing required; the required type and client go first.
    const { index } = suggestMapping(["Reference", "Ticket Type", "Company", "Due date"], "jobs");
    expect(index).toMatchObject({ type: 1, client: 2, due: 3, job: 0 });
    // Required columns may be matched by whole words; optional ones may not.
    const optional = suggestMapping(["Ticket", "Type", "Client", "Due", "Date closed"], "jobs");
    expect(optional.index.closed).toBeNull();
  });

  it("matches whole words only", () => {
    expect(suggestMapping(["Stagecoach", "Deal", "Entered"], "deals").index.stage).toBeNull();
    expect(suggestMapping(["Deal Stage Name", "Deal", "Entered"], "deals").index.stage).toBe(0);
  });

  it("uses the display names of empty and repeated headers", () => {
    expect(displayHeaders(["Stage", "", " ", "Stage", "Stage", "Date"])).toEqual(["Stage", "Column 2", "Column 3", "Stage (2)", "Stage (3)", "Date"]);
    expect(suggestMapping(["Deal", "", "Stage"], "deals", { entered: "Column 2" }).index.entered).toBe(1);
  });
});

describe("column_map", () => {
  const mapOf = (text: string, kind: ImportKind, headerRow = 1) => {
    const l = loadTable(text, "auto", headerRow);
    if ("error" in l) throw new Error(l.error);
    const { index } = suggestMapping(l.headers, kind);
    return { l, index };
  };

  it("holds a position, not the header, for client, person, id and amount columns", () => {
    const deals = IMPORT_KINDS.deals.columns;
    const by = (id: string) => deals.find((c) => c.id === id)!;
    expect(columnMapValue(by("deal"), "Record ID", 0)).toBe("Column 1");
    expect(columnMapValue(by("owner"), "Deal owner", 6)).toBe("Column 7");
    expect(columnMapValue(by("amount"), "Amount", 5)).toBe("Column 6");
    expect(columnMapValue(IMPORT_KINDS.time_logs.columns.find((c) => c.id === "client")!, "Customer", 5)).toBe("Column 6");
    expect(columnMapValue(by("stage"), "  Deal Stage ", 2)).toBe("Deal Stage");
    // Text that isn't one of the column's names is not certainly a header, so it is stored by position.
    expect(columnMapValue(by("stage"), "Qualified lead", 1)).toBe("Column 2");
    expect(columnMapValue(by("stage"), "x".repeat(100), 2)).toBe("Column 3");
  });

  it("never holds a cell value when the file has no header row", () => {
    // The first data row is taken as the names: "ACME Ltd" and "Jane Secretperson" are not headers.
    const text = "D-101,Qualified lead,2026-03-02,ACME Ltd,£9999,Jane Secretperson\nD-102,Won,2026-03-03,Smith Ltd,£100,Sam";
    const { l } = mapOf(text, "deals");
    const index: Record<string, number | null> = { deal: 0, stage: 1, entered: 2, amount: 4, owner: 5, left: null, source: 3 };
    const map: Record<string, string> = {};
    for (const c of IMPORT_KINDS.deals.columns) if (index[c.id] !== null) map[c.id] = columnMapValue(c, l.headers[index[c.id]!]!, index[c.id]!);
    expect(map).toMatchObject({ deal: "Column 1", amount: "Column 5", owner: "Column 6" });
    const cells = new Set(text.split(/[\n,]/));
    for (const id of ["deal", "amount", "owner"]) expect(cells.has(map[id]!), id).toBe(false);
    // The client column of time logs, the same.
    const t = mapOf("J1,Audit,2026-03-02,2,Jane Secretperson,ACME Ltd\nJ2,Audit,2026-03-03,2,Sam,Smith Ltd", "time_logs").l;
    const person = IMPORT_KINDS.time_logs.columns.find((c) => c.id === "person")!;
    expect(columnMapValue(person, t.headers[4]!, 4)).toBe("Column 5");
  });

  it("never holds a value from the file in any column of any kind, with or without a header row", () => {
    const sample = (type: string, i: number) =>
      type === "date" ? `2026-03-0${(i % 8) + 1}` : type === "duration" ? `${i + 1}.5` : type === "amount" ? `£${9000 + i}` : `Secret value ${i} (Jane Secretperson, ACME Ltd)`;
    for (const kind of IMPORT_KIND_LIST) {
      const spec = IMPORT_KINDS[kind];
      const row = (n: number) => spec.columns.map((c, i) => sample(c.type, i + n));
      // No header row: the first data row is taken as the names, and every column is matched to a cell of it.
      const text = [row(0), row(1), row(2)].map((r) => r.join(",")).join("\n");
      const l = loadTable(text, ",", 1);
      if ("error" in l) throw new Error(l.error);
      const cells = new Set(text.split(/[\n,]/));
      spec.columns.forEach((c, i) => {
        const v = columnMapValue(c, l.headers[i]!, i);
        expect(cells.has(v), `${kind}.${c.id} (${v})`).toBe(false);
        expect(v.length, `${kind}.${c.id}`).toBeLessThanOrEqual(60);
      });
      // Real headers: a column named as the template names it keeps its name (the identity columns are always positions).
      const t = loadTable(spec.template, ",", 1);
      if ("error" in t) throw new Error(t.error);
      const { index } = suggestMapping(t.headers, kind);
      for (const c of spec.columns) {
        const at = index[c.id]!;
        const v = columnMapValue(c, t.headers[at]!, at);
        const identity = c.type === "client" || c.type === "person" || c.type === "id" || c.type === "amount";
        expect(v, `${kind}.${c.id}`).toBe(identity ? `Column ${at + 1}` : t.headers[at]);
      }
    }
    // The example from the review: a real header is kept.
    const stage = IMPORT_KINDS.deals.columns.find((c) => c.id === "stage")!;
    expect(columnMapValue(stage, "Deal Stage", 2)).toBe("Deal Stage");
  });

  it("offers a position again next time, and an earlier header name still matches", () => {
    const header = ["Record ID", "Deal Name", "Deal Stage", "Date entered stage", "Deal owner"];
    // Stored by position: the owner was column 2 last time (a name, not what is now called "Deal owner").
    const { index, how } = suggestMapping(header, "deals", { owner: "Column 2", stage: "Deal Stage" });
    expect(index.owner).toBe(1);
    expect(how.owner).toBe("previous");
    // A position the file doesn't have falls back to the suggestion.
    expect(suggestMapping(header, "deals", { owner: "Column 9" }).index.owner).toBe(4);
  });
});

describe("loadTable", () => {
  it("finds the header row, the delimiter and the first sample rows", () => {
    const l = loadTable("Report\nCreated by me\n\na;b\n1;2\n3;4\n", ";", 3);
    if ("error" in l) throw new Error(l.error);
    expect(l.headers).toEqual(["a", "b"]);
    expect(l.samples).toEqual([["1", "2"], ["3", "4"]]);
    expect(l.lines).toBe(2);
    expect(l.delimiter).toBe(";");
    // Automatic detection looks at the first line of the file, as it always has.
    const auto = loadTable("a;b\n1;2\n", "auto", 1);
    if ("error" in auto) throw new Error(auto.error);
    expect(auto.delimiter).toBe(";");
    const explicit = loadTable("a|b\n1|2\n", "|", 1);
    if ("error" in explicit) throw new Error(explicit.error);
    expect(explicit.headers).toEqual(["a", "b"]);
    expect(explicit.delimiter).toBe("|");
  });

  it("says plainly when there is nothing to read", () => {
    expect(loadTable("a,b\n", "auto", 1)).toEqual({ error: "No rows to read." });
    expect(loadTable("", "auto", 1)).toEqual({ error: "No rows to read." });
    expect(loadTable("a,b\n1,2", "auto", 5)).toMatchObject({ error: expect.stringContaining("row 5") });
  });
});

describe("decodeImportFile", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it("reads UTF-8 with or without a mark, and UTF-16 with one", () => {
    expect(decodeImportFile(bytes("a,b\n1,2"))).toMatchObject({ text: "a,b\n1,2", encoding: "utf-8", note: null });
    expect(decodeImportFile(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("a,b")]))).toMatchObject({ text: "a,b", encoding: "utf-8" });
    const le = new Uint8Array([0xff, 0xfe, ...[..."a,b"].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(decodeImportFile(le)).toMatchObject({ text: "a,b", encoding: "utf-16" });
  });

  it("reads Windows text with a note", () => {
    const r = decodeImportFile(new Uint8Array([0x43, 0x61, 0x66, 0xe9])); // "Café" in Windows-1252
    expect(r).toMatchObject({ text: "Café", encoding: "windows-1252" });
    expect("note" in r && r.note).toMatch(/isn't UTF-8/);
  });

  it("refuses UTF-16 without its marker", () => {
    const noBom = new Uint8Array([..."a,b\n1,2"].flatMap((c) => [c.charCodeAt(0), 0]));
    expect(decodeImportFile(noBom)).toEqual({ error: "This looks like a Unicode file without its marker. In Excel, save it as CSV UTF-8 and choose it again." });
  });
});

describe("splitCsv with a delimiter", () => {
  it("splits on the delimiter given, not the one detected", () => {
    expect(splitCsv("a|b,c\n1|2,3", "|")).toEqual([["a", "b,c"], ["1", "2,3"]]);
    expect(splitCsv("a;b,c\n1;2,3", ",")).toEqual([["a;b", "c"], ["1;2", "3"]]);
    expect(detectDelimiter("a\tb;c,d")).toBe("\t");
    expect(detectDelimiter("a;b;c,d")).toBe(";");
    expect(detectDelimiter("a,b")).toBe(",");
  });
  it("reads short rows as blank and ignores extra cells", () => {
    const r = read("deal,stage,entered,left\nD1,Qualify,2026-03-02\nD2,Qualify,2026-03-02,2026-03-03,extra,more\n", "deals");
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
  });
});

describe("readImport", () => {
  it("reads good rows of each kind into its shape", () => {
    const step = read(IMPORT_KINDS.step_log.template, "step_log");
    expect(step.errors).toEqual([]);
    expect(step.rows[0]).toEqual({ item: "D-101", step: "Qualify", started: d(2026, 3, 2, 9), finished: d(2026, 3, 2, 10, 30), hours: 1.5, source: "Website" });
    const deals = read(IMPORT_KINDS.deals.template, "deals");
    expect(deals.errors).toEqual([]);
    expect(deals.rows).toHaveLength(5);
    expect(deals.rows[0]).toEqual({ item: "D-101", step: "Qualified lead", started: d(2026, 3, 2, 9), finished: d(2026, 3, 3, 13), hours: null, source: "Website enquiries" });
    expect(deals.names).toEqual([
      { value: "Qualified lead", rows: 2 },
      { value: "Closed lost", rows: 1 },
      { value: "Closed won", rows: 1 },
      { value: "Discovery call", rows: 1 },
    ]);
    const time = read(IMPORT_KINDS.time_logs.template, "time_logs");
    expect(time.errors).toEqual([]);
    expect(time.rows).toEqual([
      { item: "J-101", step: "Qualify lead", started: d(2026, 3, 2), finished: null, hours: 0.75, source: null },
      { item: "J-101", step: "Discovery call", started: d(2026, 3, 3), finished: null, hours: 1.5, source: null },
      { item: "J-101", step: "Audit & proposal", started: d(2026, 3, 4), finished: null, hours: 7, source: null },
      { item: "J-102", step: "Qualify lead", started: d(2026, 3, 4), finished: null, hours: 1.25, source: null },
    ]);
    const leads = read(IMPORT_KINDS.leads.template, "leads");
    expect(leads.errors).toEqual([]);
    expect(leads.rows[0]).toEqual({ lead: "L-1001", created: d(2026, 3, 2), source: "Website enquiries" });
    const clients = read(IMPORT_KINDS.clients.template, "clients");
    expect(clients.rows[1]).toEqual({ client: "C-002", service: "SEO retainer", started: d(2025, 2, 3), ended: d(2025, 11, 28) });
    const log = read(IMPORT_KINDS.servicing_log.template, "servicing_log");
    expect(log.rows[0]).toMatchObject({ task: "Monthly report", client: "C-001", due: d(2026, 3, 6) + 86_400_000 - 1, done: d(2026, 3, 5, 16) });
    const jobs = read(IMPORT_KINDS.jobs.template, "jobs");
    expect(jobs.errors).toEqual([]);
    expect(jobs.rows[2]).toEqual({ task: "Client check-in", client: "C-001", due: d(2026, 3, 13, 17), done: d(2026, 3, 13, 15), requested: null });
    const inv = read(IMPORT_KINDS.invoices.template, "invoices");
    expect(inv.errors).toEqual([]);
    expect(inv.rows).toHaveLength(4);
    expect(inv.names).toEqual([]);
  });

  it("shows the first 20 rows by the kind's column ids", () => {
    const lines = ["deal,stage,entered,left"];
    for (let i = 0; i < 30; i++) lines.push(`D-${i},Qualify,2026-03-02 09:30,`);
    const r = read(lines.join("\n"), "deals");
    expect(r.preview).toHaveLength(20);
    expect(r.preview[0]).toEqual({ deal: "D-0", stage: "Qualify", entered: "2 Mar 2026 09:30", left: "", source: "", amount: "", owner: "" });
    expect(read("deal,stage,entered\nD,S,2026-03-02", "deals").preview[0]!.entered).toBe("2 Mar 2026");
  });

  it("reports each row error by line, counting blank lines", () => {
    const text = [
      "deal,stage,entered,left,source,amount,owner",
      "D1,Qualify,2026-03-02,,,,", // line 2: fine
      "", // line 3
      ",Qualify,2026-03-02,,,,", // line 4
      "D3,Qualify,someday,,,,", // line 5
      "D4,Qualify,2026-03-05,2026-03-01,,,", // line 6
      `D5,${"x".repeat(201)},2026-03-02,,,,`, // line 7
      "D6,Qualify,2026-03-02,,,not money,", // line 8
      "D7,Qualify,45352,,,,", // line 9
      "D8,Qualify,2026-03-02,,,£12,", // line 10: fine
    ].join("\n");
    const r = read(text, "deals");
    expect(r.rows).toHaveLength(3);
    expect(r.errorCount).toBe(5);
    expect(r.errors.map((e) => e.line)).toEqual([4, 5, 6, 7, 9]);
    expect(r.errors[0]!.message).toBe("Missing deal.");
    expect(r.errors[1]!.message).toMatch(/^Can't read the date entered "someday"/);
    expect(r.errors[2]!.message).toBe("It left the stage before it entered it.");
    expect(r.errors[3]!.message).toMatch(/over 200 characters/);
    // An amount that can't be read keeps its row (line 8), with the amount blank, and is counted.
    expect(r.amountsUnreadable).toBe(1);
    expect(r.errors[4]!.message).toBe('Can\'t read the date "45352". Format the column as a date in Excel before saving.');
    expect(r.lines).toBe(8);
  });

  it("keeps a deal whose amount can't be read, and counts it", () => {
    const r = read("deal,stage,entered,amount\nD1,Qualify,2026-03-02,TBD\nD1,Won,2026-03-03,4.5k\nD2,Won,2026-03-03,£100", "deals");
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(3);
    expect(r.amountsUnreadable).toBe(2);
    expect(r.preview[0]!.amount).toBe("");
    expect(JSON.stringify(r.errors)).not.toContain("TBD");
  });

  it("reads time-log hours in every form and refuses the rest", () => {
    const r = read("job,task,date,hours\nJ,A,2026-03-02,1h 30m\nJ,B,2026-03-02,abc\nJ,C,2026-03-02,-1h\n", "time_logs");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ hours: 1.5 });
    expect(r.errors.map((e) => e.line)).toEqual([3, 4]);
    expect(r.errors[0]!.message).toBe('Hours "abc" isn\'t a number of hours.');
  });

  it("flags a job closed before it was opened, and ends a date-only due at the end of its day", () => {
    const r = read("type,client,due,closed,opened\nReport,C1,2026-03-06,2026-03-05,2026-03-07\nReport,C2,2026-03-06,,\nReport,C3,06 Mar 2026 00:00,,\nReport,C4,2026-03-06 17:00,,\n", "jobs");
    expect(r.errors).toEqual([{ line: 2, message: "It was closed before it was opened." }]);
    expect(r.rows.map((x) => (x as { due: number }).due)).toEqual([d(2026, 3, 7) - 1, d(2026, 3, 7) - 1, d(2026, 3, 6, 17)]);
  });

  it("lists required columns with no header chosen, and reads nothing", () => {
    const r = read("deal,stage,entered\nD1,Qualify,2026-03-02", "deals", { deal: 0, stage: null, entered: null });
    expect(r.missing).toEqual(["stage", "entered"]);
    expect(r.rows).toEqual([]);
    expect(r.lines).toBe(1);
  });

  it("asks when slashed dates are ambiguous, refuses a mixed file, and reads once told", () => {
    const text = "deal,stage,entered\nD1,Q,02/03/2026\nD2,Q,04/05/2026";
    const ask = read(text, "deals");
    expect(ask.dateProblem).toBe("ambiguous");
    expect(ask.rows).toEqual([]);
    const dmy = read(text, "deals", undefined, { dateOrder: "dmy" });
    expect(dmy.dateOrder).toBe("dmy");
    expect(dmy.rows[0]).toMatchObject({ started: d(2026, 3, 2) });
    const mdy = read(text, "deals", undefined, { dateOrder: "mdy" });
    expect(mdy.rows[0]).toMatchObject({ started: d(2026, 2, 3) });
    const mixed = read("deal,stage,entered\nD1,Q,13/03/2026\nD2,Q,03/13/2026", "deals");
    expect(mixed.dateProblem).toBe("mixed");
    expect(mixed.rows).toEqual([]);
    // Month names are never ambiguous.
    expect(read("deal,stage,entered\nD1,Q,2 Mar 2026\nD2,Q,4 May 2026", "deals").dateProblem).toBeNull();
  });

  it("takes the column names from a later row, with title rows above", () => {
    const text = "Pipeline export\nRun on 2 March\ndeal,stage,entered\nD1,Qualify,2026-03-02\nD2,Won,2026-03-03\n";
    const r = readImport(splitCsv(text), "deals", { deal: 0, stage: 1, entered: 2 }, { headerRow: 3 });
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.lines).toBe(2);
    // Line numbers still count the title rows.
    const bad = readImport(splitCsv(text.replace("2026-03-03", "never")), "deals", { deal: 0, stage: 1, entered: 2 }, { headerRow: 3 });
    expect(bad.errors.map((e) => e.line)).toEqual([5]);
  });

  it("reads an explicit semicolon or vertical-bar delimiter", () => {
    for (const sep of [";", "|"] as const) {
      const text = ["deal", "stage", "entered"].join(sep) + "\n" + ["D1", "Qualify, again", "2026-03-02"].join(sep) + "\n";
      const l = loadTable(text, sep, 1);
      if ("error" in l) throw new Error(l.error);
      const r = readImport(l.table, "deals", suggestMapping(l.headers, "deals").index);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ step: "Qualify, again" });
    }
  });

  it("stops at 200,000 rows with the message C2 gives, and reports progress every 5,000", () => {
    const lines = ["lead,created,source"];
    for (let i = 0; i < 200_001; i++) lines.push(`L${i},2026-03-02,Web`);
    const progress: number[] = [];
    const r = read(lines.join("\n"), "leads", undefined, { onProgress: (done, total) => progress.push(done * 1_000_000 + total) });
    expect(r.rows).toHaveLength(200_000);
    expect(r.errorCount).toBe(1);
    expect(r.errors[0]!.message).toBe("Only the first 200,000 rows are read.");
    expect(progress.length).toBe(40);
    expect(progress[0]).toBe(5000 * 1_000_000 + 200_001);
  });

  it("calls onProgress every 5,000 rows", () => {
    const lines = ["deal,stage,entered"];
    for (let i = 0; i < 12_000; i++) lines.push(`D${i},Qualify,2026-03-02`);
    const calls: [number, number][] = [];
    read(lines.join("\n"), "deals", undefined, { onProgress: (a, b) => calls.push([a, b]) });
    expect(calls).toEqual([
      [5000, 12_000],
      [10_000, 12_000],
    ]);
  });

  it("reads a generated 50,000-row deals file", () => {
    const stages = ["Qualified lead", "Discovery call", "Proposal sent", "Negotiation", "Closed won"];
    const lines = ["Record ID,Deal Name,Deal Stage,Date entered stage,Original Source,Amount,Deal owner"];
    for (let i = 0; i < 10_000; i++) {
      for (let s = 0; s < 5; s++) lines.push(`${i},Deal ${i},${stages[s]},${new Date(Date.UTC(2026, 0, 1) + (i + s) * 3_600_000).toISOString().slice(0, 16).replace("T", " ")},Web,£${1000 + i},Rep ${i % 7}`);
    }
    const r = read(lines.join("\n"), "deals");
    expect(r.errors).toEqual([]);
    expect(r.lines).toBe(50_000);
    expect(r.rows).toHaveLength(50_000);
    expect(r.note).toBeNull();
    expect(r.names.map((n) => n.rows)).toEqual([10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(r.rows[49_999]).toMatchObject({ item: "9999", step: "Closed won" });
  });

  it("keeps at most 200 errors but counts them all", () => {
    const lines = ["deal,stage,entered"];
    for (let i = 0; i < 300; i++) lines.push(`D${i},Q,nope`);
    const r = read(lines.join("\n"), "deals");
    expect(r.errors).toHaveLength(200);
    expect(r.errorCount).toBe(300);
  });

  it("lists distinct names by rows, then value, at most 500", () => {
    const lines = ["deal,stage,entered"];
    for (let i = 0; i < 600; i++) lines.push(`D${i},Stage ${String(i).padStart(3, "0")},2026-03-02`);
    lines.push("D1,Stage 007,2026-03-02");
    const r = read(lines.join("\n"), "deals");
    expect(r.names).toHaveLength(500);
    // The rest are counted, so the screen can say they are left out.
    expect(r.namesTotal).toBe(600);
    // A value past the 500th is left out, and counted as left out.
    const unlisted = applyNameMapCounted(r, Object.fromEntries(r.names.map((n) => [n.value, n.value])));
    expect(unlisted).toMatchObject({ kept: 500 + 1, leftOut: 100 });
    expect(r.names[0]).toEqual({ value: "Stage 007", rows: 2 });
    expect(r.names[1]).toEqual({ value: "Stage 000", rows: 1 });
  });

  it("notes a list of deals, and not a stage history", () => {
    const once = read("deal,stage,entered\nD1,Qualify,2026-03-02\nD2,Qualify,2026-03-02\n", "deals");
    expect(once.note).toMatch(/^Each deal appears about once/);
    const history = read(IMPORT_KINDS.deals.template, "deals");
    expect(history.note).toBeNull();
  });
});

describe("conversions", () => {
  const deal = (deal: string, stage: string, entered: number, left: number | null = null, source: string | null = null): DealRow => ({ deal, stage, entered, left, source, amount: 1, owner: "x" });

  it("turns deals into a step log", () => {
    expect(dealsToStepLog([deal("D1", "Qualify", 1, 2, "Web"), deal("D1", "Won", 2)])).toEqual([
      { item: "D1", step: "Qualify", started: 1, finished: 2, hours: null, source: "Web" },
      { item: "D1", step: "Won", started: 2, finished: null, hours: null, source: null },
    ]);
    expect(dealsNote([])).toBeNull();
    // Exactly 10% with two rows is enough.
    const rows = [deal("D0", "A", 1), deal("D0", "B", 2), ...Array.from({ length: 9 }, (_, i) => deal(`E${i}`, "A", 1))];
    expect(dealsNote(rows)).toBeNull();
    expect(dealsNote(rows.slice(1))).toMatch(/list of deals/);
  });

  it("merges consecutive entries on a task into one visit and sums the hours", () => {
    const e = (job: string, task: string, date: number, hours: number): TimeLogRow => ({ job, task, date, hours, person: "p", client: "c" });
    const out = timeLogToStepLog([e("J1", "A", 1, 1), e("J2", "X", 1, 5), e("J1", "A", 2, 0.5), e("J1", "B", 3, 2), e("J1", "A", 4, 1)]);
    expect(out).toEqual([
      { item: "J1", step: "A", started: 1, finished: null, hours: 1.5, source: null },
      { item: "J1", step: "B", started: 3, finished: null, hours: 2, source: null },
      { item: "J1", step: "A", started: 4, finished: null, hours: 1, source: null },
      { item: "J2", step: "X", started: 1, finished: null, hours: 5, source: null },
    ]);
    // Entries out of order are sorted by date; ties keep their file order.
    const sorted = timeLogToStepLog([e("J", "B", 5, 1), e("J", "A", 1, 1), e("J", "B", 1, 1), e("J", "A", 1, 1)]);
    expect(sorted.map((v) => v.step)).toEqual(["A", "B", "A", "B"]);
  });

  it("turns jobs into a servicing log", () => {
    const j: JobRow = { job: "T1", type: "Report", client: "C1", due: 10, closed: 8, opened: 2, assignee: "a" };
    expect(jobsToServicing([j, { ...j, closed: null, opened: null }])).toEqual([
      { task: "Report", client: "C1", due: 10, done: 8, requested: 2 },
      { task: "Report", client: "C1", due: 10, done: null, requested: null },
    ]);
  });

  describe("leadsSummary", () => {
    const sources = [
      { id: "s1", name: "Website enquiries", volumeWeek: 8 },
      { id: "s2", name: "Google Ads", volumeWeek: 4 },
    ];
    const lead = (source: string, created: number): LeadRow => ({ lead: null, created, source });
    const asOf = d(2026, 6, 1);

    it("counts leads a week for each source over the window to asOf", () => {
      const rows: LeadRow[] = [];
      for (let i = 0; i < 40; i++) rows.push(lead("website  enquiries", d(2026, 3, 2) + i * 86_400_000));
      for (let i = 0; i < 9; i++) rows.push(lead("Google Ads", d(2026, 3, 9) + i * 86_400_000));
      for (let i = 0; i < 3; i++) rows.push(lead("Podcast", d(2026, 4, 1)));
      const s = leadsSummary(rows, sources, asOf);
      expect(s.blocked).toBeNull();
      expect(s.from).toBe(d(2026, 3, 2));
      // The window ends at the last lead, not at asOf.
      expect(s.to).toBe(d(2026, 3, 2) + 39 * 86_400_000);
      expect(s.weeks).toBeCloseTo((s.to - d(2026, 3, 2)) / (7 * 86_400_000), 6);
      expect(s.unmatched).toBe(3);
      expect(s.leads).toBe(52);
      expect(s.sources[0]).toMatchObject({ leadSourceId: "s1", leads: 40, current: 8, enough: true });
      expect(s.sources[0]!.perWeek).toBeCloseTo(40 / s.weeks, 2);
      expect(s.sources[1]).toMatchObject({ leadSourceId: "s2", leads: 9, enough: false });
    });

    it("needs at least four weeks", () => {
      const s = leadsSummary([lead("Google Ads", d(2026, 5, 20)), lead("Google Ads", d(2026, 6, 1))], sources, asOf);
      expect(s.blocked).toBe("The file covers 1.7 weeks; at least 4 are needed.");
      expect(s.sources.every((x) => !x.enough && x.perWeek === 0)).toBe(true);
    });

    it("ends the window at the last lead: a January to March export read in October is about 13 weeks", () => {
      const rows: LeadRow[] = [];
      for (let i = 0; i < 90; i++) rows.push(lead("Google Ads", d(2026, 1, 1) + i * 86_400_000));
      const s = leadsSummary(rows, sources, d(2026, 10, 6));
      expect(s.weeks).toBeCloseTo(89 / 7, 6);
      expect(s.weeks).toBeGreaterThan(12.5);
      expect(s.weeks).toBeLessThan(13.5);
      // 90 leads over 12.7 weeks is 7 a week, not 2.
      expect(s.sources[1]!.perWeek).toBeCloseTo(90 / s.weeks, 1);
      // A lead dated after asOf doesn't stretch the window past it.
      expect(leadsSummary([lead("Google Ads", d(2026, 1, 1)), lead("Google Ads", d(2027, 1, 1))], sources, d(2026, 10, 6)).to).toBe(d(2026, 10, 6));
    });

    it("matches no source when two share a name", () => {
      const s = leadsSummary([lead("Ads", d(2026, 1, 1))], [{ id: "a", name: "ads", volumeWeek: 1 }, { id: "b", name: "Ads", volumeWeek: 1 }], asOf);
      expect(s.unmatched).toBe(1);
    });

    it("keeps no names when stored", () => {
      const s = leadsSummary([lead("Google Ads", d(2026, 1, 1))], sources, asOf);
      const stored = storedLeadsSummary(s);
      expect(JSON.stringify(stored)).not.toContain("Google");
      expect(stored.sources[0]).toEqual({ leadSourceId: "s1", leads: 0, perWeek: expect.any(Number), current: 8 });
    });
  });

  it("treats an invoice due on a date alone as due at the end of that day", () => {
    const text = [
      "invoice,client,issued,due,paid",
      "I1,C1,2026-03-01,2026-03-30,2026-03-30 15:00", // paid on the due day: on time
      "I2,C2,2026-03-01,2026-03-30 00:00,2026-03-30 09:00", // midnight is a date
      "I3,C3,2026-03-01,03/30/2026 12:00:00 AM,03/30/2026 03:00 PM",
      "I4,C4,2026-03-01,2026-03-30 17:00,2026-03-30 18:00", // a time: late
      "I5,C5,2026-03-01,2026-03-30,", // unpaid, due today
    ].join("\n");
    const r = readImport(splitCsv(text), "invoices", { invoice: 0, client: 1, issued: 2, due: 3, paid: 4 }, { dateOrder: "mdy" });
    expect(r.errors).toEqual([]);
    const rows = r.rows as InvoiceRow[];
    expect(rows[0]!.due).toBe(d(2026, 3, 30) + 86_400_000 - 1);
    expect(rows[3]!.due).toBe(d(2026, 3, 30, 17));
    // Midday on the due day is not past due; the next morning is.
    const s = invoicesSummary(rows, d(2026, 3, 30, 12));
    expect(s.paidLate).toBeCloseTo(1 / 4, 6);
    expect(s.unpaidPastDue).toBe(0);
    expect(invoicesSummary(rows, d(2026, 3, 31, 9)).unpaidPastDue).toBe(1);
  });

  it("summarises invoices without summing amounts", () => {
    const inv = (client: string, issued: number, due: number | null, paid: number | null, amount: number | null): InvoiceRow => ({ invoice: null, client, issued, due, paid, amount });
    const asOf = d(2026, 6, 1);
    const s = invoicesSummary(
      [
        inv("A", d(2026, 3, 1), d(2026, 3, 30), d(2026, 3, 28), 100), // on time
        inv("A", d(2026, 3, 8), d(2026, 4, 5), d(2026, 4, 9), 200), // late
        inv("B", d(2026, 3, 9), d(2026, 4, 6), null, null), // unpaid past due
        inv("C", d(2026, 5, 20), d(2026, 7, 1), null, 50), // not due yet
        inv("C", d(2026, 5, 21), null, null, null),
      ],
      asOf,
    );
    expect(s).toEqual({ invoices: 5, clients: 3, from: d(2026, 3, 1), to: d(2026, 5, 21), withDue: 4, paidLate: 0.5, unpaidPastDue: 1, withAmount: 3 });
    expect(invoicesSummary([], asOf)).toMatchObject({ invoices: 0, paidLate: null, from: null });
    expect(JSON.stringify(storedInvoicesSummary(s))).not.toContain("amount\":1");
  });
});

describe("matching names to the model", () => {
  const names = [{ value: "Qualified lead" }, { value: "discovery  CALL" }, { value: "Won" }];
  it("matches a name once normalised, else leaves it out", () => {
    expect(suggestNameMap(names, ["Qualify lead", "Discovery call", "Won"])).toEqual({ "Qualified lead": null, "discovery  CALL": "Discovery call", Won: "Won" });
  });
  it("matches neither of two targets that normalise the same", () => {
    expect(suggestNameMap([{ value: "Won" }], ["Won", "won!"])).toEqual({ Won: null });
  });
  it("matches time log entries to steps before merging them into visits", () => {
    const text = ["job,task,date,hours", "J1,Audit,2026-03-02,2", "J1,audit ,2026-03-03,2", "J1,AUDIT,2026-03-04,2", "J2,Audit,2026-03-02,1", "J2,Proposal,2026-03-03,3"].join("\n");
    const r = read(text, "time_logs");
    expect(r.entries).toHaveLength(5);
    // Spellings of one step are one visit of 6 hours, not three of 2.
    const spelled = applyNameMap(r, { Audit: "Audit", audit: "Audit", AUDIT: "Audit", Proposal: "Audit" });
    expect(spelled).toEqual([
      { item: "J1", step: "Audit", started: d(2026, 3, 2), finished: null, hours: 6, source: null },
      { item: "J2", step: "Audit", started: d(2026, 3, 2), finished: null, hours: 4, source: null },
    ]);
    // Two names matched to one step merge too.
    expect(applyNameMap(read("job,task,date,hours\nJ1,Audit,2026-03-02,2\nJ1,Proposal,2026-03-03,3", "time_logs"), { Audit: "Audit & proposal", Proposal: "Audit & proposal" })).toEqual([
      { item: "J1", step: "Audit & proposal", started: d(2026, 3, 2), finished: null, hours: 5, source: null },
    ]);
    // An entry left out is dropped before merging: A, X, A is one visit.
    const left = read("job,task,date,hours\nJ1,A,2026-03-02,1\nJ1,X,2026-03-03,5\nJ1,A,2026-03-04,2", "time_logs");
    const counted = applyNameMapCounted(left, { A: "A", X: null });
    expect(counted.rows).toEqual([{ item: "J1", step: "A", started: d(2026, 3, 2), finished: null, hours: 3, source: null }]);
    expect(counted).toMatchObject({ kept: 2, leftOut: 1 });
  });

  it("rewrites names and drops the rows mapped to nothing", () => {
    const r = read("deal,stage,entered\nD1,Qualified lead,2026-03-02\nD1,Discovery,2026-03-03\nD2,Qualified lead,2026-03-04\n", "deals");
    const rows = applyNameMap(r, { "Qualified lead": "Qualify lead", Discovery: null });
    expect(rows.map((x) => (x as { step: string }).step)).toEqual(["Qualify lead", "Qualify lead"]);
    // Values not in the map are dropped too.
    expect(applyNameMap(r, {})).toEqual([]);
    // A lead's source is renamed; invoices have no name to match.
    const leads = read("created,source\n2026-03-02,ads\n", "leads");
    expect(applyNameMap(leads, { ads: "Google Ads" })).toEqual([{ lead: null, created: d(2026, 3, 2), source: "Google Ads" }]);
    const inv = read(IMPORT_KINDS.invoices.template, "invoices");
    expect(applyNameMap(inv, {})).toBe(inv.rows);
  });
});

describe("parseDuration", () => {
  it("reads decimal hours, h:mm and spelled-out forms", () => {
    const cases: [string, number][] = [
      ["1.5", 1.5],
      ["1,5", 1.5],
      ["2", 2],
      ["1:30", 1.5],
      ["01:30:00", 1.5],
      ["0:45", 0.75],
      ["1h 30m", 1.5],
      ["1h", 1],
      ["90m", 1.5],
      ["90 min", 1.5],
      ["90 mins", 1.5],
      ["1h30", 1.5],
      ["2 h 5", 2 + 5 / 60],
      ["10000", 10_000],
    ];
    for (const [text, hours] of cases) {
      expect(parseDuration(text), text).toBeCloseTo(hours, 6);
    }
  });
  it("reads a plain number in the unit chosen, and never seconds as hours", () => {
    expect(parseDuration("90", "minutes")).toBe(1.5);
    expect(parseDuration("3600", "seconds")).toBe(1);
    expect(parseDuration("1800", "seconds")).toBe(0.5);
    expect(parseDuration("1.5")).toBe(1.5);
    // A comma is a thousands separator in minutes and seconds, and a decimal comma in hours.
    expect(parseDuration("1,500", "seconds")).toBeCloseTo(1500 / 3600, 6);
    expect(parseDuration("1,500", "minutes")).toBe(25);
    expect(parseDuration("99,999,999", "seconds")).toBeNull();
    expect(parseDuration("1,500")).toBe(1.5);
    expect(parseDuration("1,5", "seconds")).toBeCloseTo(1.5 / 3600, 6);
    // Forms with a unit don't depend on the choice.
    expect(parseDuration("1:30", "seconds")).toBe(1.5);
    expect(parseDuration("90m", "seconds")).toBe(1.5);
    // 3600 read as hours is over the cap, not 3,600 hours of work.
    expect(parseDuration("36000")).toBeNull();
    expect(readImport(splitCsv("job,task,date,hours\nJ1,A,2026-03-02,5400"), "time_logs", { job: 0, task: 1, date: 2, hours: 3 }, { durationUnit: "seconds" }).rows[0]).toMatchObject({ hours: 1.5 });
    expect(readImport(splitCsv("job,task,date,hours\nJ1,A,2026-03-02,45"), "time_logs", { job: 0, task: 1, date: 2, hours: 3 }, { durationUnit: "minutes" }).rows[0]).toMatchObject({ hours: 0.75 });
  });

  it("says so when the middle entry is over 24 hours, as a seconds column read as hours is", () => {
    const rows = Array.from({ length: 9 }, (_, i) => `J${i},A,2026-03-02,${1800 + i * 600}`).join("\n");
    const text = `job,task,date,hours\n${rows}`;
    const index = { job: 0, task: 1, date: 2, hours: 3 };
    const wrong = readImport(splitCsv(text), "time_logs", index);
    expect(wrong.note).toMatch(/middle entry is \d,?\d{3} hours long.*minutes or seconds/);
    const right = readImport(splitCsv(text), "time_logs", index, { durationUnit: "seconds" });
    expect(right.note).toBeNull();
    expect(right.entries![0]!.hours).toBe(0.5);
  });

  it("refuses what isn't a length of time", () => {
    for (const s of ["", "abc", "-1h", "-2", "1.2.3", "1:75", "10001", "h", "1h 90x"]) expect(parseDuration(s), s).toBeNull();
  });
});

describe("parseAmount", () => {
  it("reads currency symbols, codes, brackets and signs", () => {
    const cases: [string, number][] = [
      ["1200", 1200],
      ["£9,999", 9999],
      ["$ 12.50", 12.5],
      ["€12,50", 12.5],
      ["A$1,234.50", 1234.5],
      ["AUD 1,234.50", 1234.5],
      ["1,234.50 GBP", 1234.5],
      ["12 USD", 12],
      ["(123.45)", -123.45],
      ["-123.45", -123.45],
      ["-£5", -5],
    ];
    for (const [text, n] of cases) expect(parseAmount(text), text).toBeCloseTo(n, 6);
  });
  it("tells thousands from decimals by which separator comes last", () => {
    expect(parseAmount("1,234.50")).toBe(1234.5);
    expect(parseAmount("1.234,50")).toBe(1234.5);
    expect(parseAmount("1 234,50")).toBe(1234.5);
    expect(parseAmount("1,234,567.89")).toBe(1_234_567.89);
    expect(parseAmount("1.234.567,89")).toBe(1_234_567.89);
    expect(parseAmount("1,234,567")).toBe(1_234_567);
  });
  it("refuses what isn't an amount", () => {
    for (const s of ["", "abc", "1.2.3", "12abc", "£", "--5", "1,23,456.7", "12 34"]) expect(parseAmount(s), s).toBeNull();
  });
});

describe("a due date with no time, or exactly midnight, is due at the end of its day", () => {
  const end = (y: number, m: number, day: number) => d(y, m, day) + 86_400_000 - 1;
  const log = (due: string, order: "dmy" | "mdy" = "mdy") =>
    parseServicingLog(`task,client,due,done\nReport,C1,${due},`, { dateOrder: order }).rows[0]!.due;

  it("keeps what C2 read before this change, to the same millisecond", () => {
    // Each input and its due, as read before 12:00 AM and month names were accepted.
    const before: [string, number][] = [
      ["2026-03-06", end(2026, 3, 6)],
      ["2026-03-06 00:00", end(2026, 3, 6)],
      ["2026-03-06 0:00", end(2026, 3, 6)],
      ["2026-03-06 00:00:00", end(2026, 3, 6)],
      ["2026-03-06T00:00:00", end(2026, 3, 6)],
      ["2026-03-06 00:00:00.000", end(2026, 3, 6)],
      ["2026-03-06 17:00", d(2026, 3, 6, 17)],
      ["2026-03-06 00:01", d(2026, 3, 6, 0, 1)],
      ["2026-03-06T00:00:00Z", d(2026, 3, 6)],
      ["2026-03-06T00:00:00+10:00", d(2026, 3, 5, 14)],
      ["2026-03-06T10:00:00+10:00", d(2026, 3, 6)],
      ["06/03/2026", end(2026, 3, 6)],
      ["06/03/2026 00:00", end(2026, 3, 6)],
      ["06/03/2026 09:30", d(2026, 3, 6, 9, 30)],
    ];
    for (const [text, due] of before) expect(log(text, "dmy"), text).toBe(due);
  });

  it("treats 12:00:00 AM and 12:00 AM as the start of the date, and 12:00 PM as noon", () => {
    expect(log("06/13/2026 12:00:00 AM")).toBe(end(2026, 6, 13));
    expect(log("06/13/2026 12:00 AM")).toBe(end(2026, 6, 13));
    expect(log("13 Jun 2026 12:00 AM")).toBe(end(2026, 6, 13));
    expect(log("13 Jun 2026")).toBe(end(2026, 6, 13));
    expect(log("06/13/2026 12:00 PM")).toBe(d(2026, 6, 13, 12));
    expect(log("06/13/2026 3:00 PM")).toBe(d(2026, 6, 13, 15));
    // So work done on its due day is on time, for a servicing log and for jobs.
    const jobs = readImport(splitCsv("type,client,due,closed\nReport,C1,06/13/2026 12:00:00 AM,06/13/2026 03:00 PM"), "jobs", { type: 0, client: 1, due: 2, closed: 3 }, { dateOrder: "mdy" });
    const row = jobs.rows[0] as { due: number; done: number };
    expect(row.done).toBeLessThanOrEqual(row.due);
  });
});

describe("parseLogTime extensions", () => {
  it("reads everything it read before, to the same millisecond", () => {
    const table: [string, number | null][] = [
      ["2026-03-02", 1772409600000],
      ["2026-03-02 09:30", 1772443800000],
      ["2026-03-02T09:30:15Z", 1772443815000],
      ["2026-03-02T09:30:00+10:00", 1772407800000],
      ["2026-03-02 09:30:15.250", 1772443815000],
      ["02/03/2026", 1772409600000],
      ["2/3/2026 17:05", 1772471100000],
      ["02.03.2026 09:30:15", 1772443815000],
      ["13/03/2026", 1773360000000],
      ["", null],
      ["yesterday", null],
      ["2026-02-31", null],
      ["13/13/2026", null],
      ["2026-03-02 25:00", null],
      ["02/03/202", null],
    ];
    for (const [text, ms] of table) expect(parseLogTime(text), text).toBe(ms);
    expect(parseLogTime("02/03/2026", "mdy")).toBe(d(2026, 2, 3));
  });

  it("reads month names, full or short, in any case, with an optional time", () => {
    expect(parseLogTime("2 Mar 2026")).toBe(d(2026, 3, 2));
    expect(parseLogTime("02-Mar-2026")).toBe(d(2026, 3, 2));
    expect(parseLogTime("2 March 2026")).toBe(d(2026, 3, 2));
    expect(parseLogTime("2 MARCH 2026 09:30")).toBe(d(2026, 3, 2, 9, 30));
    expect(parseLogTime("Mar 2, 2026")).toBe(d(2026, 3, 2));
    expect(parseLogTime("March 2 2026")).toBe(d(2026, 3, 2));
    expect(parseLogTime("mar 2, 2026 09:30:15")).toBe(d(2026, 3, 2, 9, 30, 15));
    expect(parseLogTime("2 Sep 2026")).toBe(d(2026, 9, 2));
    // What Excel writes by default, and common spellings.
    expect(parseLogTime("2-Mar-26")).toBe(d(2026, 3, 2));
    expect(parseLogTime("02-Mar-26")).toBe(d(2026, 3, 2));
    expect(parseLogTime("2 Mar 26 09:30")).toBe(d(2026, 3, 2, 9, 30));
    expect(parseLogTime("Sept 2, 2026")).toBe(d(2026, 9, 2));
    expect(parseLogTime("2 Sept 2026")).toBe(d(2026, 9, 2));
    expect(parseLogTime("2nd March 2026")).toBe(d(2026, 3, 2));
    expect(parseLogTime("March 2nd, 2026")).toBe(d(2026, 3, 2));
    expect(parseLogTime("Mar 2, 26")).toBe(d(2026, 3, 2));
    expect(parseLogTime("2 Marc 2026")).toBeNull();
    expect(parseLogTime("31 Feb 2026")).toBeNull();
    expect(parseLogTime("2 Mar")).toBeNull();
  });

  it("reads AM and PM", () => {
    expect(parseLogTime("02/03/2026 9:30 PM")).toBe(d(2026, 3, 2, 21, 30));
    expect(parseLogTime("02/03/2026 9:30pm")).toBe(d(2026, 3, 2, 21, 30));
    expect(parseLogTime("2 Mar 2026 9:30am")).toBe(d(2026, 3, 2, 9, 30));
    expect(parseLogTime("02/03/2026 12:15 AM")).toBe(d(2026, 3, 2, 0, 15));
    expect(parseLogTime("02/03/2026 12:15 PM")).toBe(d(2026, 3, 2, 12, 15));
    expect(parseLogTime("02/03/2026 13:15 PM")).toBeNull();
    expect(parseLogTime("02/03/2026 0:15 AM")).toBeNull();
  });

  it("reads AM and PM after an ISO time", () => {
    expect(parseLogTime("2026-06-13T12:00:00 AM")).toBe(d(2026, 6, 13));
    expect(parseLogTime("2026-06-13 12:15 PM")).toBe(d(2026, 6, 13, 12, 15));
    expect(parseLogTime("2026-06-13T09:30:00pm")).toBe(d(2026, 6, 13, 21, 30));
    expect(parseLogTime("2026-06-13 13:00 PM")).toBeNull();
    // Without AM/PM, an ISO time reads as before.
    expect(parseLogTime("2026-06-13T12:00:00")).toBe(d(2026, 6, 13, 12));
  });

  it("reads two-digit years on slashed dates", () => {
    expect(parseLogTime("02/03/26")).toBe(d(2026, 3, 2));
    // The pivot: 00 to 69 are the 2000s, 70 to 99 the 1900s.
    expect(parseLogTime("01/01/69")).toBe(d(2069, 1, 1));
    expect(parseLogTime("01/01/70")).toBe(d(1970, 1, 1));
    expect(parseLogTime("01/01/99")).toBe(Date.UTC(1999, 0, 1));
    expect(parseLogTime("2-Mar-98")).toBe(Date.UTC(1998, 2, 2));
    expect(parseLogTime("Mar 2, 71")).toBe(Date.UTC(1971, 2, 2));
    expect(parseLogTime("13/03/26 09:00")).toBe(d(2026, 3, 13, 9));
    expect(detectDateOrder(["13/03/26"])).toBe("dmy");
    expect(detectDateOrder(["02/03/26"])).toBe("ambiguous");
    expect(detectDateOrder(["2 Mar 2026"])).toBeNull();
  });

  it("sees a time of day in the new forms", () => {
    expect(hasTimeOfDay("2 Mar 2026")).toBe(false);
    expect(hasTimeOfDay("2 Mar 2026 09:30")).toBe(true);
    expect(hasTimeOfDay("02/03/2026 9:30 PM")).toBe(true);
    expect(hasTimeOfDay("Mar 2, 2026")).toBe(false);
  });
});

describe("what is stored", () => {
  // Every column of every kind filled with something that must never reach the database.
  const SECRET = { client: "ACME-SECRET-CLIENT", person: "Jane Secretperson", amount: "£9,999" };
  const fileFor = (kind: ImportKind) => {
    const spec = IMPORT_KINDS[kind];
    const value = (type: string) =>
      type === "client" ? SECRET.client : type === "person" ? SECRET.person : type === "amount" ? SECRET.amount : type === "date" ? "2026-03-02" : type === "duration" ? "1.5" : type === "name" ? "Some step" : "ID-1";
    return [spec.columns.map((c) => c.id).join(","), spec.columns.map((c) => value(c.type)).join(","), spec.columns.map((c) => value(c.type)).join(",")].join("\n");
  };

  it("holds no client, person or amount from the file, for every kind", () => {
    for (const kind of IMPORT_KIND_LIST) {
      const r = read(fileFor(kind), kind);
      expect(r.errors, kind).toEqual([]);
      expect(r.rows.length, kind).toBeGreaterThan(0);
      const summary =
        kind === "leads"
          ? storedLeadsSummary(leadsSummary(r.rows as LeadRow[], [{ id: "s1", name: "Some step", volumeWeek: 1 }], d(2026, 6, 1)))
          : kind === "invoices"
            ? storedInvoicesSummary(invoicesSummary(r.rows as InvoiceRow[], d(2026, 6, 1)))
            : undefined;
      const details = importDetails(r, { delimiter: ",", encoding: "utf-8", headerRow: 1, nameMatches: { matched: r.rows.length, leftOut: 0 }, summary });
      const json = JSON.stringify(details);
      for (const secret of [...Object.values(SECRET), "Some step", "ID-1"]) expect(json, `${kind}: ${secret}`).not.toContain(secret);
      expect(details.rows).toBe(r.rows.length);
      expect(details.window).not.toBeNull();
    }
  });

  it("holds numbers and enums", () => {
    const r = read("deal,stage,entered\nD1,Q,02/03/2026\nD2,Q,13/03/2026\nD3,Q,nope", "deals");
    const details = importDetails(r, { delimiter: "weird", encoding: "windows-1252", headerRow: 99, nameMatches: { matched: 2, leftOut: 0 } });
    expect(details).toEqual({
      delimiter: ",",
      encoding: "windows-1252",
      headerRow: 20,
      dateOrder: "dmy",
      lines: 3,
      rows: 2,
      leftOut: 1,
      nameMatches: { matched: 2, leftOut: 0 },
      window: { from: d(2026, 3, 2), to: d(2026, 3, 13) },
      summary: null,
    });
  });
});

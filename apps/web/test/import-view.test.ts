import { describe, expect, it } from "vitest";
import { IMPORT_KIND_LIST, IMPORT_KINDS, type ImportColumn } from "@transpera-flow/db/csv-import";
import { mappingProblems, previewTable, sampleLine } from "@/lib/calibration/import-view";

// What the import wizard shows of a file (issue #40): identity columns are never shown, only counted or labelled.

const SECRET = "ACME Ltd – SEO retainer";

describe("id columns are never shown", () => {
  const column = (kind: Parameters<typeof previewTable>[0]["kind"], id: string): ImportColumn => IMPORT_KINDS[kind].columns.find((c) => c.id === id)!;

  it("counts the values of an id column in the mapper, for every kind that has one", () => {
    for (const kind of IMPORT_KIND_LIST) {
      for (const c of IMPORT_KINDS[kind].columns.filter((x) => x.type === "id" || x.type === "client" || x.type === "person")) {
        const line = sampleLine(c, [[SECRET], ["Jane Secretperson"], [SECRET]], 0, true);
        expect(line, `${kind}.${c.id}`).toBe("2 different values in the first 3 rows");
        expect(line).not.toContain("ACME");
      }
    }
  });

  it("labels an id column in the preview with its own name, in order of first appearance", () => {
    const spec = IMPORT_KINDS.deals;
    const table = previewTable(spec, new Set(["deal", "stage", "owner"]), [
      { deal: SECRET, stage: "Qualified lead", owner: "Jane Secretperson" },
      { deal: "Smith v Jones", stage: "Won", owner: "Jane Secretperson" },
      { deal: SECRET, stage: "Lost", owner: "Sam" },
    ], true);
    expect(table.rows).toEqual([
      ["Deal 1", "Qualified lead", "Person 1"],
      ["Deal 2", "Won", "Person 1"],
      ["Deal 1", "Lost", "Person 2"],
    ]);
    expect(JSON.stringify(table)).not.toMatch(/ACME|Smith|Jane/);
    // Time logs: a project or matter id is a job.
    const jobs = previewTable(IMPORT_KINDS.time_logs, new Set(["job", "client"]), [{ job: "Smith v Jones", client: SECRET }], true);
    expect(jobs.rows).toEqual([["Job 1", "Client 1"]]);
    expect(column("invoices", "invoice").type).toBe("id");
  });

  it("never returns an id value from any kind's preview", () => {
    for (const kind of IMPORT_KIND_LIST) {
      const spec = IMPORT_KINDS[kind];
      const ids = spec.columns.filter((c) => c.type === "id" || c.type === "client" || c.type === "person");
      const row = Object.fromEntries(spec.columns.map((c) => [c.id, ids.includes(c) ? SECRET : "x"]));
      const table = previewTable(spec, new Set(spec.columns.map((c) => c.id)), [row], true);
      expect(JSON.stringify(table), kind).not.toContain("ACME");
    }
  });

  it("shows an amount only to owners and editors", () => {
    const rows = [{ deal: "d", stage: "s", entered: "1 Mar 2026", amount: "9000" }];
    const spec = IMPORT_KINDS.deals;
    const m = new Set(["deal", "stage", "entered", "amount"]);
    expect(previewTable(spec, m, rows, true).rows[0]).toContain("9000");
    expect(previewTable(spec, m, rows, false).rows[0]).not.toContain("9000");
    expect(sampleLine(column("deals", "amount"), [["9000"]], 0, false)).not.toContain("9000");
  });

  it("flags a required column with no header and a header used twice, on both columns", () => {
    const spec = IMPORT_KINDS.deals;
    expect(mappingProblems(spec, { deal: 0, stage: null, entered: 2 })).toEqual({ stage: "Choose a column for Stage." });
    expect(mappingProblems(spec, { deal: 0, stage: 1, entered: 0 })).toEqual({ deal: "Used for Date entered too", entered: "Used for Deal too" });
  });
});

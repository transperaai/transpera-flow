import { describe, expect, it } from "vitest";
import { csvCell, csvText } from "@/lib/export/csv";

// The shared CSV cell writer: cells a spreadsheet can't run as formulas, quoting, a byte order mark and CRLF line ends.

describe("CSV cells", () => {
  it.each(["=SUM(A1)", "+1", "-2", "@cmd", "\tx", "\rx", " =1+1", "   @SUM(A1)", "\u00a0-2+3", "  \t=1"])("defuses a cell that starts with %j", (v) => {
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

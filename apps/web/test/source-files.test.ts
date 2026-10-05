import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { MAX_BODY } from "@/lib/sources/validate";
import { EMPTY, TOO_BIG, WRONG_TYPE, checkSourceFile, displayName, fileTypeOf, parseStoragePath, safeFileName } from "@/lib/sources/file-check";

vi.mock("server-only", () => ({}));
const { MAX_PDF_PAGES, activePdfWorkers, attributes, extractSourceText, scanXml, workbookText, xmlText } = await import("@/lib/sources/extract");

// A source's original file (issue #182, B19 2/2): the five kinds accepted, checked by name and by content (never by the type
// the browser declares), the 10 MB limit, the name it is kept under, and the text read out of each kind on the server. Storage
// RLS is tested in packages/db/test/source-files.test.ts, the upload over PostgREST in packages/mcp/test.

const WS = "a0000000-0000-4000-8000-000000000001";
const U = "b0000000-0000-4000-8000-000000000002";
const SRC = "c0000000-0000-4000-8000-000000000003";
const bytes = (s: string) => new TextEncoder().encode(s);

/** A small but real PDF with one line of text per page (offsets in the cross-reference table computed). */
function pdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytes(out);
}

/** A workbook as Excel writes one: content types, the workbook and its relationships, shared strings and the sheets. */
function xlsx(sheets: { name: string; xml: string }[], shared: string[] = [], extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "xl/workbook.xml": strToU8(`<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml" Type="x"/>`).join("")}</Relationships>`),
    "xl/sharedStrings.xml": strToU8(`<sst>${shared.map((s) => `<si>${s}</si>`).join("")}</sst>`),
    ...Object.fromEntries(sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, strToU8(`<worksheet><sheetData>${s.xml}</sheetData></worksheet>`)])),
    ...extra,
  });
}

describe("which files are accepted", () => {
  it("takes .txt, .md, .csv, .xlsx and .pdf by name, whatever the case, and nothing else", () => {
    expect(["a.txt", "b.MD", "c.csv", "d.Xlsx", "e.pdf"].map(fileTypeOf)).toEqual(["txt", "md", "csv", "xlsx", "pdf"]);
    for (const name of ["page.html", "notes.htm", "run.exe", "script.js", "image.svg", "notes", "notes.txt.html", "doc.docx", ".pdf.exe"]) {
      expect(checkSourceFile(name, bytes("hello")), name).toEqual({ ok: false, error: WRONG_TYPE });
    }
  });

  it("checks the content, not the name alone (never the type the browser says)", () => {
    expect(checkSourceFile("notes.txt", bytes("Step 1: call them."))).toEqual({ ok: true, type: "txt" });
    expect(checkSourceFile("report.pdf", pdf(["Hi"]))).toEqual({ ok: true, type: "pdf" });
    expect(checkSourceFile("data.xlsx", xlsx([{ name: "S", xml: "" }]))).toEqual({ ok: true, type: "xlsx" });
    // A PDF or a workbook renamed to .txt, a program, text renamed to .pdf or .xlsx, invalid UTF-8, a NUL byte: all refused.
    const notReally = (t: string) => ({ ok: false, error: `That file isn't really a .${t} file. Save it as one and upload it again.` });
    expect(checkSourceFile("notes.txt", pdf(["Hi"]))).toEqual(notReally("txt"));
    expect(checkSourceFile("notes.csv", xlsx([{ name: "S", xml: "" }]))).toEqual(notReally("csv"));
    expect(checkSourceFile("notes.md", new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toEqual(notReally("md"));
    expect(checkSourceFile("notes.txt", new Uint8Array([0x68, 0x69, 0xff, 0xfe]))).toEqual(notReally("txt"));
    expect(checkSourceFile("notes.txt", bytes("a\u0000b"))).toEqual(notReally("txt"));
    expect(checkSourceFile("report.pdf", bytes("<html><script>alert(1)</script></html>"))).toEqual(notReally("pdf"));
    expect(checkSourceFile("data.xlsx", bytes("a,b,c"))).toEqual(notReally("xlsx"));
  });

  it("takes 1 byte to 10 MB", () => {
    expect(checkSourceFile("a.txt", new Uint8Array(0))).toEqual({ ok: false, error: EMPTY });
    expect(checkSourceFile("a.txt", new Uint8Array(10 * 1024 * 1024).fill(0x61))).toEqual({ ok: true, type: "txt" });
    expect(checkSourceFile("a.txt", new Uint8Array(10 * 1024 * 1024 + 1).fill(0x61))).toEqual({ ok: false, error: TOO_BIG });
  });
});

describe("where a file is kept", () => {
  it("keeps it under a plain name in the workspace's folder, and shows its own name", () => {
    expect(safeFileName("../../etc/Q3 notes?.TXT", "txt")).toBe("Q3 notes_.txt");
    expect(safeFileName("Café menu <script>.csv", "csv")).toBe("Caf_ menu _script_.csv");
    expect(safeFileName("....pdf", "pdf")).toBe("file.pdf");
    expect(safeFileName(`${"x".repeat(300)}.md`, "md")).toBe(`${"x".repeat(100)}.md`);
    expect(displayName("C:\\Users\\maya\\Café menu.csv")).toBe("Café menu.csv");
  });

  it("accepts back only a new path in this source's own folder of the caller's workspace, made the way it makes them", () => {
    expect(parseStoragePath(`${WS}/${SRC}/${U}/Q3 notes.txt`, WS, SRC)).toEqual({ path: `${WS}/${SRC}/${U}/Q3 notes.txt`, name: "Q3 notes.txt", type: "txt" });
    for (const bad of [
      `b1111111-0000-4000-8000-000000000001/${SRC}/${U}/a.txt`,
      `${WS}/${U}/${U}/a.txt`, // another source's folder
      `${WS}/${U}/a.txt`,
      `${WS}/${SRC}/a.txt`,
      `${WS}/${SRC}/not-a-uuid/a.txt`,
      `${WS}/${SRC}/${U}/sub/a.txt`,
      `${WS}/${SRC}/${U}/page.html`,
      `${WS}/${SRC}/${U}/../a.txt`,
      `${WS}/${SRC}/${U}/Café.txt`,
      42,
    ]) {
      expect(parseStoragePath(bad, WS, SRC), String(bad)).toBeNull();
    }
  });
});

describe("reading the text", () => {
  it("reads text, Markdown and CSV as they are (no byte-order mark, Unix line ends)", async () => {
    expect(await extractSourceText("notes.txt", bytes("\uFEFFMaya: we check every report.\r\nTwice."))).toEqual({ ok: true, type: "txt", text: "Maya: we check every report.\nTwice." });
    expect(await extractSourceText("sop.md", bytes("# Onboarding\n\n1. Send the welcome pack"))).toEqual({ ok: true, type: "md", text: "# Onboarding\n\n1. Send the welcome pack" });
    expect(await extractSourceText("deals.csv", bytes("client,mrr\nHarbour Lane,2400\n"))).toEqual({ ok: true, type: "csv", text: "client,mrr\nHarbour Lane,2400" });
    // HTML in a text file is kept as text (the app only ever shows it as text).
    expect(await extractSourceText("page.txt", bytes("<img src=x onerror=alert(1)>"))).toEqual({ ok: true, type: "txt", text: "<img src=x onerror=alert(1)>" });
  });

  it("reads a workbook's cells: shared and inline strings, numbers, booleans, gaps and every sheet", async () => {
    const book = xlsx(
      [
        {
          name: "Deals",
          xml:
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>2400.5</v></c></row>' +
            '<row r="3"><c r="A3" t="inlineStr"><is><t>Old &amp; Mill</t></is></c><c r="B3" t="b"><v>1</v></c></row>' +
            '<row r="4"/>',
        },
        { name: "Notes &amp; more", xml: '<row r="1"><c r="B1" t="str"><v>&lt;script&gt;x&lt;/script&gt;</v></c></row>' },
      ],
      ["<t>Client</t>", "<t xml:space=\"preserve\">Won?</t>", "<r><t>Harbour </t></r><r><t>Lane</t></r>"],
    );
    expect(await extractSourceText("deals.xlsx", book)).toEqual({ ok: true, type: "xlsx", text: "Deals\nClient\tWon?\nHarbour Lane\t\t2400.5\nOld & Mill\tTRUE\n\nNotes & more\n\t<script>x</script>" });
    expect(xmlText("&#x41;&#66;&lt;&amp;lt;")).toBe("AB<&lt;");
  });

  it("refuses a zip that isn't a workbook, and one that unpacks too big", async () => {
    expect(await extractSourceText("x.xlsx", zipSync({ "readme.txt": strToU8("hi") }))).toEqual({ ok: false, error: "That file isn't really a .xlsx file. Save it as an Excel workbook and upload it again." });
    // 120 MB of zeros packs small; it is refused before it is unpacked.
    const bomb = xlsx([{ name: "S", xml: "" }], [], { "xl/worksheets/sheet9.xml": new Uint8Array(120 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => workbookText(bomb)).toThrow();
    expect((await extractSourceText("x.xlsx", bomb)).ok).toBe(false);
  });

  it("reads a hostile workbook in time proportional to its size: unclosed rows, cells and attributes", async () => {
    const shapes = {
      "80,000 unclosed rows": "<row r=\"1\"><c r=\"A1\"><v>1</v></c>" + "<row".repeat(80_000),
      "80,000 rows that never close": '<row r="1">'.repeat(80_000),
      "80,000 unclosed attributes": `<row r="1"><c ${'r="A'.repeat(80_000)}></c></row>`,
      "80,000 unclosed comments": "<!--".repeat(80_000),
      "80,000 cells that never close": '<c r="A1" t="s"><v>0'.repeat(80_000),
    };
    for (const [what, xml] of Object.entries(shapes)) {
      const started = performance.now();
      const r = await extractSourceText("hostile.xlsx", xlsx([{ name: "S", xml }], ["<t>x</t>"]));
      expect(performance.now() - started, what).toBeLessThan(1_000);
      expect(typeof r.ok, what).toBe("boolean");
    }
    // The scanner on its own: two million unclosed tags in well under a second.
    const started = performance.now();
    let opened = 0;
    scanXml("<row".repeat(2_000_000), { open: () => opened++, close: () => {}, text: () => {} });
    expect(opened).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(attributes(` r="A1" t='s' name="a &amp; b" broken="x`)).toEqual(new Map([["r", "A1"], ["t", "s"], ["name", "a & b"]]));
  });

  it("one 2 MB shared string used by 300 cells: read in bounded time and memory, cut at what a source keeps", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const cells = Array.from({ length: 300 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>0</v></c><c r="B${i + 1}" t="s"><v>0</v></c></row>`).join("");
    const book = xlsx([{ name: "S", xml: cells }], [`<t>${big}</t>`]);
    expect(book.length).toBeLessThan(100 * 1024);
    const peakBefore = process.resourceUsage().maxRSS;
    const started = performance.now();
    const r = await extractSourceText("big-string.xlsx", book);
    expect(performance.now() - started).toBeLessThan(2_000);
    // The process's peak memory grew by well under what 300 copies of the string would take (over 1 GB).
    expect((process.resourceUsage().maxRSS - peakBefore) / 1024).toBeLessThan(150);
    expect(r.ok && r.text.length).toBe(MAX_BODY);
    expect(r.ok && r.text.endsWith("The whole file is kept.]")).toBe(true);
  });

  it("refuses a workbook that takes too long to read, or holds too much XML", async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
    expect(await extractSourceText("big.xlsx", xlsx([{ name: "S", xml: rows }]), { xlsx: 0 })).toEqual({
      ok: false,
      error: "That spreadsheet took too long to read. Save a smaller copy and upload it again.",
    });
    expect((await extractSourceText("big.xlsx", xlsx([{ name: "S", xml: rows }]))).ok).toBe(true);
    // 60 MB of sheet XML packs small; it is refused unread.
    const huge = xlsx([{ name: "S", xml: " ".repeat(60 * 1024 * 1024) }]);
    expect(huge.length).toBeLessThan(1024 * 1024);
    expect(await extractSourceText("huge.xlsx", huge)).toEqual({ ok: false, error: "That spreadsheet is too big to read. Save a smaller copy (fewer sheets or rows) and upload it again." });
  });

  it("reads a PDF's text, page by page", async () => {
    expect(await extractSourceText("sop.pdf", pdf(["Step one: send the welcome pack.", "Step two: book the kickoff (30 min)."]))).toEqual({
      ok: true,
      type: "pdf",
      text: "Step one: send the welcome pack.\n\nStep two: book the kickoff (30 min).",
    });
    expect(await extractSourceText("broken.pdf", bytes("%PDF-1.4\nnot really"))).toMatchObject({ ok: false });
  });

  it("reads at most MAX_PDF_PAGES pages and says so, and refuses a PDF that takes too long", async () => {
    const many = pdf(Array.from({ length: MAX_PDF_PAGES + 2 }, (_, i) => `Page ${i + 1}`));
    const r = await extractSourceText("long.pdf", many);
    expect(r.ok && r.text.split("\n\n").length).toBe(MAX_PDF_PAGES + 1);
    expect(r.ok && r.text.endsWith(`[Only the first ${MAX_PDF_PAGES} of ${MAX_PDF_PAGES + 2} pages were read. The whole file is kept.]`)).toBe(true);
    expect(await extractSourceText("slow.pdf", many, { pdf: 0 })).toEqual({ ok: false, error: "That PDF took too long to read. Save a smaller copy and upload it again." });
  }, 30_000);

  it("reads a PDF in a worker thread that is stopped at the time limit, so a slow PDF never holds the server", async () => {
    const many = pdf(Array.from({ length: MAX_PDF_PAGES }, (_, i) => `Page ${i + 1}`));
    let seen = 0;
    const watch = setInterval(() => (seen = Math.max(seen, activePdfWorkers())), 1);
    const started = performance.now();
    expect(await extractSourceText("slow.pdf", many, { pdf: 30 })).toEqual({ ok: false, error: "That PDF took too long to read. Save a smaller copy and upload it again." });
    clearInterval(watch);
    expect(performance.now() - started).toBeLessThan(1_000);
    // It ran in a worker, and the worker is gone.
    expect(seen).toBe(1);
    expect(activePdfWorkers()).toBe(0);
  }, 30_000);

  it("cuts very long text, and says so", async () => {
    const r = await extractSourceText("long.txt", new Uint8Array(MAX_BODY + 10).fill(0x61));
    expect(r.ok && r.text.length).toBe(MAX_BODY);
    expect(r.ok && r.text.endsWith("The whole file is kept.]")).toBe(true);
  });
});

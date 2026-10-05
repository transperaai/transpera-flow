import "server-only";

// Reading the text out of a source's file, on the server (issue #182, B19 2/2), so values can quote it. Pure JavaScript only,
// nothing native: text files are decoded as UTF-8; a workbook (.xlsx) is unzipped with fflate and its parts read by a small
// one-pass XML scanner (only tags and text are read: no entities are expanded beyond the five XML ones and character
// references, nothing is fetched, nothing backtracks); a PDF's text is read page by page with unpdf (Mozilla's PDF.js, its
// serverless build). Each has limits on size, pages and time, and a file past them is refused with a plain message rather
// than holding the server. The text is stored as the source's full text, which the app only ever shows as text.

import { unzipSync } from "fflate";
import { MAX_BODY } from "./validate";
import { checkSourceFile, decodeText, type SourceFileType } from "./file-check";

export type Extracted = { ok: true; type: SourceFileType; text: string } | { ok: false; error: string };

/** A workbook may unpack to at most this much (a zip bomb is refused, not unpacked)... */
const MAX_UNZIPPED = 100 * 1024 * 1024;
/** ...and the parts read (the workbook, its strings and sheets) to at most this much XML. */
export const MAX_SHEET_XML = 50 * 1024 * 1024;
/** Pages of a PDF read; the rest are left out, and the text says so. */
export const MAX_PDF_PAGES = 300;
/** The longest reading a file may take. */
export const READ_TIME_MS = { xlsx: 5_000, pdf: 20_000 };
const CUT = `\n\n[The text was cut at ${MAX_BODY.toLocaleString("en-GB")} characters. The whole file is kept.]`;

class NotAWorkbook extends Error {}
class TooBig extends Error {}
class TooSlow extends Error {}

/** Check `bytes` against `name` (extension, size, content), then read its text. */
export async function extractSourceText(name: string, bytes: Uint8Array, limits: Partial<typeof READ_TIME_MS> = {}): Promise<Extracted> {
  const check = checkSourceFile(name, bytes);
  if (!check.ok) return check;
  const { type } = check;
  try {
    const text =
      type === "pdf" ? await pdfText(bytes, limits.pdf ?? READ_TIME_MS.pdf) : type === "xlsx" ? workbookText(bytes, limits.xlsx ?? READ_TIME_MS.xlsx) : decodeText(bytes);
    if (text === null) return { ok: false, error: `That file isn't really a .${type} file. Save it as one and upload it again.` };
    const clean = text.replace(/\r\n?/g, "\n").trim();
    return { ok: true, type, text: clean.length > MAX_BODY ? clean.slice(0, MAX_BODY - CUT.length) + CUT : clean };
  } catch (e) {
    if (e instanceof NotAWorkbook) return { ok: false, error: "That file isn't really a .xlsx file. Save it as an Excel workbook and upload it again." };
    if (e instanceof TooBig) return { ok: false, error: "That spreadsheet is too big to read. Save a smaller copy (fewer sheets or rows) and upload it again." };
    if (e instanceof TooSlow) return { ok: false, error: `That ${type === "pdf" ? "PDF" : "spreadsheet"} took too long to read. Save a smaller copy and upload it again.` };
    return { ok: false, error: type === "pdf" ? "Couldn't read that PDF. It may be password-protected or damaged." : `Couldn't read that .${type} file. It may be damaged.` };
  }
}

// --- PDF --------------------------------------------------------------------------------------------------------------

/** `promise`, or TooSlow once `deadline` (a time in ms) has passed. */
function by<T>(promise: Promise<T>, deadline: number): Promise<T> {
  if (Date.now() >= deadline) {
    promise.catch(() => undefined);
    return Promise.reject(new TooSlow());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TooSlow()), Math.max(deadline - Date.now(), 0));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function pdfText(bytes: Uint8Array, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  const { getDocumentProxy } = await import("unpdf");
  // PDF.js takes the buffer over: give it a copy.
  const pdf = await by(getDocumentProxy(new Uint8Array(bytes)), deadline);
  try {
    const pages: string[] = [];
    const count = Math.min(pdf.numPages, MAX_PDF_PAGES);
    let length = 0;
    for (let n = 1; n <= count && length <= MAX_BODY; n++) {
      const page = await by(pdf.getPage(n), deadline);
      const content = await by(page.getTextContent(), deadline);
      const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("").trim();
      page.cleanup();
      if (text) pages.push(text);
      length += text.length;
    }
    if (pdf.numPages > MAX_PDF_PAGES) pages.push(`[Only the first ${MAX_PDF_PAGES} of ${pdf.numPages} pages were read. The whole file is kept.]`);
    return pages.join("\n\n");
  } finally {
    // Stop whatever PDF.js still has under way (it runs on this thread, in steps).
    void pdf.cleanup().catch(() => undefined);
  }
}

// --- Workbooks ----------------------------------------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** XML text with its five entities and character references turned back into characters (nothing else is expanded). */
export function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e[0] !== "#") return XML_ENTITIES[e]!;
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** A tag's attributes, read left to right in one pass: `name="value"` or `name='value'` (values as written, entities decoded). */
export function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const eq = raw.indexOf("=", i);
    if (eq < 0) break;
    const name = raw.slice(i, eq).trim();
    let q = eq + 1;
    while (q < n && (raw[q] === " " || raw[q] === "\t" || raw[q] === "\n" || raw[q] === "\r")) q++;
    const quote = raw[q];
    if (quote !== '"' && quote !== "'") break;
    const end = raw.indexOf(quote, q + 1);
    if (end < 0) break;
    if (name) out.set(name, xmlText(raw.slice(q + 1, end)));
    i = end + 1;
  }
  return out;
}

export interface XmlHandler {
  open(name: string, attrs: string, selfClosing: boolean): void;
  close(name: string): void;
  text(raw: string): void;
}

/**
 * Walks `xml` once, left to right, calling `on` for each start tag, end tag and run of text. Every search starts where the last
 * one ended, so it takes time in proportion to the length of the XML whatever it holds (an unclosed tag ends the walk). Comments,
 * processing instructions and declarations are skipped; CDATA is text. Throws TooSlow after `deadline`.
 */
export function scanXml(xml: string, on: XmlHandler, deadline = Infinity): void {
  const n = xml.length;
  let i = 0;
  let steps = 0;
  while (i < n) {
    if ((++steps & 1023) === 0 && Date.now() > deadline) throw new TooSlow();
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      on.text(xml.slice(i));
      return;
    }
    if (lt > i) on.text(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return;
      // Entities aren't decoded in CDATA: escape the ampersands so the reader's decoding leaves them as written.
      on.text(xml.slice(lt + 9, end).replace(/&/g, "&amp;"));
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) return;
      i = end + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) return;
    const tag = xml.slice(lt + 1, gt);
    if (tag[0] === "/") {
      on.close(tag.slice(1).trim());
    } else {
      const self = tag.endsWith("/");
      const body = self ? tag.slice(0, -1) : tag;
      let s = 0;
      while (s < body.length && body[s] !== " " && body[s] !== "\t" && body[s] !== "\n" && body[s] !== "\r") s++;
      on.open(body.slice(0, s), body.slice(s), self);
      if (self) on.close(body.slice(0, s));
    }
    i = gt + 1;
  }
}

/** A tag's name without its namespace prefix ("x:row" → "row"). */
const local = (name: string) => name.slice(name.indexOf(":") + 1);

/**
 * A workbook's cells as text: each sheet under its name, one line per row, cells separated by tabs (numbers as stored, shared
 * and inline strings as written, TRUE/FALSE for booleans). Formulas give their last value. Refused past MAX_SHEET_XML of XML or
 * `ms` of reading; stops once it has more text than a source keeps.
 */
export function workbookText(bytes: Uint8Array, ms = READ_TIME_MS.xlsx): string {
  const deadline = Date.now() + ms;
  let unpacked = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        const wanted = f.name === "[Content_Types].xml" || f.name === "xl/workbook.xml" || f.name === "xl/_rels/workbook.xml.rels" || f.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]{1,100}\.xml$/.test(f.name);
        if (!wanted) return false;
        unpacked += f.originalSize;
        if (unpacked > MAX_UNZIPPED) throw new TooBig();
        return true;
      },
    });
  } catch (e) {
    if (e instanceof TooBig) throw e;
    throw new NotAWorkbook("not a zip");
  }
  let xmlRead = 0;
  const read = (name: string) => {
    const part = files[name];
    if (!part) return null;
    xmlRead += part.length;
    if (xmlRead > MAX_SHEET_XML) throw new TooBig();
    return new TextDecoder().decode(part);
  };
  const workbook = read("xl/workbook.xml");
  if (!read("[Content_Types].xml") || !workbook) throw new NotAWorkbook("no workbook");

  // Shared strings: each <si>'s text runs, leaving out phonetic hints (<rPh>).
  const shared: string[] = [];
  {
    let cur: string[] | null = null;
    let inT = false;
    let skip = 0;
    scanXml(
      read("xl/sharedStrings.xml") ?? "",
      {
        open: (name, _a, self) => {
          const n = local(name);
          if (n === "si" && !self) cur = [];
          else if (n === "rPh" && !self) skip++;
          else if (n === "t" && !self && cur && !skip) inT = true;
        },
        close: (name) => {
          const n = local(name);
          if (n === "si") {
            if (cur) shared.push(cur.join(""));
            cur = null;
          } else if (n === "rPh") skip = Math.max(skip - 1, 0);
          else if (n === "t") inT = false;
        },
        text: (raw) => {
          if (inT && cur) cur.push(xmlText(raw));
        },
      },
      deadline,
    );
  }

  const rels = new Map<string, string>();
  scanXml(
    read("xl/_rels/workbook.xml.rels") ?? "",
    {
      open: (name, raw) => {
        if (local(name) !== "Relationship") return;
        const a = attributes(raw);
        const id = a.get("Id");
        const target = a.get("Target");
        if (id && target) rels.set(id, target);
      },
      close: () => {},
      text: () => {},
    },
    deadline,
  );
  const sheets: { name: string; path: string }[] = [];
  scanXml(
    workbook,
    {
      open: (name, raw) => {
        if (local(name) !== "sheet") return;
        const a = attributes(raw);
        const target = rels.get(a.get("r:id") ?? "");
        const path = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target}`).replace(/^xl\/\.\.\//, "") : `xl/worksheets/sheet${sheets.length + 1}.xml`;
        sheets.push({ name: a.get("name") ?? `Sheet ${sheets.length + 1}`, path });
      },
      close: () => {},
      text: () => {},
    },
    deadline,
  );

  const out: string[] = [];
  let length = 0;
  for (const sheet of sheets) {
    if (length > MAX_BODY) break;
    const xml = read(sheet.path);
    if (!xml) continue;
    const lines: string[] = [];
    let cells: string[] | null = null;
    let cell: { col: number | null; t: string | undefined; v: string[]; is: string[] } | null = null;
    let mode: "v" | "t" | null = null;
    let inIs = false;
    scanXml(
      xml,
      {
        open: (name, raw, self) => {
          const n = local(name);
          if (n === "row") cells = [];
          else if (n === "c" && cells) {
            const a = attributes(raw);
            cell = { col: columnIndex(a.get("r")), t: a.get("t"), v: [], is: [] };
          } else if (n === "v" && cell && !self) mode = "v";
          else if (n === "is" && cell) inIs = !self;
          else if (n === "t" && cell && inIs && !self) mode = "t";
        },
        close: (name) => {
          const n = local(name);
          if (n === "v" || n === "t") mode = null;
          else if (n === "is") inIs = false;
          else if (n === "c" && cell && cells) {
            if (length > MAX_BODY) {
              // Enough text already: the rest is cut anyway.
              cell = null;
              mode = null;
              return;
            }
            const v = cell.v.join("");
            const value = cell.t === "s" ? (shared[Number(v)] ?? "") : cell.t === "inlineStr" ? cell.is.join("") : cell.t === "b" ? (v === "1" ? "TRUE" : "FALSE") : xmlText(v);
            while (cell.col !== null && cells.length < cell.col) cells.push("");
            cells.push(value.replace(/[\t\n\r]+/g, " "));
            cell = null;
            mode = null;
          } else if (n === "row" && cells) {
            while (cells.length && !cells.at(-1)) cells.pop();
            if (cells.length && length <= MAX_BODY) {
              const line = cells.join("\t");
              lines.push(line);
              length += line.length + 1;
            }
            cells = null;
          }
        },
        text: (raw) => {
          if (!cell || !mode) return;
          if (mode === "v") cell.v.push(raw);
          else cell.is.push(xmlText(raw));
        },
      },
      deadline,
    );
    if (lines.length) out.push(`${sheets.length > 1 ? `${sheet.name}\n` : ""}${lines.join("\n")}`);
  }
  return out.join("\n\n");
}

/** "C7" → 2 (zero-based column), or null when there is no reference (or it is past Excel's last column). */
function columnIndex(ref: string | undefined): number | null {
  if (!ref) return null;
  let n = 0;
  let i = 0;
  for (; i < ref.length && i < 3; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return i === 0 ? null : Math.min(n - 1, 16_383);
}

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
/** A workbook is read to one character past what a source keeps, so the cut (and its note) shows. */
const BUDGET = MAX_BODY + 1;
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

/** `promise`, or TooSlow once `deadline` (a time in ms) has passed; `onLate` runs then (to stop the work). */
function by<T>(promise: Promise<T>, deadline: number, onLate?: () => void): Promise<T> {
  if (Date.now() >= deadline) {
    promise.catch(() => undefined);
    onLate?.();
    return Promise.reject(new TooSlow());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onLate?.();
      reject(new TooSlow());
    }, Math.max(deadline - Date.now(), 0));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

type PdfPages = { pages: string[]; numPages: number };

/** The text of each page (up to `maxPages`, stopping past `maxChars`), with unpdf. Runs in the worker, or here as a fallback. */
const READ_PAGES = `async function readPages(unpdf, bytes, maxPages, maxChars, onTask) {
  const { getResolvedPDFJS } = unpdf;
  const { getDocument } = await getResolvedPDFJS();
  const task = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  onTask(task);
  const pdf = await task.promise;
  const pages = [];
  const count = Math.min(pdf.numPages, maxPages);
  let length = 0;
  for (let n = 1; n <= count && length <= maxChars; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\\n" : "") : "")).join("").trim();
    page.cleanup();
    if (text) pages.push(text);
    length += text.length;
  }
  return { pages, numPages: pdf.numPages };
}`;

/** The worker: read the pages and post them back. It is terminated (all its work stops) if it takes too long. */
const WORKER = `const { parentPort, workerData } = require("node:worker_threads");
${READ_PAGES}
readPages(require(workerData.unpdf), workerData.bytes, workerData.maxPages, workerData.maxChars, () => {}).then(
  (result) => parentPort.postMessage({ ok: true, result }),
  () => parentPort.postMessage({ ok: false }),
);`;

let workers = 0;
/** How many PDF workers are running (for tests: none is left behind after a timeout). */
export const activePdfWorkers = () => workers;

/** Where unpdf's CommonJS build is, for the worker to load (null when it can't be found from here). */
async function unpdfPath(): Promise<string | null> {
  try {
    const { createRequire } = await import("node:module");
    const { join } = await import("node:path");
    return createRequire(join(process.cwd(), "package.json")).resolve("unpdf");
  } catch {
    return null;
  }
}

/** Reads the pages in a worker thread, terminated at the deadline: a PDF can't hold the server's own thread. */
async function pagesInWorker(bytes: Uint8Array, deadline: number, unpdf: string): Promise<PdfPages> {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(WORKER, { eval: true, workerData: { unpdf, bytes, maxPages: MAX_PDF_PAGES, maxChars: MAX_BODY }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
  workers++;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    workers--;
    void worker.terminate();
  };
  const done = new Promise<PdfPages>((resolve, reject) => {
    worker.once("message", (m: { ok: boolean; result?: PdfPages }) => (m.ok && m.result ? resolve(m.result) : reject(new Error("unreadable"))));
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("worker ended")));
  });
  try {
    return await by(done, deadline, end);
  } finally {
    end();
  }
}

/** Reads the pages on this thread, destroying the document at the deadline (when no worker can be started). */
async function pagesHere(bytes: Uint8Array, deadline: number): Promise<PdfPages> {
  const unpdf = await import("unpdf");
  let task: { destroy(): Promise<void> } | null = null;
  const readPages = new Function(`return (${READ_PAGES})`)() as (
    unpdf: unknown,
    bytes: Uint8Array,
    maxPages: number,
    maxChars: number,
    onTask: (t: { destroy(): Promise<void> }) => void,
  ) => Promise<PdfPages>;
  return by(readPages(unpdf, bytes, MAX_PDF_PAGES, MAX_BODY, (t) => (task = t)), deadline, () => void (task as { destroy(): Promise<void> } | null)?.destroy().catch(() => undefined));
}

async function pdfText(bytes: Uint8Array, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  if (Date.now() >= deadline) throw new TooSlow();
  // PDF.js takes the buffer over: give it a copy.
  const copy = new Uint8Array(bytes);
  const unpdf = await unpdfPath();
  const { pages, numPages } = unpdf ? await pagesInWorker(copy, deadline, unpdf) : await pagesHere(copy, deadline);
  if (numPages > MAX_PDF_PAGES) pages.push(`[Only the first ${MAX_PDF_PAGES} of ${numPages} pages were read. The whole file is kept.]`);
  return pages.join("\n\n");
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

  // Shared strings: each <si>'s text runs, leaving out phonetic hints (<rPh>), each cut at what a source keeps (a cell can't
  // show more than that, and one huge string used by many cells must not be copied for each).
  const shared: string[] = [];
  {
    let cur: string[] | null = null;
    let curLength = 0;
    let inT = false;
    let skip = 0;
    scanXml(
      read("xl/sharedStrings.xml") ?? "",
      {
        open: (name, _a, self) => {
          const n = local(name);
          if (n === "si" && !self) {
            cur = [];
            curLength = 0;
          }
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
          if (!inT || !cur || curLength >= BUDGET) return;
          const piece = clip(raw, BUDGET - curLength);
          cur.push(piece);
          curLength += piece.length;
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

  // The text so far (`length`, all sheets) and of the row being read (`rowLength`): once it passes what a source keeps, nothing
  // more is built, so the work and the memory are bounded by BUDGET whatever the cells refer to. The time is checked every
  // 256 cells as well as every 1,024 tags.
  const out: string[] = [];
  let length = 0;
  let cellsRead = 0;
  const room = (rowLength: number) => BUDGET - length - rowLength;
  for (const sheet of sheets) {
    if (length >= BUDGET) break;
    const xml = read(sheet.path);
    if (!xml) continue;
    const lines: string[] = [];
    let cells: string[] | null = null;
    let rowLength = 0;
    let cell: { col: number | null; t: string | undefined; v: string; is: string } | null = null;
    let mode: "v" | "t" | null = null;
    let inIs = false;
    scanXml(
      xml,
      {
        open: (name, raw, self) => {
          const n = local(name);
          if (n === "row") {
            cells = [];
            rowLength = 0;
          } else if (n === "c" && cells) {
            if ((++cellsRead & 255) === 0 && Date.now() > deadline) throw new TooSlow();
            const a = attributes(raw);
            cell = { col: columnIndex(a.get("r")), t: a.get("t"), v: "", is: "" };
          } else if (n === "v" && cell && !self) mode = "v";
          else if (n === "is" && cell) inIs = !self;
          else if (n === "t" && cell && inIs && !self) mode = "t";
        },
        close: (name) => {
          const n = local(name);
          if (n === "v" || n === "t") mode = null;
          else if (n === "is") inIs = false;
          else if (n === "c" && cell && cells) {
            const left = room(rowLength);
            if (left > 0) {
              const v = cell.v;
              const value = cell.t === "s" ? (shared[Number(v)] ?? "") : cell.t === "inlineStr" ? cell.is : cell.t === "b" ? (v === "1" ? "TRUE" : "FALSE") : xmlText(v);
              // Gaps before it, then its value: no more of either than there is room for.
              const gap = cell.col === null ? 0 : Math.min(Math.max(cell.col - cells.length, 0), left);
              for (let g = 0; g < gap; g++) cells.push("");
              const shown = (value.length > left - gap ? value.slice(0, Math.max(left - gap, 0)) : value).replace(/[\t\n\r]+/g, " ");
              cells.push(shown);
              rowLength += gap + shown.length + 1;
            }
            cell = null;
            mode = null;
          } else if (n === "row" && cells) {
            while (cells.length && !cells.at(-1)) cells.pop();
            if (cells.length && length < BUDGET) {
              const line = cells.join("\t");
              lines.push(line);
              length += line.length + 1;
            }
            cells = null;
            rowLength = 0;
          }
        },
        text: (raw) => {
          if (!cell || !mode) return;
          // A value is never longer than there is room for (a few characters more, for entities still to be decoded).
          const left = room(rowLength) - (mode === "v" ? cell.v.length : cell.is.length);
          if (left <= 0) return;
          if (mode === "v") cell.v += raw.length > left + 16 ? raw.slice(0, left + 16) : raw;
          else cell.is += clip(raw, left);
        },
      },
      deadline,
    );
    if (lines.length) out.push(`${sheets.length > 1 ? `${sheet.name}\n` : ""}${lines.join("\n")}`);
  }
  return out.join("\n\n");
}

/** At most `max` characters of decoded XML text from `raw`, without decoding more of it than that needs. */
function clip(raw: string, max: number): string {
  if (max <= 0) return "";
  // An entity is at most 10 characters and decodes to one or two: `max * 10` raw characters are always enough.
  const text = xmlText(raw.length > max * 10 ? raw.slice(0, max * 10) : raw);
  return text.length > max ? text.slice(0, max) : text;
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

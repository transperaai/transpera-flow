import "server-only";

// Reading the text out of a source's file, on the server (issue #182, B19 2/2), so values can quote it. Pure JavaScript only,
// nothing native: text files are decoded as UTF-8; a workbook (.xlsx) is unzipped with fflate and its cells read from the
// sheet XML (only text nodes are read: no entities are expanded beyond the five XML ones and character references, nothing is
// fetched); a PDF's text is read with unpdf (Mozilla's PDF.js, its serverless build). The text is stored as the source's full
// text, which the app only ever shows as text, never as HTML.

import { unzipSync } from "fflate";
import { MAX_BODY } from "./validate";
import { checkSourceFile, decodeText, type SourceFileType } from "./file-check";

export type Extracted = { ok: true; type: SourceFileType; text: string } | { ok: false; error: string };

/** A workbook may unpack to at most this much (a zip bomb is refused, not unpacked). */
const MAX_UNZIPPED = 100 * 1024 * 1024;
const CUT = `\n\n[The text was cut at ${MAX_BODY.toLocaleString("en-GB")} characters. The whole file is kept.]`;

/** Check `bytes` against `name` (extension, size, content), then read its text. */
export async function extractSourceText(name: string, bytes: Uint8Array): Promise<Extracted> {
  const check = checkSourceFile(name, bytes);
  if (!check.ok) return check;
  const { type } = check;
  try {
    const text = type === "pdf" ? await pdfText(bytes) : type === "xlsx" ? workbookText(bytes) : decodeText(bytes);
    if (text === null) return { ok: false, error: `That file isn't really a .${type} file. Save it as one and upload it again.` };
    const clean = text.replace(/\r\n?/g, "\n").trim();
    return { ok: true, type, text: clean.length > MAX_BODY ? clean.slice(0, MAX_BODY - CUT.length) + CUT : clean };
  } catch (e) {
    if (e instanceof NotAWorkbook) return { ok: false, error: "That file isn't really a .xlsx file. Save it as an Excel workbook and upload it again." };
    return { ok: false, error: type === "pdf" ? "Couldn't read that PDF. It may be password-protected or damaged." : `Couldn't read that .${type} file. It may be damaged.` };
  }
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // PDF.js takes the buffer over: give it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).map((page) => page.trim()).filter(Boolean).join("\n\n");
}

class NotAWorkbook extends Error {}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** XML text with its five entities and character references turned back into characters (nothing else is expanded). */
export function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e[0] !== "#") return XML_ENTITIES[e]!;
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** The text runs (`<t>`) inside an element, joined. */
const runs = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1]!)).join("");
const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

/**
 * A workbook's cells as text: each sheet under its name, one line per row, cells separated by tabs (numbers as stored, shared
 * and inline strings as written, TRUE/FALSE for booleans). Formulas give their last value.
 */
export function workbookText(bytes: Uint8Array): string {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new NotAWorkbook("too big unpacked");
      return f.name === "[Content_Types].xml" || f.name === "xl/workbook.xml" || f.name === "xl/_rels/workbook.xml.rels" || f.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(f.name);
    },
  });
  const read = (name: string) => (files[name] ? new TextDecoder().decode(files[name]) : null);
  const workbook = read("xl/workbook.xml");
  if (!read("[Content_Types].xml") || !workbook) throw new NotAWorkbook("no workbook");

  const shared = [...(read("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")));
  const rels = new Map([...(read("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [attr(m[1]!, "Id"), attr(m[1]!, "Target")]));
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m, i) => {
    const target = rels.get(attr(m[1]!, "r:id"));
    const path = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target}`) : `xl/worksheets/sheet${i + 1}.xml`;
    return { name: xmlText(attr(m[1]!, "name") ?? `Sheet ${i + 1}`), xml: read(path.replace(/^xl\/\.\.\//, "")) };
  });

  const out: string[] = [];
  for (const sheet of sheets) {
    if (!sheet.xml) continue;
    const lines: string[] = [];
    for (const row of sheet.xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = [];
      for (const c of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = columnIndex(attr(c[1]!, "r"));
        const t = attr(c[1]!, "t");
        const inner = c[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        const value = t === "s" ? (shared[Number(v)] ?? "") : t === "inlineStr" ? runs(inner) : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : v !== undefined ? xmlText(v) : "";
        while (col !== null && cells.length < col) cells.push("");
        cells.push(value.replace(/[\t\n\r]+/g, " "));
      }
      while (cells.length && !cells.at(-1)) cells.pop();
      if (cells.length) lines.push(cells.join("\t"));
    }
    if (lines.length) out.push(`${sheets.length > 1 ? `${sheet.name}\n` : ""}${lines.join("\n")}`);
  }
  return out.join("\n\n");
}

/** "C7" → 2 (zero-based column), or null when there is no reference. */
function columnIndex(ref: string | undefined): number | null {
  const letters = ref ? /^([A-Z]+)/.exec(ref)?.[1] : undefined;
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

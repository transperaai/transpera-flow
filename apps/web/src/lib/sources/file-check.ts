// A source's original file (issue #182, B19 2/2): which files are accepted, checked by their name AND their content (never by
// the type the browser declares), and where one is kept in Storage. Pure, so the browser (an early, friendly refusal), the
// server action (the check that counts) and the tests agree.
//
// Accepted: .txt, .md, .csv (UTF-8 text), .xlsx (an Excel workbook: a zip with the workbook parts) and .pdf, from 1 byte to
// 10 MB. Anything else, or a file whose content doesn't match its extension (a renamed program, an HTML page called notes.txt
// is still text and is only ever shown as text), is refused with a plain message.

import { MAX_SOURCE_FILE_BYTES, SOURCE_FILE_TYPES, type SourceFileType } from "@transpera-flow/db";

export { MAX_SOURCE_FILE_BYTES, SOURCE_FILE_TYPES, type SourceFileType };

/** The content type Storage keeps with each kind (the bucket allows only these). */
export const SOURCE_FILE_MIME: Record<SourceFileType, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

export const SOURCE_FILE_LABELS: Record<SourceFileType, string> = { txt: "Text", md: "Markdown", csv: "CSV", xlsx: "Excel", pdf: "PDF" };

/** For a file picker's `accept`. */
export const SOURCE_FILE_ACCEPT = SOURCE_FILE_TYPES.map((t) => `.${t}`).join(",");

export const WRONG_TYPE = "Upload a .txt, .md, .csv, .xlsx or .pdf file.";
export const TOO_BIG = "That file is over 10 MB. Split it, or keep it elsewhere and add a link to it.";
export const EMPTY = "That file is empty.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The kind a file name says it is (by its last extension), or null when it isn't one we take. */
export function fileTypeOf(name: string): SourceFileType | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  const ext = m?.[1]?.toLowerCase();
  return ext && (SOURCE_FILE_TYPES as readonly string[]).includes(ext) ? (ext as SourceFileType) : null;
}

/**
 * The name a file is kept under in Storage: no folders, only letters, digits, spaces and `_ - . ( ) ,` (Storage refuses many
 * other characters in a key, including accented letters), at most 100 characters, ending in its kind's extension.
 * "../../etc/Q3 notes?.TXT" → "Q3 notes_.txt". The name people see is kept separately (`displayName`).
 */
export function safeFileName(name: string, type: SourceFileType): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const stem = base
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[^A-Za-z0-9 _\-.(),]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100);
  return `${stem || "file"}.${type}`;
}

/** The name people see: the file's own name without any folders, trimmed to 200 characters (always shown as text). */
export function displayName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base.slice(0, 200) || "file";
}

/** Where a file is kept: `<workspace id>/<a new uuid>/<safe name>` (the folder the storage policies read). */
export function storagePath(workspaceId: string, uuid: string, name: string): string {
  return `${workspaceId}/${uuid}/${name}`;
}

/** A path from the browser, if it is one this workspace may have made; its kind comes from its name. */
export function parseStoragePath(path: unknown, workspaceId: string): { path: string; name: string; type: SourceFileType } | null {
  if (typeof path !== "string" || path.length > 200) return null;
  const parts = path.split("/");
  if (parts.length !== 3 || parts[0] !== workspaceId || !UUID.test(parts[1]!)) return null;
  const name = parts[2]!;
  const type = fileTypeOf(name);
  if (!type || safeFileName(name, type) !== name) return null;
  return { path, name, type };
}

const starts = (bytes: Uint8Array, sig: readonly number[]) => sig.every((b, i) => bytes[i] === b);
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // PK\3\4
/** Starts of common binary files that are never text. */
const BINARY = [PDF, ZIP, [0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x7f, 0x45, 0x4c, 0x46], [0x4d, 0x5a], [0xd0, 0xcf, 0x11, 0xe0], [0x1f, 0x8b]];

export type FileCheck = { ok: true; type: SourceFileType } | { ok: false; error: string };

/**
 * Whether `bytes` are an acceptable file called `name`: the extension is one we take, the size is within limits, and the content
 * is what the extension says (a PDF starts %PDF-, a workbook is a zip, text is UTF-8 with no NUL bytes and no binary start). A
 * workbook's inside is checked again when its text is read.
 */
export function checkSourceFile(name: string, bytes: Uint8Array): FileCheck {
  const type = fileTypeOf(name);
  if (!type) return { ok: false, error: WRONG_TYPE };
  if (bytes.length === 0) return { ok: false, error: EMPTY };
  if (bytes.length > MAX_SOURCE_FILE_BYTES) return { ok: false, error: TOO_BIG };
  const mismatch = { ok: false, error: `That file isn't really a .${type} file. Save it as one and upload it again.` } as const;
  if (type === "pdf") return starts(bytes, PDF) ? { ok: true, type } : mismatch;
  if (type === "xlsx") return starts(bytes, ZIP) ? { ok: true, type } : mismatch;
  return decodeText(bytes) === null ? mismatch : { ok: true, type };
}

/** UTF-8 text without its byte-order mark, or null when the bytes aren't text (invalid UTF-8, a NUL, or a binary file's start). */
export function decodeText(bytes: Uint8Array): string | null {
  if (BINARY.some((sig) => starts(bytes, sig))) return null;
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** "2.4 MB", "830 KB", "512 bytes". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Upload a process (issue #166, B13): what the preview dialog shows and what it sends back. Framework-free, so the
// server actions and the dialog share it and tests can run it. The file's own rules (the format, errors and warnings) are
// in packages/db/src/process-file.ts; the company's roles come from the server (packages/mcp/src/import-file.ts).

import type { ProcessFile } from "@transpera-flow/db/process-file";

/** A process file is a few kilobytes; this stops a wrong file (a video, a database dump) before it is read or sent. */
export const MAX_UPLOAD_BYTES = 500_000;

export interface UploadPreview {
  /** What the file is called, or the link; also what the change log says. */
  source: string;
  name: string;
  kind: ProcessFile["kind"];
  steps: number;
  links: number;
  groups: number;
  /** Problems that stop the upload: the person fixes the file (or asks Claude to) and uploads it again. */
  errors: string[];
  warnings: string[];
  /** The company's roles an unknown role can be mapped to. */
  roles: { id: string; name: string }[];
  /** Roles in the file the company has: shown as matched, nothing to do. */
  matchedRoles: { name: string; role: string }[];
  /** Roles in the file the company doesn't have: each is mapped to one of `roles` or left blank. Never created. */
  unknownRoles: string[];
  unknownPeople: string[];
  /** The name of a process that already has this name, if any. */
  nameTaken: string | null;
}

/** What the preview action returns: a preview to show (with the process text, for a link, which the server fetched), or why there isn't one. */
export type PreviewResult = { preview: UploadPreview; text?: string; error?: undefined } | { preview?: undefined; text?: undefined; error: string };

/** What is previewed: the process text of a file (the browser has already taken it out of an HTML page), or a link for the server to fetch. */
export type PreviewInput = { kind: "file"; text: string; fileName: string } | { kind: "link"; url: string };

/** The biggest file the browser will read: an HTML page can be large, and only the process block in it is sent on. */
export const MAX_FILE_BYTES = 5_000_000;

/** Why a chosen file can't be read at all, before it is read. */
export function fileSizeProblem(bytes: number): string | null {
  return bytes > MAX_FILE_BYTES
    ? `That file is ${Math.round(bytes / 1000).toLocaleString("en-GB")} KB, which is too big to be a process file or a Claude Design page. Upload the file Claude made.`
    : null;
}

export interface CreateUploadInput {
  /** The file's text, checked again on the server. */
  text: string;
  /** The file name or link, for the change log. */
  source: string;
  /** A different name than the file gives. */
  name: string;
  /** For each unknown role: [role as the file names it, a company role id or null to leave blank]. Pairs, not an object: a role can be called "__proto__". */
  roleMap: [string, string | null][];
}

export interface CreateUploadResult {
  error?: string;
}

/** Why a file can't be read at all, before it is sent anywhere. */
export function uploadSizeProblem(bytes: number): string | null {
  return bytes > MAX_UPLOAD_BYTES
    ? `That file is ${Math.round(bytes / 1000).toLocaleString("en-GB")} KB. A process file is a few KB, so it is probably the wrong file. Upload the JSON file Claude made.`
    : null;
}

/** What the change log says the upload came from: a link as it is, a file by its name (no folders); no control characters, at most 300 characters. */
export function sourceLabel(fileName: string): string {
  if (/^https:\/\//i.test(fileName.trim())) {
    // A link is logged as its origin and path only: a query string or fragment can carry a token, and the log is read by others.
    let shown = fileName.trim();
    try {
      const u = new URL(shown);
      shown = `${u.origin}${u.pathname}`;
    } catch {
      shown = shown.split(/[?#]/)[0]!;
    }
    return shown.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300);
  }
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean || "uploaded file").slice(0, 200);
}

/** The file Claude (or the person) made, as the example download: pretty-printed JSON. */
export function downloadHref(text: string): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
}

/** True for the error a server action's redirect() throws on its way to the new page (it carries a digest starting NEXT_REDIRECT). */
export function isRedirect(e: unknown): boolean {
  return typeof e === "object" && e !== null && typeof (e as { digest?: unknown }).digest === "string" && (e as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

// The note an upload leaves for the editor it lands in (issue #166): a few warnings in a short-lived cookie. Pure, so the
// server action that writes it and the editor banner that reads it agree, and tests can run it.

export const NOTICE_COOKIE = "tf-upload-notice";
const MAX_WARNINGS = 5;
const MAX_LENGTH = 220;

export interface UploadNotice {
  processId: string;
  warnings: string[];
}

/** The cookie's value: the first few warnings, each cut short so the whole stays well inside a cookie's size. */
export function noticeValue(processId: string, warnings: readonly string[]): string | null {
  const kept = warnings.slice(0, MAX_WARNINGS).map((w) => (w.length > MAX_LENGTH ? `${w.slice(0, MAX_LENGTH - 1)}…` : w));
  if (warnings.length > MAX_WARNINGS) kept.push(`…and ${warnings.length - MAX_WARNINGS} more. They show on the map and the checklist.`);
  return kept.length ? JSON.stringify({ processId, warnings: kept } satisfies UploadNotice) : null;
}

/** Read the cookie's value back; anything that isn't a notice is ignored. */
export function parseNotice(value: string): UploadNotice | null {
  try {
    const v: unknown = JSON.parse(value);
    if (typeof v !== "object" || v === null) return null;
    const { processId, warnings } = v as Record<string, unknown>;
    if (typeof processId !== "string" || !Array.isArray(warnings) || !warnings.every((w) => typeof w === "string")) return null;
    return { processId, warnings: (warnings as string[]).slice(0, MAX_WARNINGS + 1) };
  } catch {
    return null;
  }
}

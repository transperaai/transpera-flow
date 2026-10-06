// What a restore leaves for the Overview it lands on (issue #39, B10 2b): one sentence in a short-lived cookie, as the upload
// notice does (lib/processes/upload-notice.ts). The restore ends in a navigation, so the browser sets the cookie, and the banner
// reads it once and clears it. Nothing in it is secret.

export const RESTORE_NOTICE_COOKIE = "tf-restore-notice";

export function restoredMessage(processes: number, settings: string): string {
  const n = `${processes} ${processes === 1 ? "process" : "processes"}`;
  const base = `Restored ${n} as drafts. Publish each one to see its numbers.`;
  return settings === "suggested" ? `${base} The workspace settings are waiting for an owner to accept them (Suggestions).` : base;
}

export function noticeCookieValue(message: string): string {
  return encodeURIComponent(JSON.stringify({ message: message.slice(0, 400) }));
}

/** Read the cookie's value back; anything that isn't a notice is ignored. */
export function parseRestoreNotice(value: string): string | null {
  try {
    const v: unknown = JSON.parse(decodeURIComponent(value));
    if (typeof v !== "object" || v === null) return null;
    const { message } = v as Record<string, unknown>;
    return typeof message === "string" && message ? message.slice(0, 400) : null;
  } catch {
    return null;
  }
}

// How the share pages print dates, counts and a link's state (issue #32, B3). Pure; UTC everywhere, so the server and the browser agree.

/** "5 Oct 2026". */
export function shareDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "5 Oct" (no year). */
export function shortShareDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export type ShareStatus = "active" | "expired" | "off";

/** Turned off wins over expired: a turned-off link stays off whatever its end date. */
export function shareStatus(link: { revokedAt: string | null; expiresAt: string | null }, now: Date = new Date()): ShareStatus {
  if (link.revokedAt) return "off";
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= now.getTime()) return "expired";
  return "active";
}

export const STATUS_LABELS: Record<ShareStatus, string> = { active: "Active", expired: "Expired", off: "Turned off" };

/** "3 times, last 5 Oct", "Once, last 5 Oct" or "Not yet". */
export function openedText(opens: number, lastOpenedAt: string | null): string {
  if (opens <= 0) return "Not yet";
  const times = opens === 1 ? "Once" : `${opens} times`;
  return lastOpenedAt ? `${times}, last ${shortShareDate(lastOpenedAt)}` : times;
}

/** What the people toggle shows, in the table's words. */
export const showsPeople = (on: boolean) => (on ? "Names" : "Team member labels");
/** What the financials toggle shows, in the table's words. */
export const showsFinancials = (on: boolean) => (on ? "Costs and margins" : "Revenue only");
/** Who may open it. */
export const whoText = (emails: readonly string[]) => (emails.length === 0 ? "Anyone with the link" : emails.length === 1 ? "1 person" : `${emails.length} people`);

// What a person types into the Share dialog, checked (issue #32, B3). Pure: the dialog runs it before it asks the server, the
// Server Action runs it again, and the database has the same rules (constraints `share_links_restricted` and `share_links_emails`).
// Wording is plain: it is shown as it is.

import { SHARE_KINDS, type ShareKind } from "@transpera-flow/db";

export const MAX_EMAILS = 50;
export const MAX_LABEL = 120;
/** The dialog pre-fills a link that works for this long. */
export const DEFAULT_DAYS = 30;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** As the dialog sends it. `emails` is what was typed: separated by commas, spaces or new lines. */
export interface ShareInput {
  kind: ShareKind;
  /** The process, issue or solution; null for the Overview. */
  targetId: string | null;
  people: boolean;
  financials: boolean;
  emails: string;
  /** "YYYY-MM-DD": the link works until the end of that day (UTC). Null: no end date. */
  expiresOn: string | null;
  label: string;
}

export interface ParsedShare {
  kind: ShareKind;
  targetId: string | null;
  people: boolean;
  financials: boolean;
  /** Lower-case, without duplicates; empty when both toggles are off. */
  emails: string[];
  /** The end of the chosen day, UTC (ISO), or null. */
  expiresAt: string | null;
  label: string | null;
}

export type ShareParse = { ok: true; value: ParsedShare } | { ok: false; message: string };

/** The addresses typed, split on commas, semicolons, spaces and new lines; lower-cased, de-duplicated, in the order typed. */
export function parseEmails(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

const today = (now: Date) => now.toISOString().slice(0, 10);

/** The date `days` from `now`, "YYYY-MM-DD" (UTC): the dialog's default end date. */
export function daysFromNow(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A "YYYY-MM-DD" that names a real day. */
const realDate = (d: string) => DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

export function parseShareInput(input: unknown, now: Date = new Date()): ShareParse {
  const fail = (message: string): ShareParse => ({ ok: false, message });
  if (!input || typeof input !== "object") return fail("Something went wrong. Try again.");
  const i = input as Partial<Record<keyof ShareInput, unknown>>;
  if (typeof i.kind !== "string" || !SHARE_KINDS.includes(i.kind as ShareKind)) return fail("Choose a page to share.");
  const kind = i.kind as ShareKind;
  if (kind === "overview") {
    if (i.targetId != null) return fail("Something went wrong. Try again.");
  } else if (typeof i.targetId !== "string" || !UUID.test(i.targetId)) {
    return fail("Choose a page to share.");
  }
  const people = i.people === true;
  const financials = i.financials === true;
  const restricted = people || financials;

  const emails = restricted ? parseEmails(typeof i.emails === "string" ? i.emails : "") : [];
  if (restricted) {
    if (emails.length === 0) return fail("Add at least one email address.");
    if (emails.length > MAX_EMAILS) return fail(`Add no more than ${MAX_EMAILS} email addresses.`);
    const bad = emails.find((e) => !EMAIL.test(e));
    if (bad) return fail(`“${bad.length > 60 ? `${bad.slice(0, 57)}…` : bad}” isn't an email address.`);
  }

  let expiresAt: string | null = null;
  if (typeof i.expiresOn === "string" && i.expiresOn !== "") {
    if (!realDate(i.expiresOn)) return fail("Choose when the link stops working.");
    // The link works until the end of that day, so the day itself must still be ahead: strictly after today.
    if (i.expiresOn <= today(now)) return fail("Choose a day after today.");
    expiresAt = `${i.expiresOn}T23:59:59.000Z`;
  } else if (restricted) {
    return fail("Choose when the link stops working.");
  }

  const label = typeof i.label === "string" ? i.label.trim() : "";
  if (label.length > MAX_LABEL) return fail(`Keep the name under ${MAX_LABEL} characters.`);

  return { ok: true, value: { kind, targetId: kind === "overview" ? null : (i.targetId as string), people, financials, emails, expiresAt, label: label || null } };
}

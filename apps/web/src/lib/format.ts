// The one place numbers become text, so every screen rounds and labels the same way.
import type { InitialState, Stat } from "@transpera-flow/engine";

const WORKING_DAYS_PER_WEEK = 5;
const LOCALE = "en-GB";

export function formatNumber(value: number, digits = 1): string {
  return value.toLocaleString(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Working hours to working days, given the workspace's hours per week. */
export function formatDays(hours: number, hoursPerWeek: number): string {
  const days = hours / (hoursPerWeek / WORKING_DAYS_PER_WEEK);
  return `${formatNumber(days, days < 10 ? 1 : 0)} d`;
}

const DATE_PARTS = { day: "numeric", month: "short", timeZone: "UTC" } as const;

/** "19 Oct – 30 Oct 2026" from two ISO dates; the year is on the first date too when the years differ, and a single day is one date. */
export function formatDateRange(start: string, end: string): string {
  const withYear = new Intl.DateTimeFormat(LOCALE, { ...DATE_PARTS, year: "numeric" });
  const noYear = new Intl.DateTimeFormat(LOCALE, DATE_PARTS);
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);
  if (start === end) return withYear.format(a);
  return `${a.getUTCFullYear() === b.getUTCFullYear() ? noYear.format(a) : withYear.format(a)} – ${withYear.format(b)}`;
}

export function formatHours(hours: number): string {
  return `${formatNumber(hours, 1)} h`;
}

/** Money, compacted above 10,000 (e.g. £27k, £1.2m). */
export function formatCurrency(value: number, currency: string): string {
  const compact = Math.abs(value) >= 10_000;
  return value.toLocaleString(LOCALE, {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0,
  });
}

/**
 * Money in whole units, never compacted (e.g. £109,500). For text rendered on
 * the server too: compact notation differs between Node's and browsers' ICU
 * ("£109.5K" / "£109.5k"), which breaks hydration.
 */
export function formatWholeCurrency(value: number, currency: string): string {
  return value.toLocaleString(LOCALE, { style: "currency", currency, maximumFractionDigits: 0 });
}

/** How a run started (PRD §6.3.1), for the results' footnote. */
export function formatInitialState(start: InitialState, hoursPerWeek: number): string {
  switch (start.kind) {
    case "wip":
      return `Started from entered WIP (${formatNumber(start.items, 0)} ${start.items === 1 ? "item" : "items"})`;
    case "warmup":
      return `Started after a ${formatNumber(start.hours / hoursPerWeek, 1)}-week warm-up, excluded from results`;
    case "empty":
      return "Started empty (no WIP entered, no warm-up)";
  }
}

/** "range 5–10" for the 10th–90th percentile band, using the metric's own formatter. */
export function formatRange(stat: Stat, format: (v: number) => string): string {
  const low = format(stat.p10);
  const high = format(stat.p90);
  return low === high ? `range ${low}` : `range ${low}–${high}`;
}

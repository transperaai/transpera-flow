// Market conditions on the settings page (A57): wording, input checks and the timeline's shape. Pure, so it is
// unit tested. The checks only reject malformed input early: every write still runs as the signed-in user through
// RLS and the tables' check constraints. Wording follows the prototype (apps/web/prototype/app-flow.html, `HELP`).

import { MARKET_FACTOR_KEYS, type MarketFactorKey } from "@transpera-flow/engine";
import type { MarketConditionRow, MarketScheduleRow } from "@transpera-flow/db";
import { isId } from "./services";

export const MARKET_MONTHS = 24;

/** The sliders' range, as a percent of today; the database allows 0 to 500. */
export const SLIDER_MIN = 50;
export const SLIDER_MAX = 150;

export const FACTORS: readonly { key: MarketFactorKey; label: string; description: string; example: string }[] = [
  { key: "leads", label: "Enquiries", description: "How many new enquiries you get, compared with today.", example: "85% means 15% fewer enquiries." },
  { key: "conv", label: "Enquiries that sign", description: "How many enquiries turn into clients, compared with today.", example: "90% means slightly fewer people sign." },
  { key: "cycle", label: "Time to decide", description: "How long people take to decide to buy, compared with today.", example: "120% means they take 20% longer to decide." },
  { key: "price", label: "Prices you can charge", description: "How much you can charge, compared with today.", example: "95% means you give about 5% discount." },
  { key: "churn", label: "Clients leaving", description: "How easily clients leave, compared with today.", example: "115% means 15% more clients leave." },
  { key: "hire", label: "Time to hire", description: "How long it takes to hire someone, compared with today.", example: "130% means hiring takes 30% longer." },
  { key: "pay", label: "Late payments", description: "How late clients pay, compared with today.", example: "115% means invoices get paid later." },
];

/** What each factor does in the simulation today, for the small print under the sliders. */
// Time to hire acts through the Sandbox's hiring delay (D9) only; late payments (pay) change nothing yet.
export const UNUSED_FACTORS: readonly MarketFactorKey[] = ["pay"];

export const CONDITION_HELP: Record<string, { description: string; example: string }> = {
  boom: { description: "Business is booming: lots of enquiries, fewer clients leave, but hiring is hard.", example: "25% more enquiries, 15% fewer clients leaving." },
  stable: { description: "Things stay as they are today.", example: "Every factor at 100%." },
  soft: { description: "Business slows down: fewer enquiries and slower decisions.", example: "15% fewer enquiries, decisions take 20% longer." },
  downturn: { description: "A recession: far fewer enquiries, more clients leave, and they pay late.", example: "35% fewer enquiries, 35% more clients leaving." },
  custom: { description: "Your own mix of conditions, saved with a name.", example: "“Cautious 2027”: slightly fewer enquiries, slightly more clients leaving." },
};

export const SCHEDULE_HELP = {
  description: "Which market applies in which months over the next 2 years. The simulation switches conditions month by month. Months you leave empty are Stable.",
  example: "Stable for months 1 to 6, Soft from month 7, then your own “Cautious 2027” from month 15.",
};

export const helpFor = (c: Pick<MarketConditionRow, "preset">) => CONDITION_HELP[c.preset ?? "custom"]!;

/** Presets first (in the prototype's order), then your own by name. */
export function orderConditions(conditions: readonly MarketConditionRow[]): MarketConditionRow[] {
  const order = ["boom", "stable", "soft", "downturn"];
  const presets = conditions.filter((c) => c.preset).sort((a, b) => order.indexOf(a.preset!) - order.indexOf(b.preset!));
  const own = conditions.filter((c) => !c.preset).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [...presets, ...own];
}

/** Colour of a condition on the timeline: a preset's own, or the brand tint for your own. */
export function conditionTone(c: Pick<MarketConditionRow, "preset"> | undefined): "good" | "plain" | "warn" | "crit" | "own" {
  switch (c?.preset) {
    case "boom":
      return "good";
    case "soft":
      return "warn";
    case "downturn":
      return "crit";
    case "stable":
      return "plain";
    default:
      return "own";
  }
}

export interface TimelineMonth {
  month: number;
  /** Null: no change covers it, so it is Stable. */
  conditionId: string | null;
  /** The month a change starts in, where its name is written. */
  starts: boolean;
}

/** The 24 months of the schedule, for drawing. Where changes overlap (the database refuses that), the later one wins. */
export function timeline(schedule: readonly MarketScheduleRow[]): TimelineMonth[] {
  const months: TimelineMonth[] = Array.from({ length: MARKET_MONTHS }, (_, i) => ({ month: i + 1, conditionId: null, starts: false }));
  for (const e of schedule) {
    for (let m = Math.max(1, e.from_month); m <= Math.min(MARKET_MONTHS, e.to_month); m++) {
      months[m - 1] = { month: m, conditionId: e.condition_id, starts: m === e.from_month };
    }
  }
  return months;
}

export interface TimelineSegment {
  from: number;
  to: number;
  /** Null: no change covers these months, so they are Stable. */
  conditionId: string | null;
}

/** The timeline as runs of months under the same condition, for drawing one block per run. */
export function segments(schedule: readonly MarketScheduleRow[]): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  for (const m of timeline(schedule)) {
    const last = out[out.length - 1];
    if (last && last.conditionId === m.conditionId && !m.starts) last.to = m.month;
    else out.push({ from: m.month, to: m.month, conditionId: m.conditionId });
  }
  return out;
}

/** "M7–M14" or "M3". */
export const monthRange = (from: number, to: number) => (from === to ? `M${from}` : `M${from}–M${to}`);

const isMonth = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MARKET_MONTHS;
const isPercent = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 500;

/** A condition column saved on its own: its name, or one of the seven factors (a whole percent). */
export function parseConditionField(id: unknown, field: unknown, value: unknown): { id: string; field: "name" | MarketFactorKey; value: string | number } | null {
  if (!isId(id) || typeof field !== "string") return null;
  if (field === "name") {
    return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80 ? { id, field, value: value.trim() } : null;
  }
  if (!(MARKET_FACTOR_KEYS as readonly string[]).includes(field)) return null;
  return isPercent(value) ? { id, field: field as MarketFactorKey, value } : null;
}

/** A new change on the schedule, if well formed. Returns the reason when not, in plain words. */
export function parseChange(
  workspaceId: unknown,
  conditionId: unknown,
  from: unknown,
  to: unknown,
  existing: readonly Pick<MarketScheduleRow, "from_month" | "to_month">[] = [],
): { workspaceId: string; conditionId: string; from: number; to: number } | { error: string } {
  if (!isId(workspaceId) || !isId(conditionId)) return { error: "Pick a market." };
  if (!isMonth(from) || !isMonth(to)) return { error: `Months run from 1 to ${MARKET_MONTHS}.` };
  if (to < from) return { error: "The last month must be the same as or after the first." };
  const clash = existing.find((e) => e.from_month <= to && e.to_month >= from);
  if (clash) return { error: `${monthRange(clash.from_month, clash.to_month)} already has a change. Remove it first, or pick other months.` };
  return { workspaceId, conditionId, from, to };
}

/** The name a copy gets: "<name> (custom)", or "New market" starting from Stable. */
export const copyName = (source: Pick<MarketConditionRow, "name"> | undefined) => (source ? `${source.name} (custom)`.slice(0, 80) : "New market");

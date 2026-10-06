// Settings, Churn drivers (A56, issue #121): wording, the screen's state and input checks. Pure, so it is unit
// tested. Wording follows the prototype (apps/web/prototype/app-flow.html, `DRV` and the `drv.*` help). The checks
// only reject malformed input early: every write still runs as the signed-in user through RLS and the table's checks.

import {
  BUILTIN_CHURN_DRIVER_IDS,
  CHURN_DRIVER_SPECS,
  CHURN_SOURCE_LABELS,
  CHURN_WEIGHT_MAX,
  CHURN_WEIGHT_MIN,
  CUSTOM_DRIVER_PREFIX,
  CUSTOM_DRIVER_VALUE,
  type BuiltinChurnDriverId,
  type ChurnCause,
  type EngineChurnDriver,
  type EngineModel,
} from "@transpera-flow/engine";
import type { ChurnDriverKey, ChurnDriverRow, Viewer } from "@transpera-flow/db";
import { isId } from "./services";
import { personName, viewerOf } from "./viewer";

/** The most drivers of your own a workspace can have (the database's limit). */
export const MAX_CUSTOM_DRIVERS = 25;

export interface HelpCopy {
  description: string;
  example: string;
}

/** What each built-in cause is, in plain words (the prototype's `drv.*`). */
export const DRIVER_HELP: Record<BuiltinChurnDriverId, HelpCopy> = {
  late: { description: "Client work done late or not at all.", example: "14 in every 100 reports go out late." },
  resp: { description: "How long clients wait for a reply when they ask for something.", example: "Clients wait 20 hours for an answer." },
  onb: { description: "How long a new client waits for their first piece of work.", example: "19 days from signing to the first delivery." },
  rework: { description: "Work you had to fix after the client saw it.", example: "1 in 10 reports needs fixing after it's sent." },
  load: { description: "The team looking after the client is too busy to give them proper attention.", example: "The strategist is busy 92% of the time, above the 85% line." },
  handoff: { description: "A client gets a new account manager.", example: "About 1 in 3 clients changes account manager each year." },
  results: { description: "Whether clients are happy with their results. You enter this.", example: "Clients rate their results 7 out of 10." },
  tenure: { description: "New clients leave more easily than long-standing ones.", example: "In their first 6 months, clients are 1.6 times as likely to leave." },
  price: { description: "Raising prices makes some clients leave.", example: "A 10% price rise in March." },
  market: { description: "When times are tough, clients cut spending.", example: "From month 7 the market slows, so more clients leave." },
};

/** The (i) beside each control that isn't a cause itself. */
export const CONTROL_HELP = {
  weight: {
    description: "How much this cause matters. 1 is normal. 0 means ignore it. 3 means it matters three times as much.",
    example: "Late work is set to 1.5, so it matters a bit more than normal.",
  },
  switch: {
    description: "Turns this cause on or off. Off means the simulation ignores it, as if its weight were 0.",
    example: "Switch off “Price changes” if you aren't planning a price rise.",
  },
  contribution: {
    description: "How much of the churn in the simulation this cause explains, with the weights you've set. The rest is normal churn.",
    example: "41% means about 4 in 10 of the clients who leave, leave because of this.",
  },
  normal: {
    description: "The clients who would leave anyway, even when everything is going well. It's the Normal churn you set for each service in Settings, under Services and client groups.",
    example: "If late work explains 40% and nothing else matters, normal churn is the other 60%.",
  },
  projected: {
    description: "How many clients leave each month with these weights, worked out from what the latest simulation measured. It moves as you change weights.",
    example: "1.4 clients a month means about 8 clients in 6 months.",
  },
  name: { description: "What you call your own cause of clients leaving.", example: "A cheaper competitor opens nearby." },
  describe: { description: "One sentence on what it is, so anyone reading understands it.", example: "A rival agency is offering our clients a lower price." },
  exampleField: { description: "A real-life example of it, in your own words.", example: "Two clients moved to the agency down the road last quarter." },
  ownValue: {
    description: "How much extra churn this cause adds when its weight is 1, in percent. You estimate it.",
    example: "15 means 15% more clients leave than normal.",
  },
  remove: { description: "Takes your own cause away for good. Switch it off instead if you might want it back.", example: "Remove “A cheaper competitor” once they've closed down." },
} as const satisfies Record<string, HelpCopy>;

/** The number a built-in takes, if it takes one: what it is called and its (i). */
export const VALUE_HELP: Partial<Record<BuiltinChurnDriverId, HelpCopy & { label: string; unit: string; step: number }>> = {
  onb: {
    label: "Normal first delivery",
    unit: "working days",
    step: 1,
    description: "How many working days a new client should wait for their first piece of work. Waiting longer than this counts as slow onboarding.",
    example: "10 days. A client who waits 15 days waited 50% too long.",
  },
  handoff: {
    label: "Account manager changes",
    unit: "of clients a year (0 to 1)",
    step: 0.05,
    description: "The share of clients who get a new account manager in a year, from 0 (nobody) to 1 (every client). The simulation also counts the weeks the people looking after them are away.",
    example: "0.3 means about 1 in 3 clients changes account manager each year.",
  },
  results: {
    label: "Average rating",
    unit: "out of 10",
    step: 0.1,
    description: "How happy clients are with their results, out of 10. A rating of 8 or more adds no churn; each point below adds a little.",
    example: "7 out of 10 means clients are fairly happy but not delighted.",
  },
  tenure: {
    label: "Likelihood in months 1 to 6",
    unit: "times as likely",
    step: 0.1,
    description: "How many times more likely a new client is to leave during their first 6 months than later on.",
    example: "1.6 means they are 60% more likely to leave.",
  },
  price: {
    label: "Planned price rise",
    unit: "%",
    step: 1,
    description: "How much you plan to put your prices up, in percent. Some clients leave after a rise; this counts for about 3 months. Leave it at 0 if there's no change planned.",
    example: "A 10% rise makes about 20% more clients leave for 3 months.",
  },
};

export const PRICE_MONTH_HELP = {
  label: "Takes effect in month",
  description: "The month the price rise starts, counted from today (1 to 24).",
  example: "3 means the rise starts in month 3.",
} as const;

/** One cause as the screen holds it. */
export interface DriverState {
  /** A built-in's key, or the stored row's id for your own; a new one before it is stored has the id `new:<n>`. */
  key: string;
  builtin: BuiltinChurnDriverId | null;
  /** The stored row, when there is one. */
  rowId: string | null;
  name: string;
  description: string;
  example: string;
  weight: number;
  enabled: boolean;
  value: number | null;
  month: number | null;
}

/** The ten built-ins in the screen's order (each from its row or at its default), then your own in creation order. */
export function driverStates(rows: readonly ChurnDriverRow[]): DriverState[] {
  const byKey = new Map(rows.filter((r) => r.driver).map((r) => [r.driver as ChurnDriverKey, r]));
  const out: DriverState[] = BUILTIN_CHURN_DRIVER_IDS.map((id) => {
    const spec = CHURN_DRIVER_SPECS[id];
    const r = byKey.get(id);
    return {
      key: id,
      builtin: id,
      rowId: r?.id ?? null,
      name: spec.name,
      description: "",
      example: "",
      weight: r ? Number(r.weight) : 1,
      enabled: r ? r.enabled : spec.defaultEnabled,
      value: spec.valueRange ? (r && r.value !== null ? Number(r.value) : spec.defaultValue) : null,
      month: id === "price" ? (r?.month ?? 1) : null,
    };
  });
  for (const r of rows) {
    if (r.driver) continue;
    out.push({
      key: r.id,
      builtin: null,
      rowId: r.id,
      name: r.name ?? "Your own driver",
      description: r.description ?? "",
      example: r.example ?? "",
      weight: Number(r.weight),
      enabled: r.enabled,
      value: r.value !== null ? Number(r.value) : CUSTOM_DRIVER_VALUE.default,
      month: null,
    });
  }
  return out;
}

/** The drivers as the engine takes them, for a run and for the projection. */
export function toEngineDrivers(states: readonly DriverState[]): EngineChurnDriver[] {
  return states.map((d) => ({
    id: d.builtin ?? `${CUSTOM_DRIVER_PREFIX}${d.key}`,
    weight: d.weight,
    enabled: d.enabled,
    ...(d.value !== null ? { value: d.value } : {}),
    ...(d.builtin === "price" && d.month !== null ? { month: d.month } : {}),
    ...(d.builtin === null ? { name: d.name } : {}),
  }));
}

/** The engine id of a screen driver: what `ChurnCause.id` and the projection use. */
export const engineIdOf = (d: Pick<DriverState, "key" | "builtin">): string => d.builtin ?? `${CUSTOM_DRIVER_PREFIX}${d.key}`;

/**
 * What changes the measured pressures, and so needs a new simulation: the entered numbers and which drivers of
 * your own there are. Weights and switches don't (the screen projects them from the run), so moving a slider
 * doesn't re-run anything.
 */
export function pressureKey(states: readonly DriverState[]): string {
  return JSON.stringify(states.map((d) => [d.key, d.builtin ? d.value : [d.name, d.value], d.month]));
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const num = (v: number, digits = 1) => v.toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** Where a cause's number comes from, as the screen words it. */
export const sourceLabel = (d: Pick<DriverState, "builtin">): string => CHURN_SOURCE_LABELS[d.builtin ? CHURN_DRIVER_SPECS[d.builtin].source : "entered"];

/** "14% of reports late": the cause's value in the latest run, or why there isn't one. */
export function valueNow(d: DriverState, cause: ChurnCause | undefined, model: Pick<EngineModel, "people"> | null, viewer?: Viewer): string {
  const v = cause?.value ?? null;
  switch (d.builtin) {
    case "late":
      return v === null ? "no servicing work in the run" : `${pct(v)} of servicing work late or missed`;
    case "resp":
      return v === null ? "no ad-hoc requests in the run" : `${num(v)} h to answer an ad-hoc request`;
    case "onb":
      return v === null ? "no new clients signed in the run" : `${num(v)} working days to first delivery`;
    case "rework":
      return v === null ? "no servicing work in the run" : `${pct(v)} of servicing work redone`;
    case "load": {
      if (v === null) return "no people to measure";
      const named = cause?.valuePerson ? model?.people?.[cause.valuePerson] : undefined;
      const who = named && cause?.valuePerson ? personName(viewerOf({ viewer }), cause.valuePerson, named.name) : undefined;
      return `${who ? `${who}, ` : "busiest person "}${pct(v)} busy`;
    }
    case "handoff":
      return `${pct(d.value ?? 0)} of clients change account manager a year`;
    case "results":
      return `${num(d.value ?? 0)} / 10 average`;
    case "tenure":
      return `×${num(d.value ?? 1)} in months 1 to 6`;
    case "price":
      return d.value ? `${num(d.value)}% rise from month ${d.month ?? 1}` : "no change planned";
    case "market":
      return v === null || Math.abs(v - 1) < 1e-9 ? "Stable: no change to churn" : `${pct(v)} of today's churn, on average`;
    default:
      return `${num(d.value ?? 0)}% extra churn at weight 1`;
  }
}

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

/** What one edit can change on a driver. */
export interface DriverPatch {
  weight?: number;
  enabled?: boolean;
  value?: number | null;
  month?: number | null;
  name?: string;
  description?: string | null;
  example?: string | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A driver key: a built-in's, or the id of one of your own. */
export const isDriverKey = (v: unknown): v is string => typeof v === "string" && ((BUILTIN_CHURN_DRIVER_IDS as readonly string[]).includes(v) || isId(v));

/** The ranges the table accepts, by built-in (your own: `CUSTOM_DRIVER_VALUE`). */
function valueInRange(key: string, v: number): boolean {
  if (isId(key)) return v >= CUSTOM_DRIVER_VALUE.min && v <= CUSTOM_DRIVER_VALUE.max;
  const range = CHURN_DRIVER_SPECS[key as BuiltinChurnDriverId]?.valueRange;
  return Boolean(range) && v >= range!.min && v <= range!.max;
}

/** A patch, if every field in it is allowed for that driver; null otherwise. Text is trimmed; empty text is cleared. */
export function parseDriverPatch(key: unknown, patch: unknown): DriverPatch | null {
  if (!isDriverKey(key) || typeof patch !== "object" || patch === null || Array.isArray(patch)) return null;
  const custom = isId(key);
  const out: DriverPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case "weight":
        if (!isNum(v) || v < CHURN_WEIGHT_MIN || v > CHURN_WEIGHT_MAX) return null;
        out.weight = Math.round(v * 100) / 100;
        break;
      case "enabled":
        if (typeof v !== "boolean") return null;
        out.enabled = v;
        break;
      case "value":
        if (v === null) out.value = null;
        else if (isNum(v) && valueInRange(key, v)) out.value = v;
        else return null;
        break;
      case "month":
        if (key !== "price" || !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 24)) return null;
        out.month = v as number;
        break;
      case "name":
        if (!custom || typeof v !== "string" || v.trim().length < 1 || v.trim().length > 80) return null;
        out.name = v.trim();
        break;
      case "description":
      case "example":
        if (!custom || !(v === null || typeof v === "string")) return null;
        if (typeof v === "string" && v.trim().length > 300) return null;
        out[k] = typeof v === "string" && v.trim() ? v.trim() : null;
        break;
      default:
        return null;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** The name a new driver of your own starts with. */
export const NEW_DRIVER_NAME = "New driver";

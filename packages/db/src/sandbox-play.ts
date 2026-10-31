// The free-play Sandbox's levers (capacity build P7, docs/plans/capacity/p7-sandbox-brief.md; decisions D28, D29, D31, D36, D38).
//
// The Sandbox is free play: a `PlayState` is what the levers on the left say, and nothing is saved. This file turns it into what the engine
// runs, in two parts, both pure:
//
//   1. `playChanges` maps each lever to the lever REGISTRY (`sandbox-levers.ts`), so the existing runner (`prepareScenario`) does the work:
//        Leads %, Win rate %, market from a month   A1 (opportunities, a multiple, from a month), A3 (conversion), the market schedule (edit below)
//        Churn %                                    B3 (base churn, a multiple, whole run)
//        Prices, change % by tier, from a month     B5 (price rise) per service of the tier
//        Someone leaves in a month                  D2        Hire a role from a month   D1 (one FTE)
//        Map version of a process from a month      E6 (a solution goes live from a month; spliced, so a switch part-way through a run works)
//   2. `applyPlay` does what the registry has no lever for, as edits to each run's model (`EngineModel`):
//        Win new clients                            `wonClients` (engine optional field: clients that skip the sales steps), least-busy placement
//        A named client leaves in a month           `EngineClient.leavesMonth`
//        Clients react to a price rise (D36)        the price churn driver in chance mode: effect = the tier's `price_rise_churn` x 0.5 / 1 / 2
//        A block swapped in for a step              `EngineModel.changes`, one `EngineStepChange` per swapped change, `startMonth` = the month
//        A hire's ramp                              `EnginePerson.ramp` = the workspace default
//
// Months in a `PlayState` are 0-based indexes of the twelve months of the run (0 is the first); the engine's `startMonth`, `month` and `leavesMonth` are 1-based.

import { MARKET_PRESETS, STABLE_MARKET, type EngineChurnDriver, type EngineModel, type MarketFactors, type MarketPresetKey, type WonClientsEntry } from "@transpera-flow/engine";
import type { CapacitySetup } from "./capacity-setup";
import { tierCount } from "./capacity-setup";
import { toEngineStepChange, type CapacityChangeRow } from "./capacity-changes";
import type { SandboxChange } from "./sandbox-levers";

/** The months a free-play run covers. */
export const PLAY_MONTHS = 12;
/** A price rise weighs on churn for this many months (the price driver's default hit length). */
export const PRICE_RISE_MONTHS = 3;

export type PriceReaction = "barely" | "normally" | "strongly";
/** "Clients react" (D36): the share of the tier's own `price_rise_churn` the price driver uses. Normally is 1x, so it is exactly twice Barely. */
export const PRICE_REACTION: Record<PriceReaction, { label: string; factor: number }> = {
  barely: { label: "Barely", factor: 0.5 },
  normally: { label: "Normally", factor: 1 },
  strongly: { label: "Strongly", factor: 2 },
};

export type PlayMarket = "today" | MarketPresetKey;

export interface PlayState {
  /** Market conditions from `marketFrom`; "today" leaves the workspace's own schedule. */
  market: PlayMarket;
  marketFrom: number;
  /** Percent change to leads and win rate, from `marketFrom`. */
  leads: number;
  win: number;
  /** Percent change to base churn, whole run. */
  churn: number;
  /** Win new clients: a month per department (id), from `addFrom` for `addMonths` months, in one tier or "mix" (the department's usual mix). */
  add: Record<string, number>;
  addFrom: number;
  addMonths: number;
  addTier: "mix" | string;
  /** Prices: percent change, from `priceFrom`, for "all" tiers or one tier key; how clients react. */
  price: number;
  priceFrom: number;
  priceTier: "all" | string;
  priceReaction: PriceReaction;
  leavers: { person: string; month: number }[];
  hires: { role: string; month: number }[];
  /** Named clients (client ids) who leave in a month. */
  lose: { id: string; month: number }[];
  /** Blocks swapped in: capacity change id -> the month it starts. */
  blocks: Record<string, number>;
  /** Map versions: process id -> a solution of that process live from a month. A process not listed runs today's map. */
  versions: Record<string, { solution: string; month: number }>;
}

export function defaultPlay(): PlayState {
  return {
    market: "today",
    marketFrom: 0,
    leads: 0,
    win: 0,
    churn: 0,
    add: {},
    addFrom: 1,
    addMonths: 3,
    addTier: "mix",
    price: 0,
    priceFrom: 3,
    priceTier: "all",
    priceReaction: "normally",
    leavers: [],
    hires: [],
    lose: [],
    blocks: {},
    versions: {},
  };
}

/** Whether no lever has been moved: the run is today's path. */
export function playIsDefault(p: PlayState): boolean {
  const d = defaultPlay();
  return (
    p.market === d.market && !p.leads && !p.win && !p.churn && !Object.values(p.add).some((n) => n > 0) && !p.price && !p.leavers.length && !p.hires.length && !p.lose.length &&
    !Object.keys(p.blocks).length && !Object.keys(p.versions).length
  );
}

/** What the levers need to know about the workspace. */
export interface PlayContext {
  /** The ISO date the run starts on (its first month is this date's month). */
  startDate: string;
  setup: Pick<CapacitySetup, "departments" | "tiers" | "services" | "groups" | "clients" | "portfolio" | "rampDefault">;
  /** The workspace's changes (the library the block pickers draw on). */
  library: readonly CapacityChangeRow[];
  /** A department's usual win mix: its tier services' share of wins, by service id (`winMix`). */
  winMix: (departmentId: string) => Record<string, number>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Months

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM" of the month `index` months after the one `startDate` falls in. */
export function monthKey(startDate: string, index: number): string {
  const y = Number(startDate.slice(0, 4));
  const m = Number(startDate.slice(5, 7)) - 1 + index;
  return `${y + Math.floor(m / 12)}-${pad(((m % 12) + 12) % 12 + 1)}`;
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mar" for the month `index` months after the start. */
export function monthShort(startDate: string, index: number): string {
  return SHORT[Number(monthKey(startDate, index).slice(5, 7)) - 1]!;
}

const clampMonth = (m: number) => Math.min(PLAY_MONTHS - 1, Math.max(0, Math.round(Number(m) || 0)));

// ---------------------------------------------------------------------------------------------------------------------
// Win new clients

/** `total` shared by `shares` in whole numbers that add up to `total` (largest remainder; ties go to the first). */
export function splitWhole(total: number, shares: readonly number[]): number[] {
  const sum = shares.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || total <= 0) return shares.map(() => 0);
  const exact = shares.map((s) => (total * s) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length]!.i]!++;
  return out;
}

const tierKeyOf = (setup: PlayContext["setup"], tierId: string | null): string | null => setup.tiers.find((t) => t.id === tierId)?.key ?? null;

/** The service that is `tier` (a tier key) of `departmentId`, or null. */
export function tierService(setup: PlayContext["setup"], departmentId: string, tier: string): string | null {
  return setup.services.find((s) => s.active && s.department_id === departmentId && tierKeyOf(setup, s.tier_id) === tier)?.id ?? null;
}

/**
 * The engine's `wonClients` for the "Win new clients" lever: for each department, N a month for k months from a month, in one tier or in
 * the department's usual mix. The department's total (N x k) is shared across its tiers by largest remainder, then each tier's share is
 * spread over the k months (the first months take the extra one), so N x k clients land, by tier, exactly.
 */
export function winEntries(play: PlayState, ctx: Pick<PlayContext, "setup" | "winMix">): WonClientsEntry[] {
  const months = Math.max(1, Math.min(PLAY_MONTHS, Math.round(Number(play.addMonths) || 1)));
  const from = clampMonth(play.addFrom);
  const out: WonClientsEntry[] = [];
  for (const dept of ctx.setup.departments) {
    const n = Math.round(Number(play.add[dept.id]) || 0);
    if (n <= 0) continue;
    const total = n * months;
    let ids: string[];
    let shares: number[];
    if (play.addTier === "mix") {
      const mix = ctx.winMix(dept.id);
      ids = Object.keys(mix);
      shares = ids.map((id) => mix[id]!);
    } else {
      const id = tierService(ctx.setup, dept.id, play.addTier);
      ids = id ? [id] : [];
      shares = id ? [1] : [];
    }
    const parts = splitWhole(total, shares);
    ids.forEach((service, i) => {
      const count = parts[i]!;
      const base = Math.floor(count / months);
      const extra = count - base * months;
      for (let k = 0; k < months; k++) {
        const c = base + (k < extra ? 1 : 0);
        if (c > 0) out.push({ service, month: from + k + 1, count: c });
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Prices

/** The services of a tier ("all": every tier service) across departments. */
function priceServices(play: PlayState, setup: PlayContext["setup"]): string[] {
  return setup.services
    .filter((s) => s.active && s.tier_id && (play.priceTier === "all" || tierKeyOf(setup, s.tier_id) === play.priceTier))
    .map((s) => s.id);
}

/**
 * The extra churn for each 10% rise (D36) the price driver is set to: the chosen tiers' `price_rise_churn`, weighted by how many clients
 * each tier service has (a plain mean when none have any), times the reaction's factor.
 */
export function priceDriverEffect(play: PlayState, setup: PlayContext["setup"]): number {
  const ids = priceServices(play, setup);
  const services = setup.services.filter((s) => ids.includes(s.id));
  if (!services.length) return 0;
  const weights = services.map((s) => tierCount(s.id, setup));
  const sum = weights.reduce((a, b) => a + b, 0);
  const rate = sum > 0 ? services.reduce((a, s, i) => a + s.price_rise_churn * weights[i]!, 0) / sum : services.reduce((a, s) => a + s.price_rise_churn, 0) / services.length;
  return rate * PRICE_REACTION[play.priceReaction].factor;
}

// ---------------------------------------------------------------------------------------------------------------------
// Levers -> the registry

/** An id for a change the Sandbox makes (a uuid-shaped string, stable, never starting with the restore's placeholder prefix). */
export const playChangeId = (kind: string, n = 0): string => {
  const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `5ba0${(hex(kind) + "00000000").slice(0, 4)}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
};

/**
 * The registry changes the levers make. `A1` and `A3` and `B5` are monthly channels, `D1` and `D2` are people rows, `E6` is a spliced run,
 * and `B3` is a whole-run edit; none needs anything but the existing runner.
 */
export function playChanges(play: PlayState, ctx: Pick<PlayContext, "startDate" | "setup">): SandboxChange[] {
  const out: SandboxChange[] = [];
  const at = (m: number) => monthKey(ctx.startDate, clampMonth(m));
  const leads = Number(play.leads) || 0;
  const win = Number(play.win) || 0;
  if (leads) out.push({ id: playChangeId("A1"), lever: "A1", target: null, op: "multiply", value: round(1 + leads / 100), from: at(play.marketFrom) });
  if (win) out.push({ id: playChangeId("A3"), lever: "A3", target: null, op: "multiply", value: round(1 + win / 100), from: at(play.marketFrom) });
  const churn = Number(play.churn) || 0;
  if (churn) out.push({ id: playChangeId("B3"), lever: "B3", target: null, op: "multiply", value: round(1 + churn / 100) });
  const price = Number(play.price) || 0;
  if (price) {
    if (play.priceTier === "all") out.push({ id: playChangeId("B5"), lever: "B5", target: null, op: "set", value: round(price / 100), from: at(play.priceFrom) });
    else priceServices(play, ctx.setup).forEach((service, i) => out.push({ id: playChangeId("B5", i), lever: "B5", target: service, op: "set", value: round(price / 100), from: at(play.priceFrom) }));
  }
  play.leavers.forEach((l, i) => out.push({ id: playChangeId("D2", i), lever: "D2", target: l.person, op: "set", value: 0, from: at(l.month) }));
  play.hires.forEach((h, i) => out.push({ id: playChangeId("D1", i), lever: "D1", target: h.role, op: "set", value: 1, from: at(h.month) }));
  Object.entries(play.versions).forEach(([, v], i) => out.push({ id: playChangeId("E6", i), lever: "E6", target: v.solution, op: "set", value: 1, from: at(v.month) }));
  return out;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** The ids of the people the levers add (a hire's row id is its change's id). */
export const hireIds = (play: PlayState): string[] => play.hires.map((_, i) => playChangeId("D1", i));

// ---------------------------------------------------------------------------------------------------------------------
// Levers -> the model

/** The market schedule with `preset` from month `from` on (0-based) and the model's own schedule before it. */
export function marketFrom(model: EngineModel, preset: MarketPresetKey, from: number): { months: MarketFactors[] } {
  const own = model.market?.months ?? [STABLE_MARKET];
  const months: MarketFactors[] = [];
  for (let i = 0; i < PLAY_MONTHS; i++) months.push(i < from ? (own[Math.min(i, own.length - 1)] ?? STABLE_MARKET) : MARKET_PRESETS[preset].factors);
  return { months };
}

/**
 * The model a run uses, with the levers the registry has no lever for. `planPeople` is the set of ids of people the levers added (hires), who
 * take the workspace's ramp. Returns the same model object when nothing is to change.
 */
export function applyPlay(model: EngineModel, play: PlayState, ctx: PlayContext, planPeople: ReadonlySet<string> = new Set()): EngineModel {
  let m = model;
  if (play.market !== "today") m = { ...m, market: marketFrom(m, play.market, clampMonth(play.marketFrom)) };
  const wins = winEntries(play, ctx);
  if (wins.length) m = { ...m, wonClients: [...(m.wonClients ?? []), ...wins], placeNewClients: m.placeNewClients ?? "least-busy" };
  const swapped = ctx.library.filter((c) => play.blocks[c.id] !== undefined);
  if (swapped.length) m = { ...m, changes: [...(m.changes ?? []), ...swapped.map((c) => toEngineStepChange(c, clampMonth(play.blocks[c.id]!) + 1))] };
  if (play.lose.length && m.clients) {
    const clients = { ...m.clients };
    for (const l of play.lose) if (clients[l.id]) clients[l.id] = { ...clients[l.id]!, leavesMonth: clampMonth(l.month) + 1 };
    m = { ...m, clients };
  }
  if (Number(play.price)) {
    const effect = priceDriverEffect(play, ctx.setup);
    const drivers: EngineChurnDriver[] = [...(m.churnDrivers ?? [])];
    const at = drivers.findIndex((d) => d.id === "price");
    const entry: EngineChurnDriver = { ...(at >= 0 ? drivers[at]! : { id: "price", weight: 1 }), enabled: true, chance: 1, effect, effectMonths: PRICE_RISE_MONTHS };
    if (at >= 0) drivers[at] = entry;
    else drivers.push(entry);
    m = { ...m, churnDrivers: drivers };
  }
  if (planPeople.size && m.people) {
    const people = { ...m.people };
    for (const id of planPeople) if (people[id] && people[id]!.ramp === undefined) people[id] = { ...people[id]!, ramp: [...ctx.setup.rampDefault] };
    m = { ...m, people };
  }
  return m;
}

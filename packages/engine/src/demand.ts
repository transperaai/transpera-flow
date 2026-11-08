// Arrival times (docs/PRD.md §6.3.2): a Poisson process whose rate is
// `leadsPerWeek`, optionally modulated by the calendar month (seasonality) and
// compounded monthly growth. The rate is piecewise constant, one piece per
// calendar month, so the arrivals are drawn by time change: unit-rate
// exponential gaps are spent against each month's rate in turn. That costs
// one draw per arrival plus one step per month crossed, and a month's
// multiplier changes how far each draw reaches, not the draws themselves, so
// a seasonal scenario and a flat baseline share their random numbers.

import { activeChannels, channelMonth, planChannels } from "./channels";
import { activeMarket } from "./market";
import type { EngineDemand, EngineModel } from "./model";
import { expo, type Rng } from "./random";

/** Weeks in a calendar month: twelve months make a 52-week year. */
export const WEEKS_PER_CALENDAR_MONTH = 52 / 12;

const MONTHS = 12;

/** A model's demand, checked, or null when the rate is constant. */
interface Calendar {
  /** Arrivals per hour before seasonality and growth. */
  base: number;
  monthHours: number;
  startMonth: number;
  /** The whole month t = 0 falls in (growth counts from it). */
  firstMonth: number;
  seasonality: number[];
  growth: number;
  /** Market months' multipliers on the rate (market.ts), counted from t = 0; null with no market effect on enquiries. */
  leads: number[] | null;
  /**
   * The `leads` channel (channels.ts) as its changes: the multiplier before the first (month 0's, which also covers the warm-up) and
   * where it changes, month starts whose value equals the one before left out, so a stretch of equal months is one piece of the walk and
   * the arrivals before a change are exactly those of a run without the channel. Null without the channel.
   */
  channel: { first: number; steps: { t: number; f: number }[]; months: number[]; starts: readonly number[] } | null;
  /** Demand is flat, with no market leads: the rate is `base` (× the channel), walked with the very arithmetic of the constant-rate path. */
  simple: boolean;
  /** Mean hours between arrivals at the base rate. */
  meanGap: number;
}

/** x^n for a whole n by repeated squaring (plain multiplication, so identical in every JS engine). */
function powInt(x: number, n: number): number {
  let result = 1;
  for (let b = x, k = Math.abs(n); k > 0; k >>= 1, b *= b) if (k & 1) result *= b;
  return n < 0 ? 1 / result : result;
}

/** Throws on demand settings the engine can't run; see `EngineDemand`. */
export function checkDemand(demand: EngineDemand | undefined): void {
  if (!demand) return;
  const { seasonality, growthMonthly, startMonth } = demand;
  if (seasonality !== undefined) {
    if (seasonality.length !== MONTHS) throw new Error("Seasonality needs 12 monthly multipliers");
    if (!seasonality.every((m) => Number.isFinite(m) && m >= 0)) {
      throw new Error("Seasonality multipliers must be 0 or more");
    }
  }
  if (growthMonthly !== undefined && !(Number.isFinite(growthMonthly) && growthMonthly > -1)) {
    throw new Error("Monthly growth must be more than -100%");
  }
  if (startMonth !== undefined && !Number.isFinite(startMonth)) throw new Error("The start month must be a number");
}

/** True when the demand settings change nothing: every multiplier 1 and no growth. */
export function isFlatDemand(demand: EngineDemand | undefined): boolean {
  return !demand || ((demand.seasonality ?? []).every((m) => m === 1) && !demand.growthMonthly);
}

function calendar(model: EngineModel): Calendar | null {
  const { demand } = model;
  checkDemand(demand);
  const market = activeMarket(model);
  const leads = market && market.months.some((m) => m.leads !== 1) ? market.months.map((m) => m.leads) : null;
  const channels = activeChannels(model);
  const chMonths = channels?.leads ? planChannels(model, channels).leads : null;
  if (isFlatDemand(demand) && !leads && !chMonths) return null;
  const startMonth = demand?.startMonth ?? 0;
  let channel: Calendar["channel"] = null;
  if (chMonths) {
    const steps: { t: number; f: number }[] = [];
    for (let m = 1; m < chMonths.length; m++) if (chMonths[m] !== chMonths[m - 1]) steps.push({ t: channels!.starts[m - 1]!, f: chMonths[m]! });
    channel = { first: chMonths[0]!, steps, months: chMonths, starts: channels!.starts };
  }
  return {
    base: model.leadsPerWeek / model.hoursPerWeek,
    monthHours: WEEKS_PER_CALENDAR_MONTH * model.hoursPerWeek,
    startMonth,
    firstMonth: Math.floor(startMonth),
    seasonality: demand?.seasonality ?? new Array<number>(MONTHS).fill(1),
    growth: demand?.growthMonthly ?? 0,
    leads,
    channel,
    simple: isFlatDemand(demand) && !leads,
    meanGap: model.hoursPerWeek / model.leadsPerWeek,
  };
}

/**
 * Multiplier on the base rate in whole calendar month `j`, counted from
 * January of the year the run starts in (negative before it).
 */
function monthFactor(c: Calendar, j: number): number {
  const season = c.seasonality[((j % MONTHS) + MONTHS) % MONTHS]!;
  return season * (c.growth ? powInt(1 + c.growth, j - c.firstMonth) : 1);
}

/**
 * Multiplier on `leadsPerWeek` at simulation hour `t`: seasonality for the
 * calendar month `t` falls in, times growth since the start month. 1 when the
 * model has no demand settings.
 */
export function demandFactor(model: EngineModel, t: number): number {
  const c = calendar(model);
  if (!c) return 1;
  const market = c.leads ? c.leads[t < 0 ? 0 : Math.min(Math.floor(t / c.monthHours), c.leads.length - 1)]! : 1;
  const channel = c.channel ? c.channel.months[channelMonth(c.channel.starts, t)]! : 1;
  return monthFactor(c, Math.floor(c.startMonth + t / c.monthHours)) * market * channel;
}

/**
 * Arrival times in [-W, H), ascending. Those in [0, H) come from the
 * `arrivals` stream, forwards from 0; the warm-up's from `early`, backwards
 * from 0, so the measured window's arrivals are the same whatever the
 * warm-up length.
 */
export function arrivalTimes(model: EngineModel, H: number, W: number, arrivals: Rng, early: Rng): number[] {
  const c = calendar(model);
  const times: number[] = [];
  if (!c) {
    // Constant rate: exactly the draws and sums the engine has always made.
    const meanGap = model.hoursPerWeek / model.leadsPerWeek;
    if (W > 0) {
      for (let tb = -expo(early, meanGap); tb >= -W; tb -= expo(early, meanGap)) times.push(tb);
      times.reverse();
    }
    for (let ta = expo(arrivals, meanGap); ta < H; ta += expo(arrivals, meanGap)) times.push(ta);
    return times;
  }
  if (W > 0) {
    times.push(...walk(c, W, -1, early).map((t) => -t));
    times.reverse();
  }
  times.push(...walk(c, H, 1, arrivals));
  return times;
}

/**
 * Arrival distances from t = 0 going forwards (dir 1) or backwards (dir -1),
 * up to `limit` hours: each unit-rate exponential draw is spent against the
 * months' rates until it runs out, which places the next arrival.
 */
function walk(c: Calendar, limit: number, dir: 1 | -1, rng: Rng): number[] {
  const out: number[] = [];
  // Position along the calendar in months, and the whole month it is in.
  const pos = c.startMonth;
  let j = c.firstMonth;
  let t = 0;
  // The market month the walk is in (forwards only: before t = 0 it is month 1's), and its multiplier.
  const leads = c.leads;
  let mk = 0;
  const marketEdge = () => (dir > 0 && leads && mk < leads.length - 1 ? (mk + 1) * c.monthHours : Infinity);
  // The channel's multiplier in force and where it changes next (forwards only: before t = 0 it is month 0's).
  const chan = c.channel;
  const chSteps = dir > 0 && chan ? chan.steps : null;
  let ck = 0;
  let chF = chan ? chan.first : 1;
  const chEdge = () => (chSteps && ck < chSteps.length ? chSteps[ck]!.t : Infinity);
  // Distance from t = 0 to the edge of month j in the walking direction.
  const edge = (m: number) => dir * ((dir > 0 ? m + 1 : m) - pos) * c.monthHours;
  let need = expo(rng, 1);
  if (c.simple) {
    // Flat demand: only the channel changes the rate. Each draw is spent as `need × mean gap` (the constant-rate path's own
    // arithmetic), so with the channel at 1 the arrivals are bit for bit those of a model without it.
    while (t < limit) {
      const cE = chEdge();
      const end = Math.min(limit, cE);
      const next = t + need * (c.meanGap / chF);
      if (next < end) {
        t = next;
        out.push(t);
        need = expo(rng, 1);
      } else {
        need -= (end - t) * (chF / c.meanGap);
        t = end;
        if (end === cE) chF = chSteps![ck++]!.f;
      }
    }
    return out;
  }
  while (t < limit) {
    const rate = c.base * monthFactor(c, j) * (leads ? leads[mk]! : 1) * (chan ? chF : 1);
    const calEdge = edge(j);
    const mEdge = marketEdge();
    const cE = chEdge();
    const end = Math.min(limit, calEdge, mEdge, cE);
    const room = (end - t) * rate;
    if (rate > 0 && need < room) {
      t += need / rate;
      if (t >= limit) break;
      out.push(t);
      need = expo(rng, 1);
    } else {
      need -= room;
      t = end;
      if (end === calEdge) j += dir;
      if (end === mEdge) mk++;
      if (end === cE) chF = chSteps![ck++]!.f;
    }
  }
  return out;
}

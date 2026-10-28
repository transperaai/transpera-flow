// Baseline vs scenario (docs/PRD.md §4.1 compare view, §7.3 templated
// sentences, decision D15).
//
// Everything here is a pure function of two simulation results and the
// names passed in: no I/O, no clock, no randomness, and no language model.
// The headline is filled in from fixed sentence templates, so every number
// in it comes straight from the runs.

import type { SimulationResult, Stat } from "./model";
import { stat } from "./simulate";

/** A metric on both sides and the change between them. */
export interface Delta {
  baseline: Stat;
  scenario: Stat;
  /**
   * The change, scenario minus baseline. When both runs used the same seed and
   * replication count, replication i of each saw the same random streams, so
   * the range is taken over the paired differences (common random numbers).
   * Otherwise it is the widest band the two ranges allow.
   */
  delta: Stat;
  paired: boolean;
}

export interface Comparison {
  won: Delta;
  lost: Delta;
  mrrAdded: Delta;
  billed: Delta;
  labour: Delta;
  wipEnd: Delta;
  /** Mean cycle time per replication, in working hours. */
  cycle: Delta;
  bottleneck: { baseline: string | null; scenario: string | null };
  /** Utilisation by role and by person on each side; a side lacks the ones it doesn't have (a hire, someone removed). */
  roles: Record<string, { baseline?: Stat; scenario?: Stat }>;
  people: Record<string, { baseline?: Stat; scenario?: Stat }>;
}

function delta(a: number[], b: number[], paired: boolean): Delta {
  const baseline = stat(a);
  const scenario = stat(b);
  const d = paired
    ? stat(b.map((v, i) => v - a[i]!))
    : { mean: scenario.mean - baseline.mean, p10: scenario.p10 - baseline.p90, p90: scenario.p90 - baseline.p10 };
  return { baseline, scenario, delta: d, paired };
}

export function compareRuns(baseline: SimulationResult, scenario: SimulationResult): Comparison {
  const paired = baseline.seed === scenario.seed && baseline.reps === scenario.reps;
  const a = baseline.samples;
  const b = scenario.samples;
  const sides = <T>(x: Record<string, T>, y: Record<string, T>) => {
    const out: Record<string, { baseline?: T; scenario?: T }> = {};
    for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) {
      out[id] = { ...(id in x ? { baseline: x[id] } : {}), ...(id in y ? { scenario: y[id] } : {}) };
    }
    return out;
  };
  const util = (r: Record<string, { util: Stat }>) => Object.fromEntries(Object.entries(r).map(([id, v]) => [id, v.util]));
  return {
    won: delta(a.won, b.won, paired),
    lost: delta(a.lost, b.lost, paired),
    mrrAdded: delta(a.mrrAdded, b.mrrAdded, paired),
    billed: delta(a.billed, b.billed, paired),
    labour: delta(a.labour, b.labour, paired),
    wipEnd: delta(a.wipEnd, b.wipEnd, paired),
    cycle: delta(a.cycleMean, b.cycleMean, paired),
    bottleneck: { baseline: baseline.bnRole, scenario: scenario.bnRole },
    roles: sides(util(baseline.kpi.roles), util(scenario.kpi.roles)),
    people: sides(util(baseline.kpi.people), util(scenario.kpi.people)),
  };
}

// ---------------------------------------------------------------------------
// Templated headline
// ---------------------------------------------------------------------------

export interface HeadlineInput {
  comparison: Comparison;
  /** What changed, as the sentence's subject: `“Automate proposals”`, `These lever changes`. */
  subject: string;
  /** Whether `subject` takes a plural verb ("add" rather than "adds"). */
  plural?: boolean;
  horizonWeeks: number;
  hoursPerWeek: number;
  /** ISO 4217 code for money; omit to leave money out. */
  currency?: string;
  /** Role names by id, for the bottleneck sentence. */
  roleNames: Record<string, string>;
}

export interface Headline {
  /** One sentence on wins per quarter, with the average and 10th–90th percentile range. */
  headline: string;
  /** Further sentences: new MRR, cycle time, bottleneck. */
  details: string[];
}

const WEEKS_PER_QUARTER = 13;
const LOCALE = "en-GB";
const MINUS = "−";
const DASH = "–";

function num(v: number, digits = 1): string {
  const s = Math.abs(v).toLocaleString(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return v < 0 && s !== "0" ? `${MINUS}${s}` : s;
}

function money(v: number, currency: string): string {
  const compact = Math.abs(v) >= 10_000;
  const s = Math.abs(v).toLocaleString(LOCALE, {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 0,
  });
  return v < 0 ? `${MINUS}${s}` : s;
}

/** "1.4–2.9", or "−0.5 to 1.1" when the ends have different signs (a dash would read as a minus). */
function range(low: string, high: string, straddles: boolean): string {
  return low === high ? low : straddles ? `${low} to ${high}` : `${low}${DASH}${high}`;
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

/** Differences smaller than this, on every figure of a stat, count as no change. */
const NOISE = { wins: 0.05, money: 0.5, days: 0.05 };

type Direction = "up" | "down" | "none" | "unclear";

function direction(d: Stat, noise: number): Direction {
  if (Math.abs(d.mean) < noise && Math.abs(d.p10) < noise && Math.abs(d.p90) < noise) return "none";
  if (d.p10 > 0 || (d.p10 >= 0 && d.mean > 0)) return "up";
  if (d.p90 < 0 || (d.p90 <= 0 && d.mean < 0)) return "down";
  return "unclear";
}

/**
 * The compare headline, from templates only. For example:
 * “Automate proposals” adds avg 2.1 wins/quarter (range 1.4–2.9).
 */
export function compareHeadline(input: HeadlineInput): Headline {
  const { comparison: c, subject, plural = false, horizonWeeks, hoursPerWeek, currency, roleNames } = input;
  const verb = (singular: string, pluralForm: string) => (plural ? pluralForm : singular);
  const perQuarter = WEEKS_PER_QUARTER / horizonWeeks;
  const scale = (s: Stat, k: number): Stat => ({ mean: s.mean * k, p10: s.p10 * k, p90: s.p90 * k });

  // Wins per quarter.
  const w = scale(c.won.delta, perQuarter);
  const wDir = direction(w, NOISE.wins);
  let headline: string;
  if (wDir === "none") {
    headline = `${subject} ${verb("makes", "make")} no difference to wins per quarter.`;
  } else if (wDir === "up") {
    headline = `${subject} ${verb("adds", "add")} avg ${num(w.mean)} wins/quarter (range ${range(num(w.p10), num(w.p90), false)}).`;
  } else if (wDir === "down") {
    headline = `${subject} ${verb("costs", "cost")} avg ${num(-w.mean)} wins/quarter (range ${range(num(-w.p90), num(-w.p10), false)}).`;
  } else {
    const change = w.mean >= 0 ? `${verb("adds", "add")} avg ${num(w.mean)}` : `${verb("costs", "cost")} avg ${num(-w.mean)}`;
    headline = `${subject} ${change} wins/quarter, but the range includes no change (${range(num(w.p10), num(w.p90), true)}).`;
  }

  const details: string[] = [];

  // New MRR per quarter.
  if (currency) {
    const mrr = scale(c.mrrAdded.delta, perQuarter);
    const dir = direction(mrr, NOISE.money);
    const band = (lo: number, hi: number, straddles: boolean) => range(money(lo, currency), money(hi, currency), straddles);
    if (dir === "up") details.push(`New MRR rises by avg ${money(mrr.mean, currency)} a quarter (range ${band(mrr.p10, mrr.p90, false)}).`);
    else if (dir === "down")
      details.push(`New MRR falls by avg ${money(-mrr.mean, currency)} a quarter (range ${band(-mrr.p90, -mrr.p10, false)}).`);
    else if (dir === "unclear")
      details.push(`New MRR changes by avg ${money(mrr.mean, currency)} a quarter (range ${band(mrr.p10, mrr.p90, true)}).`);
  }

  // Cycle time, in working days.
  const days = scale(c.cycle.delta, 5 / hoursPerWeek);
  const dDir = direction(days, NOISE.days);
  if (dDir === "down") details.push(`Cycle time falls by avg ${num(-days.mean)} days (range ${range(num(-days.p90), num(-days.p10), false)}).`);
  else if (dDir === "up") details.push(`Cycle time rises by avg ${num(days.mean)} days (range ${range(num(days.p10), num(days.p90), false)}).`);
  else if (dDir === "unclear")
    details.push(`Cycle time changes by avg ${num(days.mean)} days (range ${range(num(days.p10), num(days.p90), true)}).`);

  // Bottleneck.
  const { baseline: bA, scenario: bB } = c.bottleneck;
  const name = (id: string) => roleNames[id] ?? "a role";
  const utilOf = (id: string, side: "baseline" | "scenario") => c.roles[id]?.[side]?.mean;
  if (bA && bB && bA !== bB) {
    const ua = utilOf(bA, "baseline");
    const ub = utilOf(bB, "scenario");
    details.push(
      `The bottleneck moves from ${name(bA)}${ua !== undefined ? ` (${pct(ua)})` : ""} to ${name(bB)}${ub !== undefined ? ` (${pct(ub)})` : ""}.`,
    );
  } else if (bA && bB) {
    const ua = utilOf(bA, "baseline");
    const ub = utilOf(bB, "scenario");
    if (ua !== undefined && ub !== undefined && pct(ua) !== pct(ub)) {
      details.push(`${name(bB)} stays the bottleneck at ${pct(ub)} utilised (was ${pct(ua)}).`);
    }
  }

  return { headline, details };
}

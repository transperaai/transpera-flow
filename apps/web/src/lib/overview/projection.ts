// Recurring revenue projected from simulation runs (issue #100, A35; now the Solution page's MRR chart).
// The engine reports a run's totals at its horizon, not month by month, so the monthly recurring revenue chart is
// built from runs of increasing length (same seed, so they line up): "MRR after 3 months" comes from a 3-month run.
// Pure: no React, no workers.

import { withClientGroups, type EngineModel, type SimulationResult } from "@transpera-flow/engine";

/** Weeks in a month, as the engine counts them (52 a year). */
const WEEKS_PER_MONTH = 52 / 12;

/** An average with its 10-90% range. */
export interface Band {
  mean: number;
  lo: number;
  hi: number;
}

/** Recurring revenue after `month` months (a fraction for the first weeks of a short horizon). */
export interface MrrPoint extends Band {
  month: number;
}

/**
 * The months at which a horizon of `months` is sampled for the MRR chart, 0 (now) excluded, the horizon itself last.
 * Short horizons are read week by week or month by month, long ones every few months, so every horizon costs a
 * handful of runs, never one per week.
 */
export function checkpointMonths(months: number): number[] {
  if (months <= 1) return [0.25, 0.5, 0.75, 1].map((f) => f * months);
  if (months <= 6) return Array.from({ length: months }, (_, i) => i + 1);
  const step = months / 6;
  return Array.from({ length: 6 }, (_, i) => (i + 1) * step);
}

/** The run lengths, in weeks, for a list of months. */
export const checkpointWeeks = (months: readonly number[]): number[] => months.map((m) => Math.max(1, Math.round(m * WEEKS_PER_MONTH)));

/** The `p`th percentile (0 to 1) of a list, interpolating between neighbours; 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

const mean = (values: readonly number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/** What the business bills a month today, and how many clients it has. */
export interface StartingMrr {
  /** Monthly recurring revenue at the start of the run. */
  mrr: number;
  clients: number;
}

/**
 * Today's recurring revenue: every client's monthly fee (named clients, or the client groups' counts times their fees).
 * With neither, the interim client count at the average retainer.
 */
export function startingMrr(model: EngineModel): StartingMrr {
  const expanded = withClientGroups(model);
  if (expanded.clients) {
    const all = Object.values(expanded.clients);
    return { mrr: all.reduce((sum, c) => sum + (Number(c.mrr) || 0), 0), clients: all.length };
  }
  const retainers = Object.values(model.services ?? {}).filter((s) => s.pricingModel === "retainer");
  const share = retainers.reduce((sum, s) => sum + s.mixShare, 0);
  const price = retainers.length
    ? share > 0
      ? retainers.reduce((sum, s) => sum + s.price * s.mixShare, 0) / share
      : retainers.reduce((sum, s) => sum + s.price, 0) / retainers.length
    : model.retainer;
  return { mrr: model.activeClients * price, clients: model.activeClients };
}

/** The part of a run the MRR chart needs, small enough to send between a worker and the page. */
export interface RunSummary {
  /** The run's length in weeks. */
  weeks: number;
  /** New recurring revenue in each replication. */
  mrrAdded: number[];
  /** Clients lost on average (client records only). */
  clientsChurned: number;
}

export function summarise(model: EngineModel, result: SimulationResult): RunSummary {
  return { weeks: Math.round(result.H / model.hoursPerWeek), mrrAdded: [...result.samples.mrrAdded], clientsChurned: result.kpi.clientsChurned?.mean ?? 0 };
}

/**
 * Recurring revenue at the end of a run: what is billed today, plus what the clients won add, less what the clients
 * who leave took with them (an average client's fee each). The range comes from the runs' own new revenue, so it is
 * the spread across the 30 runs, shifted by the average loss.
 */
export function mrrAfter(model: EngineModel, run: RunSummary, start: StartingMrr = startingMrr(model)): Band {
  let lost: number;
  if (withClientGroups(model).clients) {
    const fee = start.clients ? start.mrr / start.clients : 0;
    lost = run.clientsChurned * fee;
  } else {
    // Without client records, the interim count decays at the monthly churn rate.
    const months = run.weeks / WEEKS_PER_MONTH;
    lost = start.mrr * (1 - Math.pow(1 - Math.min(1, Math.max(0, model.churnMonthly)), months));
  }
  const base = start.mrr - lost;
  return { mean: base + mean(run.mrrAdded), lo: base + percentile(run.mrrAdded, 0.1), hi: base + percentile(run.mrrAdded, 0.9) };
}

/** The MRR chart's points: today, the sampled months, and the horizon. `runs` pair up with `months` (the last is the horizon's own run). */
export function mrrSeries(model: EngineModel, months: readonly number[], runs: readonly RunSummary[]): MrrPoint[] {
  const start = startingMrr(model);
  const points: MrrPoint[] = [{ month: 0, mean: start.mrr, lo: start.mrr, hi: start.mrr }];
  months.forEach((m, i) => {
    const run = runs[i];
    if (run) points.push({ month: m, ...mrrAfter(model, run, start) });
  });
  return points;
}

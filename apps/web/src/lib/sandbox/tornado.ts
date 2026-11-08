// "What matters most" (docs/plans/sandbox-p5-brief.md section 10): around the scenario on screen, each lever moved a little each way, one at a
// time, ranked by how much it moves one measure. This file picks the levers and the two changes for each (`tornadoVariants`) and ranks the
// answers (`rankTornado`); it runs nothing. Pure: no React.
//
// Only levers the workspace offers (Settings, Levers) that do something in this model, one representative target each, and a step small enough
// to be "a little": 10% for the relative levers, one person for headcount (a count moves by one, not by 10%). Money levers (a role's cost,
// overheads) move nothing but profit, so they are only asked for when the measure is profit. Left out: a starting stock of clients (a named
// roster can't shrink), lead-source and fee ranges, traffic mix, churn chances, hires, leave and people by name, a solution going live (ranges,
// people and structure have no "10%").

import { offeredLevers, sandboxLever, type SandboxChange } from "@transpera-flow/db";
import { busiestRole, heaviestStep, type EngineModel } from "@transpera-flow/engine";
import type { TornadoMeasureId } from "./measures";

export interface TornadoVariant {
  leverId: string;
  /** "Opportunities coming in", "Headcount: Designers". */
  label: string;
  low: SandboxChange;
  high: SandboxChange;
  /** "−10%", "−1 person". */
  lowLabel: string;
  highLabel: string;
  /**
   * A price rise switches the price driver on for the whole scenario, so its bar is measured against the scenario with that driver on and no
   * price change (one more run, as the price-rise trade-off pairs two runs). Null for every other lever: its bars start from the scenario.
   */
  base: SandboxChange | null;
}

/** The levers the tornado moves, in the order they are tried. */
export const TORNADO_LEVERS = ["A1", "A3", "B3", "D6", "B5", "B2", "E1", "E2", "E3", "D5", "C1", "C2"] as const;
const MONEY_LEVERS = new Set(["C1", "C2"]);

/** A change id that is a uuid and stable for one variant list (ids only need to be unique inside the list the run is made from). */
const idFor = (n: number) => `5e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function tornadoVariants(model: EngineModel, hiddenKinds: readonly string[], measure: TornadoMeasureId): TornadoVariant[] {
  const offered = new Set(offeredLevers(hiddenKinds).map((l) => l.id));
  const out: TornadoVariant[] = [];
  let n = 0;
  const ch = (lever: SandboxChange["lever"], op: SandboxChange["op"], value: number, target: string | null = null): SandboxChange => ({ id: idFor(++n), lever, target, op, value });
  for (const id of TORNADO_LEVERS) {
    const lever = sandboxLever(id);
    if (!lever || !offered.has(id) || lever.applies?.(model)) continue;
    if (MONEY_LEVERS.has(id) && measure !== "profit") continue;
    // Overheads of nothing are nothing: ×0.9 and ×1.1 move no number.
    if (id === "C2" && !((model.overheadMonthly ?? 0) > 0)) continue;
    const rel = (target: string | null = null): Pick<TornadoVariant, "low" | "high" | "lowLabel" | "highLabel" | "base"> => ({
      low: ch(id, "multiply", 0.9, target),
      high: ch(id, "multiply", 1.1, target),
      lowLabel: "−10%",
      highLabel: "+10%",
      base: null,
    });
    switch (id) {
      case "B5":
        out.push({ leverId: id, label: "Price", low: ch(id, "set", -0.1), high: ch(id, "set", 0.1), lowLabel: "−10%", highLabel: "+10%", base: ch(id, "set", 0) });
        break;
      case "E1":
      case "E2":
      case "E3": {
        const sid = heaviestStep(model);
        const step = sid ? model.steps.find((s) => s.id === sid) : undefined;
        if (!step) break;
        // A step with no rework has nothing to scale, and no wait to scale for E2.
        if (id === "E3" && !(step.rework > 0)) break;
        if (id === "E2" && !(step.wait > 0)) break;
        out.push({ leverId: id, label: `${lever.label}: ${step.name}`, ...rel("@heaviest") });
        break;
      }
      case "D5": {
        const rid = busiestRole(model);
        if (!rid) break;
        out.push({ leverId: id, label: `Headcount: ${model.roles[rid]?.name ?? "the busiest role"}`, low: ch(id, "add", -1, "@busiest"), high: ch(id, "add", 1, "@busiest"), lowLabel: "−1 person", highLabel: "+1 person", base: null });
        break;
      }
      case "C1": {
        const rid = busiestRole(model);
        if (!rid) break;
        out.push({ leverId: id, label: `${lever.label}: ${model.roles[rid]?.name ?? "the busiest role"}`, ...rel("@busiest") });
        break;
      }
      default:
        out.push({ leverId: id, label: lever.label, ...rel() });
    }
  }
  return out;
}

/** What a variant was measured at: the lever's low and high step, and the value of the scenario it is measured from (its own base for a price rise). */
export interface TornadoResult {
  leverId: string;
  low: number | null;
  high: number | null;
  /** The measure at this lever's own baseline when it has one (a price rise); else the scenario's. */
  base?: number | null;
}

export interface TornadoBar {
  leverId: string;
  label: string;
  lowLabel: string;
  highLabel: string;
  low: number | null;
  high: number | null;
  /** Each side's change from the bar's baseline (null: no number). */
  lowDelta: number | null;
  highDelta: number | null;
  /** The longer of the two sides, always >= 0. */
  size: number;
  /** Under 1% of the scenario's value: "about no change". */
  negligible: boolean;
}

/** The share of the scenario's value below which a move is "about no change" (the help explains it). */
export const NEGLIGIBLE = 0.01;
/** The most bars drawn. */
export const MAX_BARS = 10;

/** Bars sorted by their longer side, longest first, at most `limit`. Bars with no number at all are left out. */
export function rankTornado(base: number, variants: readonly TornadoVariant[], results: readonly TornadoResult[], limit = MAX_BARS): TornadoBar[] {
  const bars: TornadoBar[] = [];
  const floor = Math.max(Math.abs(base) * NEGLIGIBLE, 1e-9);
  for (const v of variants) {
    const r = results.find((x) => x.leverId === v.leverId);
    if (!r || (r.low === null && r.high === null)) continue;
    const from = v.base ? (r.base ?? null) : base;
    if (from === null) continue;
    const lowDelta = r.low === null ? null : r.low - from;
    const highDelta = r.high === null ? null : r.high - from;
    const size = Math.max(Math.abs(lowDelta ?? 0), Math.abs(highDelta ?? 0));
    bars.push({ leverId: v.leverId, label: v.label, lowLabel: v.lowLabel, highLabel: v.highLabel, low: r.low, high: r.high, lowDelta, highDelta, size, negligible: size < floor });
  }
  return bars.sort((a, b) => b.size - a.size || (a.leverId < b.leverId ? -1 : 1)).slice(0, limit);
}

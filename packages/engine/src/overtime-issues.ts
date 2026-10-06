// Detected overtime (docs/PRD.md §4.1 "overtime above zero", §6.3.4, decision
// D7; issue #18). With an overtime cap above 0, people whose ongoing client
// load exceeds their capacity work overtime to keep up. Hidden overtime is a
// finding in itself, so each person who works any is listed (roles, when the
// model has no named people). Load beyond even the cap is the capacity
// detector's critical "client work alone exceeds capacity" (issues.ts).
//
// The evidence states hours only; the money is in `cost`, which is never stored
// (B1 2b: saved issues must not let a member work out a rate).

import type { DetectedIssue } from "./issues";
import type { EngineModel, SimulationResult } from "./model";
import { DEFAULT_COST_CONFIG, WEEKS_PER_MONTH, formatMoney, payHiddenCost, type CostConfig } from "./cost";
import { escalationNote, ratingFields, rateRule, resolveRatingConfig, resolveRule, type RatingConfig, type RatingConfigInput } from "./ratings";

const LOCALE = "en-GB";
const num = (v: number, digits = 1) => v.toLocaleString(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const pct = (share: number) => `${Math.round(share * 100)}%`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Overtime issues for a run of `model`, by key (rule 3). Rated on the share of
 * the overtime cap used: any regular overtime is Bad, the cap used up is
 * Operational risk (docs/analysis-rules.md).
 */
export function overtimeIssues(
  model: EngineModel,
  result: SimulationResult,
  ratingConfig: RatingConfigInput | RatingConfig = {},
  money: CostConfig = DEFAULT_COST_CONFIG,
): DetectedIssue[] {
  const config = resolveRatingConfig(ratingConfig);
  const cap = Math.max(0, model.overtimeCap ?? 0);
  if (!(cap > 0)) return [];
  const people = result.resolvedPeople;
  const named = Boolean(model.people && Object.keys(model.people).length);
  const roleName = (id: string) => model.roles[id]?.name ?? "a role";
  const out: DetectedIssue[] = [];

  const push = (subject: { key: string; name: string; capacity: number; roleId: string | null; personId: string | null; rate: number | null }, r: {
    overtimeHours: number;
    overtime: number;
    ongoingHours: number;
    util: number;
  }, band: { p10: number; p90: number } | undefined, onBottleneck: boolean) => {
    const resolved = resolveRule(config, "overtime", { roleId: subject.roleId, personId: subject.personId });
    if (!resolved.enabled) return;
    const outcome = rateRule(config, "overtime", resolved, { average: r.overtime / cap, p90: band ? band.p90 / cap : null, onBottleneck });
    if (outcome.rating === "great") return;
    const atCap = r.overtime / cap >= resolved.cutoffs[2];
    out.push({
      key: subject.key,
      type: "capacity",
      ...ratingFields(outcome),
      // A null rate is a person's pay, hidden from this caller (`model.payHidden`).
      cost: subject.rate === null
        ? payHiddenCost()
        : {
            perMonth: r.overtimeHours * subject.rate * WEEKS_PER_MONTH,
            hoursPerMonth: r.overtimeHours * WEEKS_PER_MONTH,
            method: `Overtime hours × cost rate: ${num(r.overtimeHours * WEEKS_PER_MONTH)} h a month at ${formatMoney(subject.rate, money.currency)} an hour.`,
          },
      title: `${subject.name} works ${num(r.overtimeHours)} h/wk overtime`,
      evidence:
        `Simulated: ${num(r.ongoingHours)} h/wk of client work against ${num(subject.capacity)} h/wk capacity, so ` +
        `${num(r.overtimeHours)} h/wk overtime on average${band ? ` (range ${num(band.p10 * subject.capacity)}–${num(band.p90 * subject.capacity)})` : ""}` +
        ` within the ${pct(cap)} cap.` +
        (atCap ? " The cap is used up: more client work pushes utilisation past 100%." : "") +
      ` ${escalationNote(outcome)}`.trimEnd(),
      metrics: {
        overtime_hours_week: r.overtimeHours,
        ...(band ? { overtime_hours_week_p10: band.p10 * subject.capacity, overtime_hours_week_p90: band.p90 * subject.capacity } : {}),
        ongoing_hours_week: r.ongoingHours,
        capacity_hours_week: subject.capacity,
        overtime_cap: cap,
        utilisation: r.util,
      },
      stepId: null,
      roleId: subject.roleId,
      personId: subject.personId,
      fix: subject.roleId
        ? { name: `Hire another ${roleName(subject.roleId)}`, patch: [{ path: `roles.${subject.roleId}.headcount`, op: "add", value: 1 }] }
        : null,
    });
  };

  if (named) {
    for (const pid of Object.keys(people).sort(cmp)) {
      const p = people[pid]!;
      const r = result.people[pid];
      if (!r) continue;
      const own = p.roles.filter((rid) => rid in model.roles);
      const rate = model.payHidden ? null : p.cost ?? (own.length ? own.reduce((s, rid) => s + model.roles[rid]!.cost, 0) / own.length : 0);
      push({ key: `overtime:person:${pid}`, name: p.name, capacity: p.capacity, roleId: p.roles[0] ?? null, personId: pid, rate }, r, result.kpi.people[pid]?.overtime, pid === result.bnPerson);
    }
  } else {
    for (const rid of Object.keys(model.roles).sort(cmp)) {
      const r = result.roles[rid];
      if (!r) continue;
      const capacity = Object.values(people).reduce((s, p) => s + (p.roles.includes(rid) ? p.capacity / p.roles.length : 0), 0);
      push({ key: `overtime:role:${rid}`, name: roleName(rid), capacity, roleId: rid, personId: null, rate: model.roles[rid]!.cost }, r, result.kpi.roles[rid]?.overtime, rid === result.bnRole);
    }
  }
  return out;
}

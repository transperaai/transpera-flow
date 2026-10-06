// Detected issues (docs/PRD.md §4.1 "Issues register", §6.4; issue #17).
//
// After every run the engine lists what looks wrong with the model: a role or
// person that is too busy, a queue that keeps growing, work waiting too long
// for someone to pick it up, a step only one person can do, rework, and missed
// deadlines. Each finding is rated Great, Good, Bad or Operational risk by the
// rating model (ratings.ts, docs/analysis-rules.md); Great ones aren't listed.
// Each finding has a stable
// `key` ("capacity:role:<role id>", "spof:step:<step id>"), built from what
// it is about and never from the numbers, so the same model gives the same
// keys run after run and a promoted issue can be matched to its detection.
//
// Everything here is a pure function of the model and one simulation result:
// no I/O, no clock, no randomness and no language model. Titles and evidence
// are filled in from fixed templates, so every number in them comes straight
// from the run. Where a what-if would test the obvious fix, the issue carries
// it as scenario patches (`fix`), which the app can run and compare.

import { eligible, type AbsenceTest } from "./absence";
import type { EngineModel, EngineStep, SimulationResult } from "./model";
import { pct as percentile } from "./simulate";
import { checkSuccessMeasures, NO_SUCCESS_MEASURES, type SuccessMeasureSource } from "./success";
import { churnCauseIssues, churnRiskIssues } from "./churn-issues";
import { clientChurnMonthly, withClientGroups } from "./clients";
import {
  WEEKS_PER_MONTH,
  averageDealValue,
  clientLossValue,
  formatMoney,
  compareCostsDesc,
  lossValueAtStep,
  noCost,
  payHiddenCost,
  serviceMix,
  resolveCostConfig,
  type CostConfig,
  type CostConfigInput,
  type IssueCost,
} from "./cost";
import { overtimeIssues } from "./overtime-issues";
import {
  compareRatingsDesc,
  escalationNote,
  ratingFields,
  rateRule,
  rateValue,
  worseRating,
  resolveRatingConfig,
  resolveRule,
  type Rating,
  type RatingConfig,
  type RatingConfigInput,
  type RatingEscalation,
  type RatingRuleId,
  type RatingSubject,
} from "./ratings";
import { offeredLoad, type ScenarioPatch } from "./scenario";
import { servicingLinks, servicingStepIds } from "./servicing";
import { WEEKS_PER_QUARTER } from "./shadow-price";

/** Issue types (docs/PRD.md §5 `issues.type`). Detectors use a subset; the rest are logged by hand. */
export const ISSUE_TYPES = [
  "bottleneck",
  "spof",
  "manual",
  "delay",
  "failure",
  "idea",
  "capacity",
  "sla",
  "churn_risk",
  "perception_gap",
  "broken_scenario",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/** A what-if that tests the obvious fix: patches in the scenario grammar (scenario.ts). */
export interface SuggestedFix {
  name: string;
  patch: ScenarioPatch[];
}

export interface DetectedIssue {
  /** Stable across runs of an unchanged model: `<detector>:<subject kind>:<id>`. */
  key: string;
  type: IssueType;
  /** Never Great: a Great finding isn't an issue. */
  rating: Rating;
  /** How the rating was reached: the average's band, and what raised it. */
  escalation: RatingEscalation;
  /** What it costs a month, as an estimate, and how that was worked out (cost.ts). */
  cost: IssueCost;
  title: string;
  /** One or two templated sentences with the numbers behind the finding. */
  evidence: string;
  /** The numbers behind the finding, for the register's metric snapshot. */
  metrics: Record<string, number>;
  /** Step it shows on; for a role or person, the step where they carry the most work. */
  stepId: string | null;
  roleId: string | null;
  personId: string | null;
  fix: SuggestedFix | null;
  /** The saved scenario it is about (`broken_scenario` issues, see broken.ts). */
  scenarioId?: string | null;
  /** The client it is about (`churn_risk` issues, see churn-issues.ts). */
  clientId?: string | null;
}

/** The detectors, in the order their issues are listed within a rating. */
export const DETECTORS = ["capacity", "overtime", "queue", "wait", "spof", "rework", "sla", "dropoff", "cycle", "success", "spare", "churn"] as const;
export type Detector = (typeof DETECTORS)[number];

const LOCALE = "en-GB";
const num = (v: number, digits = 1) => v.toLocaleString(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const pct = (share: number) => `${Math.round(share * 100)}%`;
const days = (hours: number, hoursPerDay: number) => {
  const d = num(hours / hoursPerDay);
  return `${d} working day${d === "1" ? "" : "s"}`;
};

export interface DetectOptions {
  /** The process the model is, for overrides set on a process. Servicing steps use their servicing process's id. */
  processId?: string | null;
  /** The money settings: the cap on what a loss is worth, and absences a year. Any part left out takes the defaults. */
  cost?: CostConfigInput | CostConfig;
  /**
   * Extra wins a quarter that one more person in each role would bring, by role id
   * (the shadow price, shadow-price.ts), for the "too busy" cost. A role with none
   * is costed on its overtime alone. Running it is an extra simulation, so it is
   * the caller's to run (`shadowPricesFor`).
   */
  shadowPrices?: Record<string, number>;
  /**
   * The absence test's result for this model (absence.ts), run as its own
   * pass after the baseline. Without it, rule 8 ("only one person can do it")
   * raises nothing.
   */
  absence?: AbsenceTest | null;
  /**
   * The process's success measures (rule 11, "goals met"). Defaults to none
   * until A54 stores first principles, so nothing is rated.
   */
  successMeasures?: SuccessMeasureSource;
}

/**
 * The issues a run points at, most severe first, then costliest first (then in
 * `DETECTORS` order, then by key). `result` must come from simulating `model`. `ratingConfig` is
 * the workspace's analysis rules (ratings.ts): any part left out takes the
 * agreed defaults. Pure, so a stored run can be re-rated with a new config
 * without simulating again.
 */
export function detectIssues(
  model: EngineModel,
  result: SimulationResult,
  ratingConfig: RatingConfigInput | RatingConfig = {},
  options: DetectOptions = {},
): DetectedIssue[] {
  const config = resolveRatingConfig(ratingConfig);
  const money = resolveCostConfig(options.cost);
  const shadow = options.shadowPrices ?? {};
  const fmt = (v: number) => formatMoney(v, money.currency);
  const hoursPerDay = model.hoursPerWeek / 5;
  const people = result.resolvedPeople;
  const named = Boolean(model.people && Object.keys(model.people).length);
  const load = offeredLoad(model);
  const staffed = model.steps.filter((s) => s.role || s.person);
  const roleName = (id: string) => model.roles[id]?.name ?? "a role";
  const out: (DetectedIssue & { detector: Detector })[] = [];

  // Which process and services a step belongs to, for overrides.
  const servicing = servicingStepIds(model);
  const stepContext = (stepId: string): Pick<RatingSubject, "processId" | "serviceIds"> => {
    const procs = Object.entries(model.servicingProcesses ?? {}).filter(([, p]) => p.steps.includes(stepId));
    if (!procs.length) return { processId: options.processId ?? null, serviceIds: [] };
    const serviceIds = Object.entries(model.services ?? {})
      .filter(([, sv]) => servicingLinks(model, sv).some((l) => procs.some(([pid]) => pid === l.process)))
      .map(([id]) => id)
      .sort();
    return { processId: procs[0]![0], serviceIds };
  };

  /** The step in `steps` that asks for the most hands-on hours (first by id on a tie). */
  const heaviest = (steps: EngineStep[]): string | null => {
    let best: string | null = null;
    for (const s of [...steps].sort((a, b) => cmp(a.id, b.id))) {
      if (best === null || load.stepHours[s.id]! > load.stepHours[best]!) best = s.id;
    }
    return best;
  };
  const hire = (roleId: string): SuggestedFix => ({
    name: `Hire another ${roleName(roleId)}`,
    patch: [{ path: `roles.${roleId}.headcount`, op: "add", value: 1 }],
  });
  /** The role that works a step: its own, or its pinned person's first. */
  const roleOf = (s: EngineStep) => s.role ?? (s.person ? (people[s.person]?.roles[0] ?? null) : null);
  const rate = (rule: RatingRuleId, subject: RatingSubject, average: number, p90: number | null | undefined, onBottleneck: boolean) => {
    const resolved = resolveRule(config, rule, subject);
    return { resolved, outcome: resolved.enabled ? rateRule(config, rule, resolved, { average, p90, onBottleneck }) : null };
  };

  // Cost helpers (cost.ts). A month is 52 / 12 weeks; a quarter 13.
  const dealValue = averageDealValue(model, money.capMonths);
  // Overtime has its own insights (rule 3); where one exists for the same person or role, the busy cost leaves overtime out so it isn't counted twice.
  const overtimeFound = overtimeIssues(model, result, config, money);
  const overtimeCovered = (roleId: string | null, personId: string | null) =>
    overtimeFound.some((o) => (personId ? o.personId === personId : o.roleId === roleId));
  /** Rule 1: the wins one more person would bring × deal value, plus overtime unless it has its own insight. */
  const busyCost = (roleId: string | null, overtimeHoursWeek: number, rate: number | null, ownOvertime: boolean): IssueCost => {
    // A null rate is a person's pay, hidden from this caller: the cost needs it only when overtime is added here.
    if (rate === null && !ownOvertime && overtimeHoursWeek > 0) return payHiddenCost();
    const overtime = ownOvertime ? 0 : overtimeHoursWeek * (rate ?? 0) * WEEKS_PER_MONTH;
    const note = ownOvertime && overtimeHoursWeek > 0 ? " Overtime is costed in its own insight, so it isn't counted here." : "";
    const extraWins = roleId !== null && roleId in shadow ? (Math.max(0, shadow[roleId]!) * WEEKS_PER_MONTH) / WEEKS_PER_QUARTER : null;
    if (extraWins === null) {
      return overtime > 0
        ? { perMonth: overtime, hoursPerMonth: null, method: "Overtime at cost rates. The work lost needs the what-if of one more person, which hasn't run." }
        : noCost(`Needs the what-if of one more person, which hasn't run.${note}`);
    }
    if (!(extraWins > 0)) {
      // More capacity there wouldn't add wins: say so rather than "About A$0 … 0 more wins".
      return overtime > 0
        ? { perMonth: overtime, hoursPerMonth: null, method: `More capacity here wouldn't add wins, so the cost is the ${fmt(overtime)} a month of overtime at cost rates.` }
        : noCost(`More capacity here wouldn't add wins, so there's no work lost to cost.${note}`);
    }
    const lost = extraWins * dealValue;
    return {
      perMonth: lost + overtime,
      hoursPerMonth: null,
      method:
        `Work lost: one more person would bring about ${num(extraWins)} more win${extraWins === 1 ? "" : "s"} a month, each worth ${fmt(dealValue)} (deal value, capped at ${num(money.capMonths, 0)} months)` +
        (overtime > 0 ? `, plus ${fmt(overtime)} of overtime at cost rates.` : `.${note}`),
    };
  };
  const roleCost = (roleId: string | null) => (roleId ? (model.roles[roleId]?.cost ?? 0) : 0);
  const stepLosses = new Map<string, number>();
  /** What losing one item at a step is worth: deal value × the chance it would still have signed (cost.ts). */
  const stepLoss = (s: EngineStep) => {
    if (!stepLosses.has(s.id)) stepLosses.set(s.id, lossValueAtStep(model, s, money.capMonths));
    return stepLosses.get(s.id)!;
  };
  /** Rule 5: items lost through the step's "lost per day of waiting" × what a loss is worth; time only when none is set. */
  const waitCost = (s: EngineStep, st: SimulationResult["steps"][string]): IssueCost => {
    const itemsMonth = (st.arrivals / model.horizonWeeks) * WEEKS_PER_MONTH;
    if (!(s.lostPerDayWaiting !== undefined && s.lostPerDayWaiting > 0)) {
      return {
        perMonth: null,
        hoursPerMonth: itemsMonth * st.avgWait,
        method: "Time, not money: set this step's lost per day of waiting to put a cost on it.",
      };
    }
    const lostShare = Math.min(1, s.lostPerDayWaiting * (st.avgWait / hoursPerDay));
    const value = stepLoss(s);
    return {
      perMonth: itemsMonth * lostShare * value,
      hoursPerMonth: null,
      method: `Through drop-off: ${pct(lostShare)} of about ${num(itemsMonth)} items a month go cold while waiting, each worth ${fmt(value)} at this step.`,
    };
  };
  /** Rule 7: client work through the churn it drives; nothing for work that isn't for a client. */
  const slaCost = (s: EngineStep): IssueCost => {
    // Client groups are expanded into their unnamed clients, as the run's results are keyed (clients.ts).
    const grouped = withClientGroups(model);
    if (!servicing.has(s.id) || !result.clients || !grouped.clients) return noCost("Not client work, so no money method.");
    let total = 0;
    for (const id of servicing) total += result.steps[id]?.slaBreaches ?? 0;
    const share = total > 0 ? (result.steps[s.id]?.slaBreaches ?? 0) / total : 0;
    let excess = 0;
    for (const [cid, client] of Object.entries(grouped.clients)) {
      const c = result.clients[cid];
      if (!c) continue;
      excess += Math.max(0, c.churnMonthly.mean - clientChurnMonthly(grouped, client)) * clientLossValue(grouped, client, money.capMonths);
    }
    return {
      perMonth: excess * share,
      hoursPerMonth: null,
      method: `Through churn: late and missed work raises clients' monthly churn above its base, worth ${fmt(excess)} a month in lost clients, and this step is ${pct(share)} of the missed deadlines.`,
    };
  };

  // --- Too busy (rule 1): roles, then people whose load isn't already explained by their role.
  // Client work alone is over capacity when it exceeds even the overtime cap
  // allows (docs/PRD.md §6.3.4): the run clamps to the floor, so utilisation
  // alone rates it Operational risk, and the title says why.
  const aloneAt = 1 + Math.max(0, model.overtimeCap ?? 0);
  const overCap = aloneAt > 1 ? " even with overtime" : "";
  const roleCapacity: Record<string, number> = {};
  for (const p of Object.values(people)) {
    for (const rid of p.roles) roleCapacity[rid] = (roleCapacity[rid] ?? 0) + p.capacity / p.roles.length;
  }
  const flaggedRoles = new Set<string>();
  for (const rid of Object.keys(model.roles).sort()) {
    const r = result.roles[rid];
    const range = result.kpi.roles[rid]?.util;
    const cap = roleCapacity[rid] ?? 0;
    if (!r || !(cap > 0)) continue;
    const members = Object.keys(people).filter((pid) => people[pid]!.roles.includes(rid));
    const only = members.length === 1 ? members[0]! : null;
    const personId = named && only ? only : null;
    const { resolved, outcome } = rate("busy", { roleId: rid, personId }, r.util, range?.p90, rid === result.bnRole);
    if (!outcome || outcome.rating === "great") continue;
    flaggedRoles.add(rid);
    const who = named && only ? ` (${people[only]!.name})` : "";
    const clientsAlone = r.ongoing >= aloneAt;
    out.push({
      detector: "capacity",
      key: `capacity:role:${rid}`,
      type: "capacity",
      ...ratingFields(outcome),
      cost: busyCost(rid, r.overtimeHours, roleCost(rid), overtimeCovered(rid, null)),
      title: clientsAlone
        ? `${roleName(rid)}${who}: client work alone exceeds capacity${overCap}`
        : `${roleName(rid)}${who} at ${pct(r.util)} utilisation`,
      evidence: (
        `Simulated: ${num(r.ongoingHours + r.servicingHours)} h/wk client work + ${num(r.pipelineHours)} h/wk pipeline work against ` +
        `${num(cap)} h/wk capacity (${pct(r.util)}${range ? `, range ${pct(range.p10)}–${pct(range.p90)}` : ""}). ` +
        `Cut-offs: ${resolved.cutoffs.map(pct).join(" / ")}. ${escalationNote(outcome)}`
      ).trim(),
      metrics: {
        utilisation: r.util,
        ...(range ? { utilisation_p10: range.p10, utilisation_p90: range.p90 } : {}),
        pipeline_hours_week: r.pipelineHours,
        ongoing_hours_week: r.ongoingHours,
        ...(r.servicingHours ? { servicing_hours_week: r.servicingHours } : {}),
        capacity_hours_week: cap,
      },
      stepId: heaviest(staffed.filter((s) => roleOf(s) === rid)),
      roleId: rid,
      personId,
      fix: hire(rid),
    });
  }
  for (const pid of Object.keys(people).sort()) {
    const p = people[pid]!;
    const r = result.people[pid];
    const range = result.kpi.people[pid]?.util;
    if (!r || !(p.capacity > 0)) continue;
    const main = p.roles[0] ?? null;
    const { resolved, outcome } = rate("busy", { personId: named ? pid : null, roleId: main }, r.util, range?.p90, pid === result.bnPerson);
    if (!outcome || outcome.rating === "great") continue;
    // Their role is flagged already: that issue names them when they are its
    // only member. Unless their own client work alone is over capacity and
    // the role's isn't (one person's roster can be, while the role's isn't).
    const alone = r.ongoing >= aloneAt;
    const roleAlone = p.roles.some((rid) => (result.roles[rid]?.ongoing ?? 0) >= aloneAt);
    if (p.roles.length && p.roles.every((rid) => flaggedRoles.has(rid)) && !(alone && !roleAlone)) continue;
    const mine = staffed.filter((s) => eligible(pid, p, s));
    const who = named ? p.name : `One ${main ? roleName(main) : "person"}`;
    out.push({
      detector: "capacity",
      key: `capacity:person:${pid}`,
      type: "capacity",
      ...ratingFields(outcome),
      cost: busyCost(main, r.overtimeHours, named && model.payHidden ? null : p.cost ?? (p.roles.length ? p.roles.reduce((sum, rid) => sum + roleCost(rid), 0) / p.roles.length : 0), overtimeCovered(main, named ? pid : null)),
      title: alone ? `${who}: client work alone exceeds capacity${overCap}` : `${who} at ${pct(r.util)} utilisation`,
      evidence: (
        `Simulated: ${num(r.ongoingHours + r.servicingHours)} h/wk client work + ${num(r.pipelineHours)} h/wk pipeline work against ` +
        `${num(p.capacity)} h/wk capacity (${pct(r.util)}${range ? `, range ${pct(range.p10)}–${pct(range.p90)}` : ""}), ` +
        `while the rest of their role has room. Cut-offs: ${resolved.cutoffs.map(pct).join(" / ")}. ${escalationNote(outcome)}`
      ).trim(),
      metrics: {
        utilisation: r.util,
        ...(range ? { utilisation_p10: range.p10, utilisation_p90: range.p90 } : {}),
        pipeline_hours_week: r.pipelineHours,
        ongoing_hours_week: r.ongoingHours,
        ...(r.servicingHours ? { servicing_hours_week: r.servicingHours } : {}),
        capacity_hours_week: p.capacity,
      },
      stepId: heaviest(mine),
      roleId: main,
      personId: named ? pid : null,
      fix: main ? hire(main) : null,
    });
  }

  // --- Overtime worked to keep up with client work (rule 3; docs/PRD.md §4.1, decision D7).
  for (const issue of overtimeFound) out.push({ detector: "overtime", ...issue });

  // --- Per step: work piling up (4), waiting too long (5), single point of failure, rework (6), missed deadlines (7).
  for (const s of [...model.steps].sort((a, b) => cmp(a.id, b.id))) {
    const st = result.steps[s.id];
    if (!st) continue;
    const rid = roleOf(s);
    /** Hire into the step's role; for a step pinned to someone, take hands-on time down instead. */
    const capacityFix = (): SuggestedFix | null =>
      s.role
        ? hire(s.role)
        : s.work > 0
          ? { name: `Cut hands-on time at ${s.name} by 30%`, patch: [{ path: `steps.${s.id}.work_hours`, op: "multiply", value: 0.7 }] }
          : null;
    const base = { stepId: s.id, roleId: rid, personId: s.person && named ? s.person : null };
    const subject: RatingSubject = { stepId: s.id, roleId: rid, personId: base.personId, ...stepContext(s.id) };
    const onBn = s.id === result.bnStep;

    const growth = rate("queue", subject, st.queueGrowth, null, onBn);
    const growing = Boolean(s.role || s.person) && growth.outcome !== null && growth.outcome.rating !== "great";
    if (growing && growth.outcome) {
      out.push({
        detector: "queue",
        key: `queue:step:${s.id}`,
        type: "bottleneck",
        ...ratingFields(growth.outcome),
        cost: (() => {
          const value = stepLoss(s);
          const added = st.queueGrowth * WEEKS_PER_MONTH;
          return {
            perMonth: added * value,
            hoursPerMonth: null,
            method: `Value of the work stuck: about ${num(added)} more items pile up each month, each worth ${fmt(value)} at this step.`,
          };
        })(),
        title: `The queue at ${s.name} keeps growing`,
        evidence:
          `Simulated: the queue grows by ${num(st.queueGrowth)} items a week and ends the run at ${num(st.wip)} ` +
          `(average ${num(st.avgQueue)}, average wait ${days(st.avgWait, hoursPerDay)}). ` +
          `More work arrives than ${rid ? roleName(rid) : "its people"} can clear, so it won't settle.`,
        metrics: { queue_growth_week: st.queueGrowth, queue_end: st.wip, avg_queue: st.avgQueue, avg_wait_hours: st.avgWait },
        ...base,
        fix: capacityFix(),
      });
    } else if (s.role || s.person) {
      // A growing queue's wait is unbounded; that issue covers it. Wait means
      // time queued for a person, not the step's built-in wait.
      const resolved = resolveRule(config, "wait", subject);
      // Expected wait, most specific first: a person or step override, the
      // step's own setting, a role, service or process override, then the
      // default: 1 working day for pipeline steps, 2 for servicing steps.
      const specific = resolved.expectedWaitFrom === "person" || resolved.expectedWaitFrom === "step";
      const defaultDays = servicing.has(s.id) ? config.expectedWaitDays.servicing : config.expectedWaitDays.pipeline;
      const expected = (specific ? resolved.expectedWaitHours : null) ?? s.expectedWaitHours ?? resolved.expectedWaitHours ?? defaultDays * hoursPerDay;
      if (resolved.enabled && expected > 0) {
        const outcome = rateRule(config, "wait", resolved, {
          average: st.avgWait / expected,
          p90: st.p90 ? st.p90.avgWait / expected : null,
          onBottleneck: onBn,
        });
        if (outcome.rating !== "great") {
          out.push({
            detector: "wait",
            key: `wait:step:${s.id}`,
            type: "delay",
            ...ratingFields(outcome),
            cost: waitCost(s, st),
            title: `Work waits ${days(st.avgWait, hoursPerDay)} for ${s.name}`,
            evidence: (
              `Simulated: items queue ${num(st.avgWait)} h on average before anyone starts them, ` +
              `${num(st.avgWait / expected)}× the ${num(expected)} h expected for this step; average queue ${num(st.avgQueue)}, peak ${num(st.maxQueue)}. ${escalationNote(outcome)}`
            ).trim(),
            metrics: {
              avg_wait_hours: st.avgWait,
              ...(st.p90 ? { avg_wait_hours_p90: st.p90.avgWait } : {}),
              avg_queue: st.avgQueue,
              max_queue: st.maxQueue,
              expected_wait_hours: expected,
              wait_ratio: st.avgWait / expected,
              ...(s.lostPerDayWaiting
                ? {
                    lost_per_day_waiting: s.lostPerDayWaiting,
                    // Linear in the days waited, capped at everything: a cost input for A43, not a simulated loss.
                    lost_to_waiting_share: Math.min(1, s.lostPerDayWaiting * (st.avgWait / hoursPerDay)),
                  }
                : {}),
            },
            ...base,
            fix: capacityFix(),
          });
        }
      }
    }

    // Rework is rated from what the simulation shows, not from the rate typed into the model.
    if (st.departures > 0) {
      const observed = Math.min(1, st.reworks / st.departures);
      const { resolved, outcome } = rate("rework", subject, observed, st.p90?.reworkShare, onBn);
      if (outcome && outcome.rating !== "great") {
        out.push({
          detector: "rework",
          key: `rework:step:${s.id}`,
          type: "failure",
          ...ratingFields(outcome),
          cost: (() => {
            if (model.payHidden && s.person && people[s.person]) return payHiddenCost();
            const rate = s.person ? (people[s.person]?.cost ?? roleCost(roleOf(s))) : roleCost(roleOf(s));
            const hours = ((st.reworks * s.work) / model.horizonWeeks) * WEEKS_PER_MONTH;
            return {
              perMonth: hours * rate,
              hoursPerMonth: hours,
              method: `Repeated hours at cost rates: about ${num(hours)} h a month done twice at ${fmt(rate)} an hour.`,
            };
          })(),
          title: `${pct(observed)} of ${s.name} is done twice`,
          evidence: (
            `Simulated: ${num(st.reworks)} repeats over the ${num(model.horizonWeeks, 0)}-week run, ${pct(observed)} of visits ` +
            `(the model enters ${pct(s.rework)}). Cut-offs: ${resolved.cutoffs.map(pct).join(" / ")}. ${escalationNote(outcome)}`
          ).trim(),
          metrics: {
            rework_rate: s.rework,
            reworks: st.reworks,
            observed_share: observed,
            ...(st.p90 ? { observed_share_p90: st.p90.reworkShare } : {}),
          },
          ...base,
          fix: { name: `Halve rework at ${s.name}`, patch: [{ path: `steps.${s.id}.rework_rate`, op: "multiply", value: 0.5 }] },
        });
      }
    }

    // Work lost at a step (rule 12): the share of visits that go straight to a lost end, against the step's benchmark.
    const benchmark = s.dropoffBenchmark;
    if (benchmark !== undefined && benchmark > 0 && st.lostHere !== undefined && st.departures > 0) {
      const observed = Math.min(1, st.lostHere / st.departures);
      const p90 = st.p90?.lostShare;
      const { resolved, outcome } = rate("dropoff", subject, observed / benchmark, p90 === undefined ? null : p90 / benchmark, onBn);
      if (outcome && outcome.rating !== "great") {
        out.push({
          detector: "dropoff",
          key: `dropoff:step:${s.id}`,
          type: "failure",
          ...ratingFields(outcome),
          cost: (() => {
            // Items lost above the benchmark × what a loss is worth at this step (docs/analysis-rules.md rule 12).
            const above = Math.max(0, st.lostHere - benchmark * st.departures);
            const itemsMonth = (above / model.horizonWeeks) * WEEKS_PER_MONTH;
            const value = stepLoss(s);
            return {
              perMonth: itemsMonth * value,
              hoursPerMonth: null,
              method: `Lost items above the benchmark: about ${num(itemsMonth)} a month, each worth ${fmt(value)} at this step.`,
            };
          })(),
          title: `${pct(observed)} of work is lost at ${s.name}`,
          evidence: (
            `Simulated: ${num(st.lostHere)} of ${num(st.departures)} visits over the ${num(model.horizonWeeks, 0)}-week run go straight to a lost end, ` +
            `${pct(observed)} against a benchmark of ${pct(benchmark)} (${num(observed / benchmark)}× the benchmark). ` +
            `Cut-offs: ${resolved.cutoffs.map((c) => `${num(c)}×`).join(" / ")}. ${escalationNote(outcome)}`
          ).trim(),
          metrics: {
            lost_share: observed,
            ...(p90 !== undefined ? { lost_share_p90: p90 } : {}),
            benchmark,
            benchmark_ratio: observed / benchmark,
            lost_items: st.lostHere,
            departures: st.departures,
          },
          ...base,
          fix: null,
        });
      }
    }

    if (s.sla !== undefined && st.departures > 0) {
      const share = st.slaBreaches / st.departures;
      const { resolved, outcome } = rate("sla", subject, share, st.p90?.slaBreachShare, onBn);
      if (outcome && outcome.rating !== "great") {
        // Most of the time spent queueing: more hands help. Most of it an external wait: shorten that.
        const queueing = st.avgWait >= s.wait;
        out.push({
          detector: "sla",
          key: `sla:step:${s.id}`,
          type: "sla",
          ...ratingFields(outcome),
          cost: slaCost(s),
          title: `${s.name} misses its ${num(s.sla)} h SLA ${pct(share)} of the time`,
          evidence: (
            `Simulated: ${num(st.slaBreaches)} of ${num(st.departures)} visits over the ${num(model.horizonWeeks, 0)}-week run took longer than ${num(s.sla)} h ` +
            `(queue ${num(st.avgWait)} h + hands-on ${num(s.work)} h + wait ${num(s.wait)} h on average). ` +
            `Cut-offs: ${resolved.cutoffs.map(pct).join(" / ")}. ${escalationNote(outcome)}`
          ).trim(),
          metrics: {
            breach_share: share,
            ...(st.p90 ? { breach_share_p90: st.p90.slaBreachShare } : {}),
            breaches: st.slaBreaches,
            departures: st.departures,
            sla_hours: s.sla,
            avg_wait_hours: st.avgWait,
          },
          ...base,
          fix:
            queueing || !(s.wait > 0)
              ? capacityFix()
              : { name: `Halve the wait at ${s.name}`, patch: [{ path: `steps.${s.id}.wait_hours`, op: "multiply", value: 0.5 }] },
        });
      }
    }
  }

  // --- Only one person can do it (rule 8): the absence test's result, rated on work lost and weeks to recover.
  // One finding for each step only that person can do (keyed by the step, as the structural check was), all rated
  // from the same absence run. A step nothing reaches is left out.
  for (const f of options.absence?.people ?? []) {
    const p = people[f.personId];
    if (!p) continue;
    const main = p.roles[0] ?? null;
    const soleSteps = model.steps.filter((s) => f.stepIds.includes(s.id) && (result.steps[s.id]?.arrivals ?? 0) > 0);
    for (const s of soleSteps.sort((x, y) => cmp(x.id, y.id))) {
      const subject: RatingSubject = { stepId: s.id, roleId: main, personId: named ? f.personId : null, ...stepContext(s.id) };
      const resolved = resolveRule(config, "spof", subject);
      if (!resolved.enabled) continue;
      const lost = rateRule(config, "spof", resolved, { average: f.workLost });
      // A queue that never got back to normal is Operational risk whatever the run's length: on a short run it is "not within the weeks we could see".
      const recovery = f.recovered
        ? rateValue(config.absence.recoveryCutoffs, { average: f.recoveryWeeks }, { upperInclusive: true, badMonth: false, bottleneck: false }).rating
        : "risk";
      let rating = worseRating(lost.rating, recovery);
      if (f.clientDeadlineMissed) rating = "risk";
      if (rating === "great") continue;
      const away = options.absence!.weeksAway;
      const others = soleSteps.filter((o) => o.id !== s.id).map((o) => o.name);
      out.push({
        detector: "spof",
        key: `spof:step:${s.id}`,
        type: "spof",
        ...ratingFields({ rating, base: rating, badMonth: false, bottleneck: false }),
        cost: (() => {
          if (!(f.winsLost > 0)) return noCost("No wins are lost, only missed client tasks, and those aren't costed here.");
          // The damage of one absence (the wins it loses, at deal value, not servicing tasks; shared by the steps only they can do) × absences a year ÷ 12.
          const damage = (f.winsLost / Math.max(1, soleSteps.length)) * dealValue;
          return {
            perMonth: (damage * money.absencesPerYear) / 12,
            hoursPerMonth: null,
            method: `One absence loses about ${num(f.winsLost / Math.max(1, soleSteps.length))} wins, worth ${fmt(damage)} at deal value (missed client tasks aren't counted here); × ${num(money.absencesPerYear, 0)} absences a year ÷ 12.`,
          };
        })(),
        title: named ? `Only ${p.name} can do ${s.name}` : `Only one ${main ? roleName(main) : "person"} can do ${s.name}`,
        evidence:
          `Absence test: with ${named ? p.name : "them"} away for ${num(away, 1)} week${away === 1 ? "" : "s"}, ` +
          `${pct(f.workLost)} of the work completed from then to the end of the run is lost, and the queues at their steps ` +
          (f.recovered
            ? `take ${num(f.recoveryWeeks, 0)} week${f.recoveryWeeks === 1 ? "" : "s"} to get back to normal`
            : `are not back to normal within ${num(f.recoveryWeeks - 1, 0)} week${f.recoveryWeeks === 2 ? "" : "s"} of their return`) +
          `.${f.clientDeadlineMissed ? ` A client deadline is missed: ${num(f.extraMissed)} more servicing tasks a run go unfinished.` : ""}` +
          `${others.length ? ` They are also the only one for ${others.join(", ")}.` : ""} ` +
          `Cut-offs: work lost ${resolved.cutoffs.map(pct).join(" / ")}; weeks to recover ${config.absence.recoveryCutoffs.join(" / ")}.`,
        metrics: {
          work_lost: f.workLost,
          items_lost: f.itemsLost,
          wins_lost: f.winsLost,
          recovery_weeks: f.recoveryWeeks,
          recovered: f.recovered ? 1 : 0,
          weeks_away: away,
          extra_missed_tasks: f.extraMissed,
          absences_per_year: config.absence.perYear,
          arrivals: result.steps[s.id]!.arrivals,
          sole_steps: f.stepIds.length,
        },
        stepId: s.id,
        roleId: roleOf(s),
        personId: named ? f.personId : null,
        fix: s.role ? hire(s.role) : null,
      });
    }
  }

  // --- Too slow overall (rule 13): end-to-end time against the process's target.
  const target = model.targetCycleHours;
  if (target !== undefined && target > 0 && result.kpi.cycle.mean > 0) {
    const resolved = resolveRule(config, "cycle", { processId: options.processId ?? null });
    if (resolved.enabled) {
      const bad = percentile(result.samples.cycleMean.filter((c) => c > 0), 0.9);
      const outcome = rateRule(config, "cycle", resolved, { average: result.kpi.cycle.mean / target, p90: bad / target });
      if (outcome.rating !== "great") {
        out.push({
          detector: "cycle",
          key: `cycle:process:${options.processId ?? "pipeline"}`,
          type: "delay",
          ...ratingFields(outcome),
          cost: (() => {
            // Revenue delayed: each win arrives later by the time over target, so it bills that many months less (retainers).
            const monthsLate = Math.max(0, result.kpi.cycle.mean - target) / (model.hoursPerWeek * WEEKS_PER_MONTH);
            const winsMonth = (result.kpi.won.mean / model.horizonWeeks) * WEEKS_PER_MONTH;
            const fee = serviceMix(model).reduce((sum, m) => sum + m.share * (m.service.pricingModel === "retainer" ? m.service.price : 0), 0);
            if (!(fee > 0)) return noCost("Revenue delayed needs a retainer fee; none is set.");
            return {
              perMonth: winsMonth * fee * monthsLate,
              hoursPerMonth: null,
              method: `Revenue delayed: about ${num(winsMonth)} wins a month each arrive ${num(monthsLate)} months late, at ${fmt(fee)} a month.`,
            };
          })(),
          title: `Takes ${days(result.kpi.cycle.mean, hoursPerDay)} end to end against a ${days(target, hoursPerDay)} target`,
          evidence: (
            `Simulated: items take ${num(result.kpi.cycle.mean)} h on average from start to finish (P90 ${num(result.kpi.cycle.p90)} h), ` +
            `${num(result.kpi.cycle.mean / target)}× the ${num(target)} h target. Cut-offs: ${resolved.cutoffs.map((c) => `${num(c)}×`).join(" / ")}. ${escalationNote(outcome)}`
          ).trim(),
          metrics: {
            cycle_mean_hours: result.kpi.cycle.mean,
            cycle_p90_hours: result.kpi.cycle.p90,
            target_hours: target,
            target_ratio: result.kpi.cycle.mean / target,
          },
          stepId: null,
          roleId: null,
          personId: null,
          fix: null,
        });
      }
    }
  }

  // --- Goals met (rule 11): the share of runs that meet each success measure the simulation can compute.
  for (const check of checkSuccessMeasures(options.successMeasures ?? NO_SUCCESS_MEASURES, model, result)) {
    if (check.status !== "rated") continue;
    const m = check.measure;
    const resolved = resolveRule(config, "success", { processId: m.processId ?? options.processId ?? null });
    if (!resolved.enabled) continue;
    const outcome = rateRule(config, "success", resolved, { average: check.metShare });
    if (outcome.rating === "great") continue;
    out.push({
      detector: "success",
      key: `success:measure:${m.id}`,
      type: "failure",
      ...ratingFields(outcome),
      cost: noCost("Depends on the measure: it has no money method yet."),
      title: `Goal not reliably met: ${m.name}`,
      evidence: (
        `Simulated: the target (${m.direction === "atLeast" ? "at least" : "at most"} ${num(m.target)}) is met in ${num(check.met, 0)} of ${num(check.reps, 0)} runs ` +
        `(${pct(check.metShare)}); the average is ${num(check.mean)}. Cut-offs: ${resolved.cutoffs.map(pct).join(" / ")} of runs. ${escalationNote(outcome)}`
      ).trim(),
      metrics: { met_share: check.metShare, runs_met: check.met, runs: check.reps, target: m.target, average: check.mean },
      stepId: null,
      roleId: null,
      personId: null,
      fix: null,
    });
  }

  // --- Spare time (rule 2): people (roles, when the model has no named people) with room to spare are an opportunity.
  const spare = (subject: { key: string; name: string; capacity: number; roleId: string | null; personId: string | null }, r: { util: number; pipelineHours: number; ongoingHours: number; servicingHours: number }) => {
    if (!(subject.capacity > 0)) return;
    const { resolved, outcome } = rate("spare", { roleId: subject.roleId, personId: subject.personId }, r.util, null, false);
    if (!outcome || outcome.rating === "great") return;
    const busyHours = r.pipelineHours + r.ongoingHours + r.servicingHours;
    const free = Math.max(0, subject.capacity - busyHours);
    out.push({
      detector: "spare",
      key: subject.key,
      type: "capacity",
      ...ratingFields(outcome),
      cost: (() => {
        const person = subject.personId ? people[subject.personId] : undefined;
        if (model.payHidden && person) return payHiddenCost();
        const rate = person
          ? (person.cost ?? (person.roles.length ? person.roles.reduce((sum, rid) => sum + roleCost(rid), 0) / person.roles.length : 0))
          : roleCost(subject.roleId);
        const hours = free * WEEKS_PER_MONTH;
        return { perMonth: hours * rate, hoursPerMonth: hours, method: `Idle hours at cost rates: about ${num(hours)} h a month at ${fmt(rate)} an hour.` };
      })(),
      title: `${subject.name} has about ${num(free, 0)} h a week free`,
      evidence:
        `Simulated: ${pct(r.util)} utilised, ${num(busyHours)} h a week of work against ${num(subject.capacity)} h of capacity, so about ${num(free, 0)} h a week is free. ` +
        `An opportunity: Good, could improve under ${pct(resolved.cutoffs[0])} busy.`,
      metrics: { utilisation: r.util, free_hours_week: free, busy_hours_week: busyHours, capacity_hours_week: subject.capacity },
      stepId: null,
      roleId: subject.roleId,
      personId: subject.personId,
      fix: null,
    });
  };
  if (named) {
    for (const pid of Object.keys(people).sort()) {
      const p = people[pid]!;
      const r = result.people[pid];
      if (r) spare({ key: `spare:person:${pid}`, name: p.name, capacity: p.capacity, roleId: p.roles[0] ?? null, personId: pid }, r);
    }
  } else {
    for (const rid of Object.keys(model.roles).sort()) {
      const r = result.roles[rid];
      if (r) spare({ key: `spare:role:${rid}`, name: roleName(rid), capacity: roleCapacity[rid] ?? 0, roleId: rid, personId: null }, r);
    }
  }

  // --- Clients whose health ends the run below 50 (docs/PRD.md §6.3.5). Not yet on the rating model (rule 9).
  for (const issue of churnRiskIssues(model, result, money)) out.push({ detector: "churn", ...issue });
  // --- Rule 10: a driver that causes 30% or more of a client group's churn.
  for (const issue of churnCauseIssues(model, result, config, money)) out.push({ detector: "churn", ...issue });

  const rank = (i: { detector: Detector }) => DETECTORS.indexOf(i.detector);
  return out
    .sort((a, b) => compareRatingsDesc(a.rating, b.rating) || compareCostsDesc(a.cost, b.cost) || rank(a) - rank(b) || cmp(a.key, b.key))
    .map(({ detector: _detector, ...issue }) => issue);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

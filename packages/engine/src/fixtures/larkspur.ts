import type { EngineModel, EngineStep } from "../model";
import {
  LARKSPUR_GROWTH_MONTHLY,
  LARKSPUR_LEAD_SOURCES,
  LARKSPUR_PIPELINE,
  LARKSPUR_ROLES,
  LARKSPUR_ROSTER,
  LARKSPUR_SEASONALITY,
  LARKSPUR_SERVICES,
  LARKSPUR_SERVICING,
  LARKSPUR_SETTINGS,
  LARKSPUR_START_MONTH,
  LARKSPUR_TEAM,
  larkspurClientKey,
  type LarkspurEdge,
  type LarkspurStep,
} from "./larkspur-data";

export * from "./larkspur-data";

const roleOrder = (key: string) => LARKSPUR_ROLES.findIndex(([k]) => k === key);

function engineSteps(steps: LarkspurStep[], edges: LarkspurEdge[]): EngineStep[] {
  return steps
    .filter((s) => s.kind !== "start" && s.kind !== "end")
    .map((s) => ({
      id: s.key,
      name: s.name,
      role: s.role,
      ...(s.person ? { person: s.person } : {}),
      work: s.work,
      wait: s.wait,
      rework: s.rework,
      ...(s.workDist ? { workDist: { ...s.workDist } } : {}),
      ...(s.waitDist ? { waitDist: { ...s.waitDist } } : {}),
      ...(s.currentWip !== undefined ? { currentWip: s.currentWip } : {}),
      ...(s.sla !== undefined ? { sla: s.sla } : {}),
      next: edges.filter(([from]) => from === s.key).map(([, to, p, tag]) => ({ to, p, ...(tag ? { tag } : {}) })),
    }));
}

/**
 * Larkspur Creative, the second golden model (docs/PRD.md §6.9 layer 3): a
 * social and content agency with an overloaded design pool, a copywriter on
 * overtime, a named client roster whose health drives churn, and most of the
 * engine's odd corners (see larkspur-data.ts). Exactly what the database
 * seed resolves to on LARKSPUR_START, with readable keys for ids.
 */
export function larkspurModel(): EngineModel {
  const s = LARKSPUR_SETTINGS;
  const pipeline = LARKSPUR_PIPELINE;
  const steps = engineSteps(pipeline.steps, pipeline.edges);
  const ends: NonNullable<EngineModel["ends"]> = { lost_price: { outcome: "lost" } };
  const servicingProcesses: NonNullable<EngineModel["servicingProcesses"]> = {};
  for (const proc of LARKSPUR_SERVICING) {
    const working = engineSteps(proc.steps, proc.edges);
    steps.push(...working);
    for (const end of proc.steps.filter((st) => st.kind === "end")) ends[end.key] = { outcome: "done" };
    const start = proc.steps.find((st) => st.kind === "start")!;
    servicingProcesses[proc.key] = { name: proc.name, entry: proc.edges.find(([from]) => from === start.key)![1], steps: working.map((w) => w.id) };
  }
  return {
    horizonWeeks: s.horizonWeeks,
    hoursPerWeek: s.hoursPerWeek,
    leadsPerWeek: LARKSPUR_LEAD_SOURCES.reduce((sum, [, , volume, conversion]) => sum + volume * conversion, 0),
    demand: { seasonality: [...LARKSPUR_SEASONALITY], growthMonthly: LARKSPUR_GROWTH_MONTHLY, startMonth: LARKSPUR_START_MONTH },
    activeClients: LARKSPUR_ROSTER.length,
    churnMonthly: s.churnMonthly,
    retainer: s.retainer,
    roles: Object.fromEntries(
      LARKSPUR_ROLES.map(([key, name, cost]) => [key, { name, count: LARKSPUR_TEAM.filter((p) => p.roles[0] === key).length, cost, ongoing: 0 }]),
    ),
    services: Object.fromEntries(
      LARKSPUR_SERVICES.map((sv) => [
        sv.key,
        {
          name: sv.name,
          pricingModel: sv.pricingModel,
          price: sv.price,
          margin: sv.margin,
          tenureMonths: sv.tenureMonths,
          churnMonthly: sv.churnMonthly,
          churnSensitivity: sv.churnSensitivity,
          mixShare: sv.mixShare,
          pathTags: [sv.key],
          fallbackOngoing: { ...sv.fallback },
          ...(sv.servicing.length
            ? { servicing: sv.servicing.map(([process, recurrence, sla]) => ({ process, recurrence: { ...recurrence }, sla })) }
            : {}),
        },
      ]),
    ),
    people: Object.fromEntries(
      LARKSPUR_TEAM.map((p) => [
        p.key,
        {
          name: p.name,
          roles: [...p.roles].sort((a, b) => roleOrder(a) - roleOrder(b)),
          capacity: p.hours ?? p.fte * s.hoursPerWeek,
          ...(p.cost !== undefined ? { cost: p.cost } : {}),
          ...(p.skills ? { skills: [...p.skills] } : {}),
          ...(p.leave ? { leave: p.leave.map((l): [number, number] => [...l.hours]) } : {}),
        },
      ]),
    ),
    availabilityFloor: s.availabilityFloor,
    overtimeCap: s.overtimeCap,
    clients: Object.fromEntries(
      LARKSPUR_ROSTER.map((c, i) => [
        larkspurClientKey(i),
        {
          name: c.name,
          services: [...c.services].sort(),
          mrr: c.mrr,
          ...(c.health !== null ? { health: c.health } : {}),
          assignments: { ...c.team, ops: "priti" },
        },
      ]),
    ),
    servicingProcesses,
    health: { initial: s.healthInitial, missedPenalty: s.healthMissedPenalty },
    entry: pipeline.edges.find(([from]) => from === "start")![1],
    sinks: { won: "won", lost: "lost_fit" },
    ends,
    steps,
  };
}

/** What each Larkspur step achieves (sandbox G), by step id: the golden model `larkspur-time` and the time-by-purpose tests. */
export const LARKSPUR_PURPOSES: Readonly<Record<string, string>> = {
  triage: "winning",
  pitch: "winning",
  concepts: "winning",
  decision: "winning",
  onboard: "winning",
  workshop: "client_job",
  social_setup: "client_job",
  content_plan: "client_job",
  web_design: "client_job",
  web_build: "client_job",
  launch: "coordination",
  cal_plan: "removable",
  cal_social: "client_job",
  cal_design: "client_job",
  cal_approve: "required",
  adhoc_design: "client_job",
};

/** `larkspurModel()` with a purpose on every working step. Reporting only: every other number is `larkspurModel()`'s. */
export function larkspurWithPurposes(): EngineModel {
  const m = larkspurModel();
  return { ...m, steps: m.steps.map((s) => (s.id in LARKSPUR_PURPOSES ? { ...s, purpose: LARKSPUR_PURPOSES[s.id]! } : s)) };
}

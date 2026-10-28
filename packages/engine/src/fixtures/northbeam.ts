import type { EngineModel } from "../model";
import { NORTHBEAM_CLIENT_GROUPS, NORTHBEAM_FALLBACK_LOAD, NORTHBEAM_ROSTER, NORTHBEAM_TEAM, northbeamClientKey } from "./northbeam-roster";
import { NORTHBEAM_SERVICING } from "./northbeam-servicing";

export { NORTHBEAM_CLIENT_GROUPS, NORTHBEAM_FALLBACK_LOAD, NORTHBEAM_ROSTER, NORTHBEAM_TEAM, northbeamClientKey, type NorthbeamClient } from "./northbeam-roster";
export { NORTHBEAM_SERVICING, type NorthbeamServicingProcess, type NorthbeamServicingStep } from "./northbeam-servicing";

/**
 * Northbeam Digital: fictional SEO/PPC agency, lead-to-live pipeline.
 * The prototype's BASE_MODEL (minus canvas positions) with one change: 7 leads
 * a week, not 12. At 12 the lone strategist gets ~38h/week of audits and
 * kickoffs against ~30h left after client work, so the queue grows without
 * bound and every KPI depends on how long the warm-up ran. At 7 the strategist
 * is still the bottleneck (~82%) but the business reaches a steady state.
 * Times in working hours.
 */
export function northbeamModel(): EngineModel {
  return {
    horizonWeeks: 13,
    hoursPerWeek: 40,
    leadsPerWeek: 7,
    activeClients: 26,
    churnMonthly: 0.03,
    retainer: 3800,
    roles: {
      sales: { name: "Sales", count: 2, cost: 45, ongoing: 0 },
      strat: { name: "Strategist", count: 1, cost: 70, ongoing: 0.4 },
      am: { name: "Account manager", count: 2, cost: 55, ongoing: 1.6 },
      seo: { name: "SEO specialist", count: 3, cost: 50, ongoing: 2.4 },
      ppc: { name: "PPC specialist", count: 2, cost: 50, ongoing: 2.0 },
      fin: { name: "Finance", count: 1, cost: 40, ongoing: 0.3 },
    },
    entry: "qualify",
    sinks: { won: "won", lost: "lost" },
    steps: [
      { id: "qualify", name: "Qualify lead", role: "sales", work: 0.5, wait: 4, rework: 0, next: [{ to: "discovery", p: 0.55 }, { to: "lost", p: 0.45 }] },
      { id: "discovery", name: "Discovery call", role: "sales", work: 1.5, wait: 24, rework: 0, next: [{ to: "audit", p: 0.7 }, { to: "lost", p: 0.3 }] },
      { id: "audit", name: "Audit & proposal", role: "strat", work: 6, wait: 0, rework: 0.15, lostPerDayWaiting: 0.05, next: [{ to: "decision", p: 1 }] },
      { id: "decision", name: "Client decision", role: null, work: 0, wait: 40, rework: 0, next: [{ to: "onboard", p: 0.32 }, { to: "lost", p: 0.68 }] },
      { id: "onboard", name: "Contract & onboarding", role: "am", work: 3, wait: 16, rework: 0.1, next: [{ to: "kickoff", p: 1 }] },
      { id: "kickoff", name: "Kickoff & strategy", role: "strat", work: 4, wait: 8, rework: 0, next: [{ to: "seo", p: 0.55 }, { to: "ppc", p: 0.45 }] },
      { id: "seo", name: "SEO campaign setup", role: "seo", work: 10, wait: 8, rework: 0.1, next: [{ to: "live", p: 1 }] },
      { id: "ppc", name: "PPC campaign setup", role: "ppc", work: 8, wait: 8, rework: 0.1, next: [{ to: "live", p: 1 }] },
      { id: "live", name: "Go live & first report", role: "am", work: 2, wait: 0, rework: 0, next: [{ to: "won", p: 1 }] },
    ],
  };
}

/**
 * Northbeam with its two services, as seeded: SEO and PPC retainers, the
 * kickoff's SEO/PPC branch condition-tagged so each client follows its
 * service's path. `northbeamModel()` stays the services-free golden model
 * (every win priced at `retainer`), so the prototype-parity and
 * queueing-theory checks keep their exact reference.
 */
export function northbeamWithServices(): EngineModel {
  const base = northbeamModel();
  return {
    ...base,
    services: {
      seo: {
        name: "SEO retainer",
        pricingModel: "retainer",
        price: 3500,
        margin: 0.45,
        tenureMonths: 18,
        churnMonthly: 0.03,
        mixShare: 0.55,
        pathTags: ["seo"],
      },
      ppc: {
        name: "PPC management",
        pricingModel: "retainer",
        price: 4200,
        margin: 0.4,
        tenureMonths: 12,
        churnMonthly: 0.04,
        mixShare: 0.45,
        pathTags: ["ppc"],
      },
    },
    steps: base.steps.map((s) =>
      s.id === "kickoff"
        ? {
            ...s,
            next: [
              { to: "seo", p: 0.55, tag: "seo" },
              { to: "ppc", p: 0.45, tag: "ppc" },
            ],
          }
        : s,
    ),
  };
}

/**
 * Northbeam with services, named people and its client roster, as seeded
 * (issue #18): ongoing load comes from each client's services and goes to the
 * people assigned to it, and the workspace allows 10% overtime. Wins become
 * synthetic clients; clients churn one by one.
 */
export function northbeamWithClients(): EngineModel {
  const base = northbeamWithServices();
  const services = base.services!;
  const clients: NonNullable<EngineModel["clients"]> = {};
  NORTHBEAM_ROSTER.forEach((c, i) => {
    const assignments: Record<string, string> = { am: c.am, fin: "rosa", strat: "maya" };
    if (c.seo) assignments.seo = c.seo;
    if (c.ppc) assignments.ppc = c.ppc;
    clients[northbeamClientKey(i)] = { name: c.name, services: [...c.services].sort(), mrr: c.mrr, health: c.health, assignments };
  });
  return {
    ...base,
    activeClients: NORTHBEAM_ROSTER.length,
    services: {
      seo: { ...services.seo!, fallbackOngoing: NORTHBEAM_FALLBACK_LOAD.seo },
      ppc: { ...services.ppc!, fallbackOngoing: NORTHBEAM_FALLBACK_LOAD.ppc },
    },
    people: Object.fromEntries(NORTHBEAM_TEAM.map(([key, name, role]) => [key, { name, roles: [role], capacity: base.hoursPerWeek }])),
    overtimeCap: 0.1,
    clients,
  };
}

/**
 * Northbeam as seeded since issue #19: its roster runs two servicing
 * processes (NORTHBEAM_SERVICING), a monthly report and a fortnightly
 * check-in, on both services. They replace the services' fallback load, which
 * is sized the same, so client work is now tasks that queue for each client's
 * assigned people beside the pipeline, and late or missed ones wear its
 * health down. Churn follows health at the database's default sensitivity of
 * 3 (docs/PRD.md §6.3.5).
 */
export function northbeamWithServicing(): EngineModel {
  const base = northbeamWithClients();
  const steps = [...base.steps];
  const ends: NonNullable<EngineModel["ends"]> = {};
  const servicingProcesses: NonNullable<EngineModel["servicingProcesses"]> = {};
  for (const proc of NORTHBEAM_SERVICING) {
    const working = proc.steps.filter((s) => s.kind !== "start" && s.kind !== "end");
    const start = proc.steps.find((s) => s.kind === "start")!;
    for (const s of working) {
      steps.push({
        id: s.key,
        name: s.name,
        role: s.role,
        work: s.work,
        wait: s.wait,
        rework: 0,
        next: proc.edges.filter(([from]) => from === s.key).map(([, to, p, tag]) => ({ to, p, ...(tag ? { tag } : {}) })),
      });
    }
    for (const s of proc.steps.filter((st) => st.kind === "end")) ends[s.key] = { outcome: "done" };
    servicingProcesses[proc.key] = {
      name: proc.name,
      entry: proc.edges.find(([from]) => from === start.key)![1],
      steps: working.map((s) => s.key),
    };
  }
  const servicing = NORTHBEAM_SERVICING.map((p) => ({ process: p.key, recurrence: { ...p.recurrence }, sla: p.slaHours }));
  const services = Object.fromEntries(
    Object.entries(base.services!).map(([id, sv]) => [id, { ...sv, churnSensitivity: 3, servicing: servicing.map((l) => ({ ...l })) }]),
  );
  return { ...base, services, ends, servicingProcesses, steps };
}

/**
 * Northbeam as the seed loads it since issue #120: its clients are counted per
 * service (NORTHBEAM_CLIENT_GROUPS) instead of named, and the engine simulates
 * unnamed clients from those numbers. Everything else is `northbeamWithServicing()`:
 * the named roster stays in the database, hidden, and is not simulated.
 */
export function northbeamWithClientGroups(): EngineModel {
  const { clients: _named, ...base } = northbeamWithServicing();
  return {
    ...base,
    activeClients: NORTHBEAM_CLIENT_GROUPS.reduce((a, g) => a + g.count, 0),
    clientGroups: Object.fromEntries(
      NORTHBEAM_CLIENT_GROUPS.map(({ service, ...g }) => [service, g]),
    ),
  };
}

/**
 * Northbeam as the seed loads it, with every churn driver switched on at the
 * prototype's weights (A56): late work 1.5, response time 1, onboarding 0.8,
 * rework 1, team overload 1.2, account manager changes 0.6, results 1 (rated 7
 * out of 10), early tenure 0.8 (1.6 times as likely in months 1 to 6), price
 * changes 0.5 (a 10% rise in month 3) and the market 1, plus one of its own
 * (a competitor undercutting, 15% extra churn at weight 1).
 */
export function northbeamWithChurnDrivers(): EngineModel {
  return {
    ...northbeamWithClientGroups(),
    churnDrivers: [
      { id: "late", weight: 1.5, enabled: true },
      { id: "resp", weight: 1, enabled: true },
      { id: "onb", weight: 0.8, enabled: true, value: 10 },
      { id: "rework", weight: 1, enabled: true },
      { id: "load", weight: 1.2, enabled: true },
      { id: "handoff", weight: 0.6, enabled: true, value: 0.3 },
      { id: "results", weight: 1, enabled: true, value: 7 },
      { id: "tenure", weight: 0.8, enabled: true, value: 1.6 },
      { id: "price", weight: 0.5, enabled: true, value: 10, month: 3 },
      { id: "market", weight: 1, enabled: true },
      { id: "custom:competitor", name: "A competitor undercuts us", weight: 1, enabled: true, value: 15 },
    ],
  };
}

/**
 * `northbeamWithClientGroups()` with an overhead and an hourly PPC service (sandbox phase 2, engine 1.11.0): 18,000 a
 * month of fixed costs, and PPC clients won in the run billing 95 an hour for the work done for them (the 12 PPC
 * clients already there still bill their entered fee). The golden model for profit and the monthly money series.
 */
export function northbeamWithMoney(): EngineModel {
  const base = northbeamWithClientGroups();
  return {
    ...base,
    overheadMonthly: 18000,
    services: { ...base.services, ppc: { ...base.services!.ppc!, pricingModel: "hourly", price: 95 } },
  };
}

// A free-play run, read for the Sandbox's verdict and four charts (capacity build P7, docs/plans/capacity/p7-sandbox-brief.md section 4).
//
// Everything that is a capacity figure comes from P5's `capacity-figures.ts`: DLER (`dler`, with the salaries of the people there that month),
// when a team goes over its line and when to hire (`hiringAdvice`), and the people and their lines (`busyShares`). This file only lines the engine's
// monthly series up with them, month by month, for a run with the levers moved and one without.

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import type { CapacitySetup, SetupPerson } from "./capacity-setup";
import { tierCount, uniqueClients } from "./capacity-setup";
import { busyShares, dler, hiringAdvice, DEFAULT_HIRING_DELAY_MONTHS } from "./capacity-figures";
import { playChangeId, type PlayState } from "./sandbox-play";
import type { PlayPersonSeries, PlaySeries } from "./sandbox-verdict";

export interface PlayLine {
  id: string;
  name: string;
  values: (number | null)[];
}

export interface PlayTeamLine extends PlayLine {
  /** The team's line (D17), 0-1. */
  line: number;
}

export interface PlayCharts {
  /** Clients by department. */
  clients: PlayLine[];
  retainers: number[];
  /** DLER by department (D24). */
  dler: PlayLine[];
  dlerWhole: (number | null)[];
  /** The five busiest teams over the run, busiest first, each with its line. */
  teams: PlayTeamLine[];
  /** Clients lost to a price rise over the run, from the churn causes (D36); 0 with no rise. */
  lostToPrice: number;
}

export interface PlayOutcome extends PlaySeries {
  charts: PlayCharts;
}

const mean = (s: { mean: number } | null | undefined): number => (s ? s.mean : 0);

/** The setup as it stands in month `m` (0-based) of the play: leavers gone, hires there on a role's average salary. */
export function setupInMonth(setup: CapacitySetup, play: Pick<PlayState, "leavers" | "hires">, m: number): CapacitySetup {
  const gone = new Set(play.leavers.filter((l) => l.month <= m).map((l) => l.person));
  const people: SetupPerson[] = setup.people.map((p) => (gone.has(p.id) ? { ...p, active: false } : p));
  play.hires.forEach((h, i) => {
    if (h.month > m) return;
    const same = setup.people.filter((p) => p.active && p.role_ids.includes(h.role) && p.salary_monthly !== null);
    const salary = setup.payHidden || !same.length ? null : same.reduce((s, p) => s + (p.salary_monthly ?? 0), 0) / same.length;
    people.push({
      id: playChangeId("D1", i),
      name: "New hire",
      email: null,
      active: true,
      fte: 1,
      capacity_hours_week: null,
      cost_rate: null,
      start_date: null,
      end_date: null,
      notes: null,
      reserved_share: 0,
      salary_monthly: salary,
      label: null,
      ramp: null,
      provenance: {},
      role_ids: [h.role],
      tier_ids: [],
    });
  });
  return { ...setup, people };
}

/**
 * The verdict's series and the charts' lines for one run. `model` is the model the run used (its people, for a hire's name); `result` has the monthly
 * series. Months are the run's months.
 */
export function playSeries(setup: CapacitySetup, play: Pick<PlayState, "leavers" | "hires">, model: EngineModel, result: SimulationResult, hiringDelay = DEFAULT_HIRING_DELAY_MONTHS): PlayOutcome {
  const monthly = result.monthly;
  if (!monthly) throw new Error("playSeries: the run has no monthly series");
  const n = monthly.months.length;
  const range = Array.from({ length: n }, (_, i) => i);

  // Clients: each department's services added up, and everyone once (a client taking both is in both departments).
  const servicesOf = (deptId: string) => setup.services.filter((s) => s.department_id === deptId && s.tier_id).map((s) => s.id);
  const clientsOf = (sid: string, m: number) => mean(monthly.clients[sid]?.[m]);
  const deptClients = setup.departments.map((d) => ({ id: d.id, name: d.name, values: range.map((m) => servicesOf(d.id).reduce((s, sid) => s + clientsOf(sid, m), 0)) }));
  const both = uniqueClients(setup).both;
  const clients = range.map((m) => Math.max(0, deptClients.reduce((s, d) => s + d.values[m]!, 0) - both));

  // Retainers: the engine's total for the month, shared out by clients x the average fee of each service.
  const fee = new Map(
    setup.services.map((s) => {
      const count = tierCount(s.id, setup);
      const named = setup.clients.filter((c) => c.active && c.service_ids.includes(s.id));
      const total = named.reduce((a, c) => a + c.mrr, 0) + Math.max(0, count - named.length) * s.price;
      return [s.id, count > 0 ? total / count : s.price] as const;
    }),
  );
  const weight = (sid: string, m: number) => clientsOf(sid, m) * (fee.get(sid) ?? 0);
  const retainers = range.map((m) => mean(monthly.mrr[m]));
  const deptRetainers = deptClients.map((d) => ({
    id: d.id,
    values: range.map((m) => {
      const all = setup.departments.reduce((s, x) => s + servicesOf(x.id).reduce((a, sid) => a + weight(sid, m), 0), 0);
      const mine = servicesOf(d.id).reduce((a, sid) => a + weight(sid, m), 0);
      return all > 0 ? (retainers[m]! * mine) / all : 0;
    }),
  }));

  // DLER: P5's `dler` on the people there that month, with the engine's retainers.
  const salaries = range.map((m) => dler(setupInMonth(setup, play, m)));
  const ratio = (r: number, s: number | null): number | null => (s !== null && s > 0 ? r / s : null);
  const dlerWhole = range.map((m) => ratio(retainers[m]!, salaries[m]!.whole.salaries));
  const dlerDepts: PlayLine[] = setup.departments.map((d, i) => ({
    id: d.id,
    name: d.name,
    values: range.map((m) => ratio(deptRetainers[i]!.values[m]!, salaries[m]!.departments.find((x) => x.departmentId === d.id)?.salaries ?? null)),
  }));

  // Teams over their line, and when to hire (P5).
  const advice = hiringAdvice(setup, result, hiringDelay);

  // People and their lines (P5's busy shares for those in Set up; a hire is on its role's line).
  const known = busyShares(setup, model, result).people;
  const roleLine = new Map(setup.roles.map((r) => [r.id, r.line]));
  const people: PlayPersonSeries[] = Object.entries(monthly.people).map(([id, series]) => {
    const p = known.find((k) => k.id === id);
    const mp = model.people?.[id];
    return {
      id,
      name: p?.name ?? mp?.name ?? "New hire",
      line: p?.line ?? roleLine.get(mp?.roles[0] ?? "") ?? 0.85,
      busy: range.map((m) => series[m]?.mean ?? null),
    };
  });

  const teams: PlayTeamLine[] = setup.roles
    .filter((r) => r.active !== false && monthly.roles[r.id])
    .map((r) => ({ id: r.id, name: r.name, line: r.line, values: range.map((m) => monthly.roles[r.id]![m]?.mean ?? null) }))
    .sort((a, b) => Math.max(0, ...b.values.map((v) => v ?? 0)) - Math.max(0, ...a.values.map((v) => v ?? 0)))
    .slice(0, 5);

  const lostToPrice = result.churnCauses?.causes.find((c) => c.id === "price")?.clients ?? 0;
  return {
    clients,
    retainers,
    dler: dlerWhole,
    advice,
    people,
    charts: { clients: deptClients, retainers, dler: dlerDepts, dlerWhole, teams, lostToPrice },
  };
}

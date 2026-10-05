import { describe, expect, it } from "vitest";
import { NORTHBEAM_TEAM, northbeamModel, northbeamWithClientGroups, northbeamWithClients, northbeamWithServicing, simulate, type EngineModel } from "@transpera-flow/engine";
import {
  ModelError,
  northbeamBundle,
  northbeamClientIds,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamServiceIds,
  northbeamServicingProcessIds,
  northbeamServicingStepIds,
  northbeamStepIds,
  toEngineModel,
  workingDaysBetween,
  type ProcessBundle,
  type ServiceRow,
  type StepRow,
} from "../src";

/** Swap fixture uuids back to the prototype's readable keys. */
function withKeys(model: EngineModel): EngineModel {
  const names = new Map<string, string>([
    ...Object.entries(northbeamStepIds).map(([k, v]) => [v, k] as const),
    ...Object.entries(northbeamRoleIds).map(([k, v]) => [v, k] as const),
    ...Object.entries(northbeamServiceIds).map(([k, v]) => [v, k] as const),
    ...Object.entries(northbeamClientIds).map(([k, v]) => [v, k] as const),
    ...Object.entries(northbeamServicingProcessIds).map(([k, v]) => [v, k] as const),
    ...Object.entries(northbeamServicingStepIds).map(([k, v]) => [v, k] as const),
    ...NORTHBEAM_TEAM.map(([k, name]) => [northbeamPersonIds[name]!, k] as const),
  ]);
  const key = (id: string) => names.get(id) ?? id;
  const keyed = <T>(record: Record<string, T>, value: (v: T) => T = (v) => v) =>
    Object.fromEntries(Object.entries(record).map(([id, v]) => [key(id), value(v)]));
  return {
    ...model,
    ...(model.services
      ? {
          services: keyed(model.services, (sv) => ({
            ...sv,
            ...(sv.fallbackOngoing ? { fallbackOngoing: keyed(sv.fallbackOngoing) } : {}),
            ...(sv.servicing ? { servicing: sv.servicing.map((l) => ({ ...l, process: key(l.process) })) } : {}),
          })),
        }
      : {}),
    ...(model.people ? { people: keyed(model.people, (p) => ({ ...p, roles: p.roles.map(key) })) } : {}),
    ...(model.clients
      ? {
          clients: keyed(model.clients, (c) => ({
            ...c,
            services: c.services.map(key).sort(),
            assignments: Object.fromEntries(Object.entries(c.assignments).map(([r, p]) => [key(r), key(p)])),
          })),
        }
      : {}),
    ...(model.clientGroups ? { clientGroups: keyed(model.clientGroups) } : {}),
    ...(model.servicingProcesses
      ? {
          servicingProcesses: keyed(model.servicingProcesses, (p) => ({ ...p, entry: key(p.entry), steps: p.steps.map(key) })),
        }
      : {}),
    ...(model.ends ? { ends: keyed(model.ends) } : {}),
    entry: key(model.entry),
    sinks: { won: key(model.sinks.won), lost: key(model.sinks.lost) },
    roles: Object.fromEntries(Object.entries(model.roles).map(([id, r]) => [key(id), r])),
    steps: model.steps.map((s) => ({
      ...s,
      id: key(s.id),
      role: s.role && key(s.role),
      next: s.next.map((n) => ({ ...n, to: key(n.to) })),
    })),
  };
}

const START = "2026-10-05"; // a Monday

/** Northbeam's pipeline alone: no servicing processes or links (as before issue #19). */
function pipelineOnly(): ProcessBundle {
  return { ...northbeamBundle(), servicingLinks: [], otherProcesses: [] };
}

/** Northbeam without services: none, and no condition tags (the roster stays). */
function withoutServices(): ProcessBundle {
  const b = northbeamBundle();
  return { ...b, services: [], edges: b.edges.map((e) => ({ ...e, condition_tag: null })) };
}

/** Northbeam as it was before services and the client roster: the golden prototype model. */
function beforeServicesAndClients(): ProcessBundle {
  const { overtime_cap: _cap, ...settings } = northbeamBundle().workspace.settings;
  const b = withoutServices();
  return { ...b, workspace: { ...b.workspace, settings }, clients: [], clientServices: [], clientAssignments: [] };
}

describe("toEngineModel", () => {
  it("resolves the Northbeam rows into exactly the engine's Northbeam with services, people, its client groups and servicing", () => {
    expect(withKeys(toEngineModel(northbeamBundle(), { startDate: START }))).toEqual(northbeamWithClientGroups());
  });

  it("without its client groups, the named roster applies: exactly the engine's Northbeam with its roster and servicing", () => {
    expect(withKeys(toEngineModel({ ...northbeamBundle(), clientGroups: [] }, { startDate: START }))).toEqual(northbeamWithServicing());
  });

  it("client groups replace the named roster, which stays stored but is not simulated", () => {
    const b = northbeamBundle();
    expect(b.clients).toHaveLength(26);
    const m = toEngineModel(b, { startDate: START });
    expect(m).not.toHaveProperty("clients");
    expect(m.activeClients).toBe(29);
    expect(Object.keys(m.clientGroups!)).toEqual([northbeamServiceIds.seo, northbeamServiceIds.ppc].sort());
  });

  it("ignores a group for a service the process doesn't use, and falls back to the roster when none applies", () => {
    const b = northbeamBundle();
    const m = toEngineModel({ ...b, clientGroups: [{ ...b.clientGroups![0]!, service_id: "ffffffff-0000-4000-8000-000000000000" }] }, { startDate: START });
    expect(m).not.toHaveProperty("clientGroups");
    expect(Object.keys(m.clients!)).toHaveLength(26);
  });

  it("groups that count no clients don't switch off the named roster or the interim count", () => {
    const b = northbeamBundle();
    const empty = b.clientGroups!.map((g) => ({ ...g, client_count: 0 }));
    const named = toEngineModel({ ...b, clientGroups: empty }, { startDate: START });
    expect(named).not.toHaveProperty("clientGroups");
    expect(Object.keys(named.clients!)).toHaveLength(26);
    const interim = toEngineModel({ ...b, clients: [], clientGroups: empty }, { startDate: START });
    expect(interim).not.toHaveProperty("clients");
    expect(interim.activeClients).toBe(26);
    // One counted group is enough to switch to counted clients only.
    const one = toEngineModel({ ...b, clientGroups: [b.clientGroups![0]!, { ...b.clientGroups![1]!, client_count: 0 }] }, { startDate: START });
    expect(one).not.toHaveProperty("clients");
    expect(one.activeClients).toBe(b.clientGroups![0]!.client_count);
  });

  it("without its servicing links, Northbeam resolves as before servicing: fallback load, no health-driven churn", () => {
    const b = { ...northbeamBundle(), clientGroups: [] };
    const model = withKeys(toEngineModel({ ...b, servicingLinks: [], services: b.services.map((sv) => ({ ...sv, churn_health_sensitivity: 0 })) }, { startDate: START }));
    const expected = northbeamWithClients();
    expected.services = Object.fromEntries(Object.entries(expected.services!).map(([id, sv]) => [id, { ...sv, churnSensitivity: 0 }]));
    expect(model).toEqual(expected);
  });

  it("resolves Northbeam without services or clients into exactly the golden prototype model", () => {
    const { people, ...model } = withKeys(toEngineModel(beforeServicesAndClients(), { startDate: START }));
    expect(model).toEqual(northbeamModel());
    expect(Object.keys(people!)).toHaveLength(11);
  });

  it("simulates to the same headline result as the engine fixture: strategist is the bottleneck", () => {
    // Random streams are keyed by step and client id, so uuid-keyed rows and
    // the name-keyed fixture draw different (equally valid) samples; exact
    // equality of the models is covered above.
    const res = simulate(toEngineModel(northbeamBundle(), { startDate: START }), 300, 1);
    const reference = simulate(northbeamModel(), 300, 1);
    const roster = simulate(northbeamWithServicing(), 300, 1);
    expect(res.bnRole).toBe(northbeamRoleIds.strat);
    expect(Math.abs(res.roles[northbeamRoleIds.strat]!.util - roster.roles.strat!.util)).toBeLessThan(0.01);
    expect(Math.abs(res.won - reference.won) / reference.won).toBeLessThan(0.1);
    // Services price wins at a mix-weighted 3,815 a month against the interim 3,800 retainer.
    expect(Math.abs(res.mrrAdded - reference.mrrAdded) / reference.mrrAdded).toBeLessThan(0.1);
    const svc = res.kpi.services;
    expect(Object.keys(svc).sort()).toEqual([northbeamServiceIds.seo, northbeamServiceIds.ppc].sort());
    expect(svc[northbeamServiceIds.seo]!.won.mean + svc[northbeamServiceIds.ppc]!.won.mean).toBeCloseTo(res.kpi.won.mean, 6);
  });

  it("does not depend on row order", () => {
    const shuffled = northbeamBundle();
    shuffled.steps.reverse();
    shuffled.edges.reverse();
    shuffled.roles.reverse();
    shuffled.people.reverse();
    shuffled.personRoles.reverse();
    expect(toEngineModel(shuffled, { startDate: START })).toEqual(toEngineModel(northbeamBundle(), { startDate: START }));
  });

  it("rejects a process without a start step", () => {
    const b = northbeamBundle();
    b.steps = b.steps.filter((s) => s.kind !== "start");
    expect(() => toEngineModel(b)).toThrow(ModelError);
  });

  it("rejects a working step with no way out", () => {
    const b = northbeamBundle();
    b.edges = b.edges.filter((e) => e.from_step_id !== northbeamStepIds.audit);
    expect(() => toEngineModel(b)).toThrow(/no outgoing edge/);
  });

  it("rejects edges into the start step", () => {
    const c = northbeamBundle();
    c.edges = c.edges.map((e) => (e.to_step_id === northbeamStepIds.won ? { ...e, to_step_id: northbeamStepIds.start } : e));
    expect(() => toEngineModel(c)).toThrow(/back to the start step/);
  });

  it("maps a step's SLA for breach counting, and leaves it out when blank", () => {
    const b = northbeamBundle();
    b.steps = b.steps.map((s) => (s.id === northbeamStepIds.audit ? { ...s, sla_hours: 24 } : s));
    const steps = new Map(toEngineModel(b, { startDate: START }).steps.map((s) => [s.id, s]));
    expect(steps.get(northbeamStepIds.audit)!.sla).toBe(24);
    expect(steps.get(northbeamStepIds.qualify)!).not.toHaveProperty("sla");
    const r = simulate(toEngineModel(b, { startDate: START }), 3, 1);
    expect(r.steps[northbeamStepIds.audit]!.slaBreaches).toBeGreaterThan(0);
  });

  it("maps the rules' step settings and the start step's time target, and leaves blank ones out", () => {
    const b = northbeamBundle();
    b.steps = b.steps.map((s) =>
      s.id === northbeamStepIds.audit
        ? { ...s, expected_wait_hours: 12, lost_per_day_waiting: 0.05, dropoff_benchmark: 0.3 }
        : s.id === northbeamStepIds.start
          ? { ...s, target_cycle_hours: 120 }
          : s,
    );
    const model = toEngineModel(b, { startDate: START });
    const steps = new Map(model.steps.map((s) => [s.id, s]));
    expect(steps.get(northbeamStepIds.audit)).toMatchObject({ expectedWaitHours: 12, lostPerDayWaiting: 0.05, dropoffBenchmark: 0.3 });
    expect(steps.get(northbeamStepIds.qualify)!).not.toHaveProperty("expectedWaitHours");
    expect(steps.get(northbeamStepIds.qualify)!).not.toHaveProperty("lostPerDayWaiting");
    expect(steps.get(northbeamStepIds.qualify)!).not.toHaveProperty("dropoffBenchmark");
    expect(model.targetCycleHours).toBe(120);
    expect(toEngineModel(northbeamBundle(), { startDate: START })).not.toHaveProperty("targetCycleHours");
    // They rate the report; the simulation is the same.
    expect(simulate(model, 3, 1).kpi).toEqual(simulate(toEngineModel(northbeamBundle(), { startDate: START }), 3, 1).kpi);
  });

  it("maps entered current WIP, 0 included, and leaves unentered WIP out", () => {
    const b = northbeamBundle();
    b.steps = b.steps.map((s) =>
      s.id === northbeamStepIds.audit ? { ...s, current_wip: 4 } : s.id === northbeamStepIds.onboard ? { ...s, current_wip: 0 } : s,
    );
    const steps = new Map(toEngineModel(b, { startDate: START }).steps.map((s) => [s.id, s]));
    expect(steps.get(northbeamStepIds.audit)!.currentWip).toBe(4);
    expect(steps.get(northbeamStepIds.onboard)!.currentWip).toBe(0);
    expect(steps.get(northbeamStepIds.qualify)!).not.toHaveProperty("currentWip");
    expect(simulate(toEngineModel(b, { startDate: START }), 3, 1).initialState).toEqual({ kind: "wip", items: 4 });
    expect(simulate(toEngineModel(northbeamBundle(), { startDate: START }), 3, 1).initialState.kind).toBe("warmup");
  });

  it("maps each step's time distributions, leaving untouched lognormal steps on the engine default", () => {
    const b = northbeamBundle();
    b.steps = b.steps.map((s) =>
      s.id === northbeamStepIds.audit
        ? { ...s, work_dist: "triangular", work_params: { min: 4, mode: 5, max: 12 }, wait_dist: "constant" }
        : s.id === northbeamStepIds.onboard
          ? { ...s, work_params: { cv: 0.8 }, wait_dist: "triangular", wait_params: { min: 5, mode: 1 } }
          : s,
    );
    const steps = new Map(toEngineModel(b, { startDate: START }).steps.map((s) => [s.id, s]));
    expect(steps.get(northbeamStepIds.audit)!.workDist).toEqual({ kind: "triangular", min: 4, mode: 5, max: 12 });
    expect(steps.get(northbeamStepIds.audit)!.waitDist).toEqual({ kind: "constant" });
    expect(steps.get(northbeamStepIds.onboard)!.workDist).toEqual({ kind: "lognormal", cv: 0.8 });
    // An inconsistent range falls back to one around the mean (16 h wait).
    expect(steps.get(northbeamStepIds.onboard)!.waitDist).toEqual({ kind: "triangular", min: 8, mode: 16, max: 24 });
    expect(steps.get(northbeamStepIds.qualify)!).not.toHaveProperty("workDist");
    expect(steps.get(northbeamStepIds.qualify)!).not.toHaveProperty("waitDist");
    expect(simulate(toEngineModel(b, { startDate: START }), 3, 1).kpi.won.mean).toBeGreaterThan(0);
  });
});

/** An end step row in `b`'s revision. */
function endStep(b: ProcessBundle, id: string, name: string, outcome: StepRow["outcome"]): StepRow {
  const lost = b.steps.find((s) => s.id === northbeamStepIds.lost)!;
  return { ...lost, id, name, outcome };
}

describe("end steps", () => {
  const DONE = "e0000000-0000-4000-8000-0000000000d1";
  const WON2 = "e0000000-0000-4000-8000-0000000000d2";
  const LOST2 = "e0000000-0000-4000-8000-0000000000d3";

  it("simulates edges into a 'done' end", () => {
    const b = pipelineOnly();
    b.steps = b.steps.map((s) => (s.id === northbeamStepIds.lost ? { ...s, outcome: "done" } : s));
    const model = toEngineModel(b, { startDate: START });
    // No lost end is left, so the lost sink is a placeholder and the old lost end is a 'done' end.
    expect(model.sinks).toEqual({ won: northbeamStepIds.won, lost: "__lost__" });
    expect(model.ends).toEqual({ [northbeamStepIds.lost]: { outcome: "done" } });
    const res = simulate(model, 5, 1);
    expect(res.kpi.done.mean).toBeGreaterThan(0);
    expect(res.kpi.lost.mean).toBe(0);
    expect(res.kpi.lostRevenue.mean).toBe(0);
  });

  it("keeps the first won and lost ends (by id) as sinks and maps extra ends to `ends`", () => {
    const b = pipelineOnly();
    b.steps = [
      ...b.steps,
      endStep(b, DONE, "Referred on", "done"),
      endStep(b, WON2, "Won (fast)", "won"),
      endStep(b, LOST2, "Lost (late)", "lost"),
    ];
    const edge = b.edges.find((e) => e.from_step_id === northbeamStepIds.qualify && e.to_step_id === northbeamStepIds.lost)!;
    b.edges = b.edges.map((e) => (e.id === edge.id ? { ...e, probability: 0.15 } : e));
    b.edges.push(
      { ...edge, id: "f0000000-0000-4000-8000-0000000000d1", to_step_id: DONE, probability: 0.1 },
      { ...edge, id: "f0000000-0000-4000-8000-0000000000d2", to_step_id: WON2, probability: 0.1 },
      { ...edge, id: "f0000000-0000-4000-8000-0000000000d3", to_step_id: LOST2, probability: 0.1 },
    );
    const model = toEngineModel(b, { startDate: START });
    expect(model.sinks).toEqual({ won: northbeamStepIds.won, lost: northbeamStepIds.lost });
    expect(model.ends).toEqual({
      [DONE]: { outcome: "done" },
      [WON2]: { outcome: "won" },
      [LOST2]: { outcome: "lost" },
    });
    const res = simulate(model, 5, 1);
    expect(res.kpi.done.mean).toBeGreaterThan(0);
    // Fast wins straight from qualify (0.7 a week) outnumber the whole pipeline's.
    const before = simulate(toEngineModel(pipelineOnly(), { startDate: START }), 5, 1);
    expect(res.kpi.won.mean).toBeGreaterThan(before.kpi.won.mean);
  });

  it("orders sinks by id, not row order", () => {
    const b = pipelineOnly();
    // An id sorting before the seeded won end becomes the sink; the seeded one moves to `ends`.
    const early = "e0000000-0000-4000-8000-000000000000";
    b.steps = [...b.steps, endStep(b, early, "Won early", "won")];
    const model = toEngineModel(b, { startDate: START });
    expect(model.sinks.won).toBe(early);
    expect(model.ends).toEqual({ [northbeamStepIds.won]: { outcome: "won" } });
    b.steps.reverse();
    expect(toEngineModel(b, { startDate: START })).toEqual(model);
  });

  it("adds no `ends` when the process has one won and one lost end", () => {
    expect(toEngineModel(pipelineOnly(), { startDate: START })).not.toHaveProperty("ends");
  });
});

describe("services", () => {
  const seo = northbeamServiceIds.seo;
  const ppc = northbeamServiceIds.ppc;
  const kickoffEdges = (m: EngineModel) => m.steps.find((s) => s.id === northbeamStepIds.kickoff)!.next;
  const patch = (b: ProcessBundle, id: string, change: Partial<ServiceRow>) => {
    b.services = b.services.map((sv) => (sv.id === id ? { ...sv, ...change } : sv));
    return b;
  };

  it("maps each service's pricing, tenure, churn, mix and path tags", () => {
    const model = toEngineModel(pipelineOnly(), { startDate: START });
    expect(model.services).toEqual({
      [seo]: {
        name: "SEO retainer",
        pricingModel: "retainer",
        price: 3500,
        margin: 0.45,
        tenureMonths: 18,
        churnMonthly: 0.03,
        churnSensitivity: 3,
        mixShare: 0.55,
        pathTags: ["seo"],
        fallbackOngoing: { [northbeamRoleIds.strat]: 1.5, [northbeamRoleIds.am]: 6, [northbeamRoleIds.seo]: 16, [northbeamRoleIds.fin]: 1.2 },
      },
      [ppc]: {
        name: "PPC management",
        pricingModel: "retainer",
        price: 4200,
        margin: 0.4,
        tenureMonths: 12,
        churnMonthly: 0.04,
        churnSensitivity: 3,
        mixShare: 0.45,
        pathTags: ["ppc"],
        fallbackOngoing: { [northbeamRoleIds.strat]: 1.5, [northbeamRoleIds.am]: 6, [northbeamRoleIds.ppc]: 19, [northbeamRoleIds.fin]: 1.2 },
      },
    });
    // Entering this process means entering at its entry step: the engine's default.
    expect(Object.values(model.services!).every((sv) => !("entry" in sv))).toBe(true);
  });

  it("maps numeric columns that arrive as strings (Postgres numeric) and trims tags", () => {
    const b = patch(northbeamBundle(), seo, {
      price: "3500.00" as unknown as number,
      mix_share: "0.55" as unknown as number,
      path_tags: [" seo ", ""],
    });
    const sv = toEngineModel(b, { startDate: START }).services![seo]!;
    expect(sv.price).toBe(3500);
    expect(sv.mixShare).toBe(0.55);
    expect(sv.pathTags).toEqual(["seo"]);
  });

  it("maps edge condition tags when there are services, and routes each service down its own branch", () => {
    const model = toEngineModel(northbeamBundle(), { startDate: START });
    expect(kickoffEdges(model)).toEqual([
      { to: northbeamStepIds.seo, p: 0.55, tag: "seo" },
      { to: northbeamStepIds.ppc, p: 0.45, tag: "ppc" },
    ]);
    const res = simulate(model, 5, 1);
    const kicked = res.trace!.filter((e) => e.trace.some((s) => s.step === northbeamStepIds.kickoff && s.tL !== null));
    expect(kicked.length).toBeGreaterThan(3);
    for (const e of kicked) {
      const after = e.trace[e.trace.findIndex((s) => s.step === northbeamStepIds.kickoff && s.tL !== null) + 1];
      if (after) expect(after.step).toBe(e.service === seo ? northbeamStepIds.seo : northbeamStepIds.ppc);
    }
  });

  it("leaves tags out, and prices wins at the interim retainer, when there are no services", () => {
    const b = northbeamBundle();
    b.services = [];
    const model = toEngineModel(b, { startDate: START });
    expect(model).not.toHaveProperty("services");
    expect(kickoffEdges(model).every((e) => !("tag" in e))).toBe(true);
    expect(model).toEqual(toEngineModel(withoutServices(), { startDate: START }));
  });

  it("leaves out inactive services and services entering another process", () => {
    const other = "c0000000-0000-4000-8000-0000000000ff";
    const b = patch(patch(northbeamBundle(), seo, { active: false }), ppc, { entry_process_id: other });
    // The only active service's leads go to the other process, so none arrive here (issue #13).
    expect(toEngineModel(b, { startDate: START })).toEqual({ ...toEngineModel(withoutServices(), { startDate: START }), leadsPerWeek: 0 });
    const c = patch(northbeamBundle(), ppc, { entry_process_id: null });
    expect(Object.keys(toEngineModel(c, { startDate: START }).services!)).toEqual([seo, ppc]);
  });

  it("rejects a mix that adds up to nothing", () => {
    const b = patch(patch(northbeamBundle(), seo, { mix_share: 0 }), ppc, { mix_share: 0 });
    expect(() => toEngineModel(b)).toThrow(ModelError);
    expect(() => toEngineModel(b)).toThrow(/mix shares add up to 0/);
  });

  it("does not depend on service row order", () => {
    const b = northbeamBundle();
    b.services.reverse();
    expect(toEngineModel(b, { startDate: START })).toEqual(toEngineModel(northbeamBundle(), { startDate: START }));
  });
});

describe("people", () => {
  const maya = northbeamPersonIds["Maya Collins"]!;
  const priya = northbeamPersonIds["Priya Shah"]!;

  it("maps each person to their roles and full-time capacity", () => {
    const people = toEngineModel(northbeamBundle(), { startDate: START }).people!;
    expect(people[maya]).toEqual({ name: "Maya Collins", roles: [northbeamRoleIds.strat], capacity: 40 });
    const perRole = Object.values(people).reduce<Record<string, number>>((acc, p) => {
      for (const r of p.roles) acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    }, {});
    for (const role of northbeamBundle().roles) expect(perRole[role.id]).toBe(role.headcount);
  });

  it("derives capacity from FTE unless hours are set", () => {
    const b = northbeamBundle();
    b.people = b.people.map((p) => (p.id === maya ? { ...p, fte: 0.6 } : p.id === priya ? { ...p, capacity_hours_week: 30 } : p));
    const people = toEngineModel(b, { startDate: START }).people!;
    expect(people[maya]!.capacity).toBe(24);
    expect(people[priya]!.capacity).toBe(30);
  });

  it("leaves out inactive people and anyone not employed on the start date", () => {
    const b = northbeamBundle();
    const [a, c, d] = [priya, northbeamPersonIds["Tom Reed"]!, northbeamPersonIds["Rosa Diaz"]!];
    b.people = b.people.map((p) =>
      p.id === a ? { ...p, active: false } : p.id === c ? { ...p, start_date: "2026-11-01" } : p.id === d ? { ...p, end_date: "2026-10-01" } : p,
    );
    const people = toEngineModel(b, { startDate: START }).people!;
    expect(Object.keys(people)).toHaveLength(8);
    expect(people[a] ?? people[c] ?? people[d]).toBeUndefined();
  });

  it("for the forecast, brings planned hires in on their start date and takes people out after their end date (issue #35)", () => {
    const b = northbeamBundle();
    const [hire, leaver, gone] = [northbeamPersonIds["Tom Reed"]!, northbeamPersonIds["Rosa Diaz"]!, priya];
    b.people = b.people.map((p) =>
      // Start: Monday 2 November, 20 working days in. End: Friday 16 October, so gone from 9 working days in.
      p.id === hire ? { ...p, start_date: "2026-11-02" } : p.id === leaver ? { ...p, end_date: "2026-10-16" } : p.id === gone ? { ...p, end_date: "2026-10-01" } : p,
    );
    const people = toEngineModel(b, { startDate: START, planned: true }).people!;
    expect(people[hire]!.from).toBe(20 * 8);
    expect(people[hire]!.until).toBeUndefined();
    expect(people[leaver]!.until).toBe(10 * 8);
    expect(people[leaver]!.from).toBeUndefined();
    // Gone before the run starts: not there at all, as without planning.
    expect(people[gone]).toBeUndefined();
    // Without `planned`, nothing changes: the hire isn't there yet and the leaver is there for the whole run.
    const today = toEngineModel(b, { startDate: START }).people!;
    expect(today[hire]).toBeUndefined();
    expect(today[leaver]).toEqual({ name: people[leaver]!.name, roles: people[leaver]!.roles, capacity: people[leaver]!.capacity });
  });

  it("falls back to role head-counts when the workspace has no people", () => {
    const b = northbeamBundle();
    b.people = [];
    expect(toEngineModel(b, { startDate: START }).people).toBeUndefined();
  });

  it("converts leave dates to working hours from the start date", () => {
    expect(workingDaysBetween("2026-10-05", "2026-10-12")).toBe(5);
    expect(workingDaysBetween("2026-10-05", "2026-10-05")).toBe(0);
    const b = northbeamBundle();
    // Thursday to the following Tuesday inclusive: 4 working days, starting 3 working days in.
    b.personLeave = [{ id: "l1", person_id: maya, workspace_id: b.workspace.id, start_date: "2026-10-08", end_date: "2026-10-13" }];
    expect(toEngineModel(b, { startDate: START }).people![maya]!.leave).toEqual([[24, 56]]);
  });

  it("clips leave that started before the run and drops leave that already ended", () => {
    const b = northbeamBundle();
    b.personLeave = [
      { id: "l1", person_id: maya, workspace_id: b.workspace.id, start_date: "2026-09-28", end_date: "2026-10-06" },
      { id: "l2", person_id: maya, workspace_id: b.workspace.id, start_date: "2026-09-01", end_date: "2026-09-02" },
    ];
    expect(toEngineModel(b, { startDate: START }).people![maya]!.leave).toEqual([[0, 16]]);
  });

  it("limits skills to this process's steps", () => {
    const b = northbeamBundle();
    b.personSkills = [
      { person_id: priya, step_id: northbeamStepIds.discovery, workspace_id: b.workspace.id },
      { person_id: priya, step_id: "00000000-0000-4000-8000-00000000ffff", workspace_id: b.workspace.id },
    ];
    expect(toEngineModel(b, { startDate: START }).people![priya]!.skills).toEqual([northbeamStepIds.discovery]);
  });

  it("passes a step's pinned person and the workspace availability floor to the engine", () => {
    const b = northbeamBundle();
    b.steps = b.steps.map((st) => (st.id === northbeamStepIds.audit ? { ...st, person_id: maya } : st));
    b.workspace.settings = { ...b.workspace.settings, availability_floor: 0.12 };
    const model = toEngineModel(b, { startDate: START });
    expect(model.steps.find((st) => st.id === northbeamStepIds.audit)!.person).toBe(maya);
    expect(model.availabilityFloor).toBe(0.12);
  });
});

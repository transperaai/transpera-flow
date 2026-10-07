import { PLACEHOLDER_PREFIX, type Row, type WORKSPACE_IMPORT_LIMITS } from "../src";

// A synthetic restore plan with `L` rows of everything: the limits (every section at its cap), or fewer. Shared by the
// performance and export tests of B21 (issue #203, packages/db/test/workspace-import-large.test.ts). Pure; no database.

export type Limits = Record<keyof typeof WORKSPACE_IMPORT_LIMITS, number>;

export interface SyntheticOptions {
  /**
   * The plan will be restored and then exported again: leave out the four library scenarios the new workspace already has
   * (they come back in its export and count towards the scenario limit), so the export lands exactly at the limit.
   */
  forExport?: boolean;
}

const when = "2026-01-01T00:00:00Z";

/**
 * How `total` rows of the eight small company-model tables split, within what the database allows: 12 seasonality months, at most 25
 * custom churn drivers (a trigger), at most 24 schedule changes (one a month over 24 months, and they can't overlap), a client group
 * and a servicing rule for each service; the rest is services, market conditions and lead sources. The parts add up to `total`.
 */
export function otherShape(total: number) {
  const seasonality = Math.min(12, total);
  const churnDrivers = Math.min(25, Math.floor(total / 10));
  const marketSchedule = Math.min(24, Math.floor(total / 10));
  const rest = total - seasonality - churnDrivers - marketSchedule;
  const services = Math.floor(rest / 5);
  const marketConditions = services;
  const leadSources = rest - 3 * services - marketConditions;
  return { seasonality, churnDrivers, marketSchedule, services, clientGroups: services, serviceServicing: services, marketConditions, leadSources };
}

/** The rows of every section at the limit L, as the planner makes them (placeholder ids, only the columns the restore accepts). */
export function syntheticPlan(L: Limits, options: SyntheticOptions = {}) {
  const id = (n: number) => `${PLACEHOLDER_PREFIX}${n.toString(16).padStart(12, "0")}`;
  let next = 1;
  const mk = () => id(next++);
  const role = mk();
  const roles = [{ id: role, name: "Role", color: "#336699", created_at: when }, ...[1, 2].map((i) => ({ id: mk(), name: `Role ${i}`, color: "#336699", created_at: when }))];
  const people = Array.from({ length: L.people }, (_, i) => ({ id: mk(), name: `Person ${i}`, created_at: when }));
  const clients = Array.from({ length: L.clients }, (_, i) => ({ id: mk(), name: `Client ${i}`, created_at: when }));

  // Sources first: some steps cite them, so `link_cited_sources` runs for them as the steps are written.
  const sourceIds = Array.from({ length: L.sources }, () => mk());
  const sources = sourceIds.map((sid, i) => ({ id: sid, kind: "notes", title: `Source ${i}`, body: "x".repeat(Math.floor(L.sourceChars / L.sources)), created_at: when }));

  const stepsPer = Math.floor(L.steps / L.processes);
  const edgesPer = Math.floor(L.edges / L.processes);
  // The processes. Every fourth one (from the second) is a servicing process, which the servicing rules and the holder step use.
  const kindOf = (p: number) => (p % 4 === 1 ? "servicing" : "pipeline");
  const processIds = Array.from({ length: L.processes }, () => mk());
  // The (source, process, step) a step's evidence cites: the database links each (`link_cited_sources`), so the plan holds the same links.
  const cites: { sid: string; pid: string; step: string }[] = [];
  const processes = processIds.map((pid, p) => {
    const stepIds = Array.from({ length: stepsPer }, () => mk());
    const holder = p === 0; // one holder step: process 0 holds process 1 (a servicing process)
    const steps: Row[] = stepIds.map((sid, i) => {
      const last = i === stepsPer - 1;
      const step: Row = {
        id: sid, name: `S${i}`, kind: i === 0 ? "start" : last ? "end" : "task", outcome: last ? "done" : null, work_hours: 1, wait_hours: 0, rework_rate: 0, x: i * 10, y: 0,
        role_id: i > 0 && !last ? role : null, provenance: {},
      };
      if (holder && i === 1) Object.assign(step, { kind: "subprocess", work_hours: 0, role_id: null, child_process_id: processIds[1] });
      else if (i > 0 && !last && p % 3 === 0) step.person_id = people[(p * stepsPer + i) % people.length]!.id;
      // Evidence that cites a source, on some: `link_cited_sources` links the step to it.
      if (i === 1 && p % 2 === 0 && !holder) {
        step.provenance = { work_hours: { evidence: [{ source_id: sourceIds[p % sourceIds.length] }] } };
        cites.push({ sid: sourceIds[p % sourceIds.length]!, pid, step: sid });
      }
      return step;
    });
    // `edgesPer` edges, 9 chain edges and the rest skipping ahead by 2, 3 and 4 steps.
    const edges: Row[] = [];
    for (let i = 0; i + 1 < stepsPer; i++) edges.push({ id: mk(), from_step_id: stepIds[i], to_step_id: stepIds[i + 1], probability: 1 });
    for (const skip of [2, 3, 4]) {
      for (let i = 0; edges.length < edgesPer && i + skip < stepsPer; i++) edges.push({ id: mk(), from_step_id: stepIds[i], to_step_id: stepIds[i + skip], probability: 0 });
    }
    const first_principles = { job_who: `Who ${p}`, job_progress: "Progress", job_situation: "Situation", job_done: "Done", statements: [], requirements: [], deletes: [], improvements: [], measures: [], why_problem: "", why_chain: [], root_cause: "" };
    return { id: pid, parent_process_id: null, name: `Process ${p}`, kind: kindOf(p), entity_name: "item", description: null, archived: p % 20 === 0 && p > 1, layout: {}, steps, edges, first_principles };
  });

  const issues = Array.from({ length: L.issues }, (_, i) => ({
    id: mk(), type: "idea", title: `Issue ${i}`, created_at: when, source: "manual", status: "open",
    links: [{ process_id: processes[i % processes.length]!.id, step_id: processes[i % processes.length]!.steps[1]!.id }], owner_ids: [people[i % people.length]!.id], source_ids: [sourceIds[i % sourceIds.length]],
  }));
  const scenarioCount = options.forExport ? L.scenarios - 4 : L.scenarios;
  const scenarios = Array.from({ length: scenarioCount }, (_, i) => ({ id: mk(), name: `Scenario ${i}`, patch: [{ path: "demand.leads_per_week", op: "multiply", value: 1 + i / 1000 }], created_at: when }));
  const blocks = Array.from({ length: L.blocks }, (_, i) => ({ id: mk(), name: `Block ${i}`, type: "manual", steps: { steps: [], edges: [] }, created_at: when }));
  const suggestions = Array.from({ length: L.suggestions }, (_, i) => ({ id: mk(), target_table: "people", target_id: people[i % people.length]!.id, patch: { set: { notes: `n${i}` } }, evidence: [], note: null, created_at: when }));
  const proposals = Array.from({ length: L.proposals }, (_, i) => ({ id: mk(), kind: "issue", title: `Proposal ${i}`, detail: "d", payload: {}, evidence: [], created_at: when }));

  // The link tables, each at its limit: 3 roles a person, 10 skills a person, one assignment a client.
  const person_roles = people.flatMap((p) => roles.map((r) => ({ person_id: p.id, role_id: r.id, created_at: when }))).slice(0, L.personRoles);
  const allSteps = processes.flatMap((p) => p.steps.map((st) => st.id));
  const person_skills = people.flatMap((p, i) => Array.from({ length: 10 }, (_, k) => ({ person_id: p.id, step_id: allSteps[(i * 10 + k) % allSteps.length], efficiency: 1, created_at: when }))).slice(0, L.personSkills);
  // Per-person times (#228), exactly at the limit: one "Every step" a person (round 0), then one time on a step a person (round 1, 2, ...), each round on
  // a different step for the same person, so no (person, step) pair repeats. Whole rounds first, so the people with the most times have the same count +/- 1.
  const person_capacity_factors: Row[] = [];
  for (let round = 0; person_capacity_factors.length < L.capacityFactors && round <= allSteps.length; round++) {
    for (let i = 0; i < people.length && person_capacity_factors.length < L.capacityFactors; i++) {
      person_capacity_factors.push({ person_id: people[i]!.id, step_id: round === 0 ? null : allSteps[(i + round - 1) % allSteps.length], factor: round === 0 ? 0.9 : Number((0.8 + ((i + round) % 10) / 20).toFixed(2)), provenance: {} });
    }
  }
  const client_assignments = clients.map((c, i) => ({ client_id: c.id, role_id: role, person_id: people[i % people.length]!.id, created_at: when })).slice(0, L.clientAssignments);
  // Source links of every kind: one `issue` link per issue (its one source, which `link_issue_source` makes anyway, so the row is
  // counted once), then `process` and `step` links in equal parts for the rest.
  const issueLinks = issues.map((i) => ({ id: mk(), source_id: (i.source_ids as string[])[0]!, kind: "issue", issue_id: i.id }));
  const rest = Math.max(0, L.sourceLinks - issueLinks.length);
  const stepLinks: Row[] = cites.map((c) => ({ id: mk(), source_id: c.sid, kind: "step", process_id: c.pid, step_id: c.step }));
  const processLinks: Row[] = [];
  const seenStep = new Set<string>(cites.map((c) => `${c.sid}|${c.step}`));
  const seenProcess = new Set<string>();
  // Distinct (source, process) and (source, step) pairs: walk the sources and then the processes, so no pair repeats.
  for (let k = 0; stepLinks.length + processLinks.length < rest; k++) {
    const sid = sourceIds[k % sourceIds.length]!;
    const proc = processes[Math.floor(k / sourceIds.length) % processes.length]!;
    if (k % 2 === 0) {
      const key = `${sid}|${proc.id}`;
      if (seenProcess.has(key)) continue;
      seenProcess.add(key);
      processLinks.push({ id: mk(), source_id: sid, kind: "process", process_id: proc.id });
    } else {
      const step = proc.steps[2 + (Math.floor(k / (2 * sourceIds.length)) % (stepsPer - 4))]!;
      const key = `${sid}|${step.id}`;
      if (seenStep.has(key)) continue;
      seenStep.add(key);
      stepLinks.push({ id: mk(), source_id: sid, kind: "step", process_id: proc.id, step_id: step.id });
    }
  }
  const source_links = [...issueLinks, ...processLinks, ...stepLinks].slice(0, L.sourceLinks);

  const leaveDay = (n: number) => new Date(Date.UTC(2027, 0, 1 + n)).toISOString().slice(0, 10);
  const person_leave = Array.from({ length: L.personLeave }, (_, i) => {
    const turn = Math.floor(i / people.length);
    return { id: mk(), person_id: people[i % people.length]!.id, start_date: leaveDay(turn * 3), end_date: leaveDay(turn * 3 + 1), note: null, created_at: when };
  });

  // The eight small company-model sections, counted together to exactly `companyOther`, in the shape the database allows (see `otherShape`).
  const o = otherShape(L.companyOther);
  const seasonality = Array.from({ length: o.seasonality }, (_, i) => ({ id: mk(), month: i + 1, multiplier: 1 + i / 100, created_at: when }));
  // A service's entry process can't be archived.
  const entryProcesses = processes.filter((p) => p.kind === "pipeline" && !p.archived);
  const services = Array.from({ length: o.services }, (_, i) => ({ id: mk(), name: `Service ${i}`, entry_process_id: entryProcesses[i % entryProcesses.length]!.id, created_at: when }));
  const servicingProcesses = processes.filter((p) => p.kind === "servicing");
  const client_groups = services.map((s, i) => ({ id: mk(), service_id: s.id, client_count: 5 + (i % 5), churn_monthly: 0.02, fee: 100, starting_health: 80, stay_months: 12, created_at: when }));
  const service_servicing = services.map((s, i) => ({ id: mk(), service_id: s.id, process_id: servicingProcesses[i % servicingProcesses.length]!.id, recurrence: { every: "month", times: 1 }, sla_hours: 40, created_at: when }));
  const market_conditions = Array.from({ length: o.marketConditions }, (_, i) => ({ id: mk(), name: `Market ${i}`, leads: 100 + (i % 20), conv: 100, cycle: 100, price: 100, churn: 100, hire: 100, pay: 100, created_at: when }));
  // One change a month (a schedule can't overlap itself); the first points at a preset the new workspace already has.
  const market_schedule = Array.from({ length: o.marketSchedule }, (_, i) =>
    i === 0 ? { id: mk(), condition_preset: "boom", from_month: 1, to_month: 1, created_at: when } : { id: mk(), condition_id: market_conditions[i % market_conditions.length]!.id, from_month: i + 1, to_month: i + 1, created_at: when },
  );
  const churn_drivers = Array.from({ length: o.churnDrivers }, (_, i) => ({ id: mk(), name: `Churn driver ${i}`, description: "d", example: "e", weight: 1, enabled: true, created_at: when }));
  const lead_sources = Array.from({ length: o.leadSources }, (_, i) => ({ id: mk(), name: `Lead source ${i}`, volume_week: 5, conversion_to_qualified: 0.5, created_at: when }));
  // One service for each client, cycling over the services.
  const client_services = clients.map((c, i) => ({ client_id: c.id, service_id: services[i % services.length]!.id, start_date: "2026-01-01", created_at: when })).slice(0, L.clientServices);

  return {
    format: "transpera-workspace-import/1",
    settings: { hours_per_week: 38, currency: "GBP" },
    roles, people, person_roles, person_leave, lead_sources, seasonality, demand_settings: { growth_monthly: 0.01, created_at: when }, churn_drivers,
    market_conditions, market_schedule, lever_settings: { hidden: [], created_at: when }, analysis_rules: { settings: {}, created_at: when }, clients, sources, processes, scenarios, blocks, issues, services,
    service_servicing, client_groups, client_services, client_assignments, person_skills, person_capacity_factors, source_links, suggestions, proposals,
  };
}

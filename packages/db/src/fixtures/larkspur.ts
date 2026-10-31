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
  LARKSPUR_TEAM,
  larkspurClientKey,
  type LarkspurDist,
  type LarkspurEdge,
  type LarkspurStep,
} from "@transpera-flow/engine/larkspur-data";
import type {
  ClientAssignmentRow,
  ClientRow,
  ClientServiceRow,
  DistParams,
  Distribution,
  EdgeRow,
  PersonLeaveRow,
  PersonRoleRow,
  PersonRow,
  PersonSkillRow,
  ProcessBundle,
  ProcessPart,
  ProcessRow,
  Provenance,
  RoleRow,
  ServiceRow,
  ServiceServicingRow,
  StepRow,
} from "../types";

// Larkspur Creative, the second golden agency (docs/PRD.md §6.9 layer 3;
// issue #22), as database rows: the engine's larkspurModel() once resolved on
// LARKSPUR_START (the check is in test/model.test.ts). Ids are fixed and sort
// in the data's order; they share Northbeam's per-table prefixes (see
// northbeam.ts) with 8001 in the fourth group, plus 0 for leave and
// seasonality rows.

const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8001-${n.toString(16).padStart(12, "0")}`;

export const LARKSPUR_WORKSPACE_ID = id("a", 1);
export const LARKSPUR_PROCESS_ID = id("c", 1);
export const LARKSPUR_REVISION_ID = id("d", 1);

const ws = LARKSPUR_WORKSPACE_ID;

export const larkspurRoleIds: Record<string, string> = Object.fromEntries(LARKSPUR_ROLES.map(([key], i) => [key, id("b", i + 1)]));
export const larkspurPersonIds: Record<string, string> = Object.fromEntries(LARKSPUR_TEAM.map((p, i) => [p.key, id("9", i + 1)]));
export const larkspurServiceIds: Record<string, string> = Object.fromEntries(LARKSPUR_SERVICES.map((sv, i) => [sv.key, id("8", i + 1)]));
/** Client ids by the engine model's keys ("l01" …). */
export const larkspurClientIds: Record<string, string> = Object.fromEntries(LARKSPUR_ROSTER.map((_, i) => [larkspurClientKey(i), id("2", i + 1)]));
/** Process ids: the pipeline, then the servicing processes by key. */
export const larkspurProcessIds: Record<string, string> = {
  pipeline: LARKSPUR_PROCESS_ID,
  ...Object.fromEntries(LARKSPUR_SERVICING.map((p, i) => [p.key, id("c", i + 2)])),
};
/** Step ids by key, pipeline first, each process's steps in the data's order. */
export const larkspurStepIds: Record<string, string> = Object.fromEntries(
  [...LARKSPUR_PIPELINE.steps, ...LARKSPUR_SERVICING.flatMap((p) => p.steps)].map((s, i) => [s.key, id("e", i + 1)]),
);

const ESTIMATE: Provenance = { source: "estimated", at: "2026-09-30T00:00:00Z", note: "Larkspur sample data" };
const ENTERED: Provenance = { source: "entered", at: "2026-09-30T00:00:00Z", note: "Larkspur sample data" };

function stored(dist: LarkspurDist | undefined): { dist: Distribution; params: DistParams } {
  if (!dist) return { dist: "lognormal", params: {} };
  if (dist.kind === "lognormal") return { dist: "lognormal", params: { cv: dist.cv } };
  if (dist.kind === "constant") return { dist: "constant", params: {} };
  return { dist: "triangular", params: { min: dist.min, mode: dist.mode, max: dist.max } };
}

let edgeNo = 0;

function part(process: ProcessRow, revisionId: string, steps: LarkspurStep[], edges: LarkspurEdge[]): ProcessPart {
  const base = { revision_id: revisionId, workspace_id: ws, process_id: process.id };
  return {
    process,
    revision: { id: revisionId, workspace_id: ws, process_id: process.id, number: 1, status: "published" },
    steps: steps.map((s): StepRow => {
      const work = stored(s.workDist);
      const wait = stored(s.waitDist);
      return {
        id: larkspurStepIds[s.key]!,
        ...base,
        name: s.name,
        kind: s.kind,
        outcome: s.kind === "end" ? (s.outcome ?? "done") : null,
        role_id: s.role ? larkspurRoleIds[s.role]! : null,
        person_id: s.person ? larkspurPersonIds[s.person]! : null,
        work_hours: s.work,
        work_dist: work.dist,
        work_params: work.params,
        wait_hours: s.wait,
        wait_dist: wait.dist,
        wait_params: wait.params,
        rework_rate: s.rework,
        rework_to_step_id: null,
        tool: s.tool,
        purpose: null,
        split: null,
        split_notes: null,
        tier_multiplier: null,
        to_client_manager: false,
        notes: null,
        sla_hours: s.sla ?? null,
        expected_wait_hours: null,
        lost_per_day_waiting: null,
        dropoff_benchmark: null,
        target_cycle_hours: null,
        current_wip: s.currentWip ?? null,
        parent_step_id: null,
        entry_step_id: null,
        child_process_id: null,
        x: s.x,
        y: s.y,
        assumption: false,
        conflict: false,
        provenance: {},
      };
    }),
    edges: edges.map(
      ([from, to, probability, tag]): EdgeRow => ({
        id: id("f", ++edgeNo),
        ...base,
        from_step_id: larkspurStepIds[from]!,
        to_step_id: larkspurStepIds[to]!,
        probability,
        condition_tag: tag,
        label: null,
      }),
    ),
  };
}

function people(): { people: PersonRow[]; personRoles: PersonRoleRow[]; personSkills: PersonSkillRow[]; personLeave: PersonLeaveRow[] } {
  let leaveNo = 0;
  return {
    people: LARKSPUR_TEAM.map((p) => ({
      id: larkspurPersonIds[p.key]!,
      workspace_id: ws,
      name: p.name,
      fte: p.fte,
      capacity_hours_week: p.hours ?? null,
      cost_rate: p.cost ?? null,
      active: true,
      start_date: null,
      end_date: null,
    })),
    personRoles: LARKSPUR_TEAM.flatMap((p) =>
      p.roles.map((r) => ({ person_id: larkspurPersonIds[p.key]!, role_id: larkspurRoleIds[r]!, workspace_id: ws })),
    ),
    personSkills: LARKSPUR_TEAM.flatMap((p) =>
      (p.skills ?? []).map((s) => ({ person_id: larkspurPersonIds[p.key]!, step_id: larkspurStepIds[s]!, workspace_id: ws })),
    ),
    personLeave: LARKSPUR_TEAM.flatMap((p) =>
      (p.leave ?? []).map((l) => ({ id: id("0", ++leaveNo), person_id: larkspurPersonIds[p.key]!, workspace_id: ws, start_date: l.start, end_date: l.end })),
    ),
  };
}

function services(): ServiceRow[] {
  return LARKSPUR_SERVICES.map((sv) => ({
    id: larkspurServiceIds[sv.key]!,
    workspace_id: ws,
    name: sv.name,
    pricing_model: sv.pricingModel,
    price: sv.price,
    price_low: null,
    price_high: null,
    margin: sv.margin,
    tenure_months: sv.tenureMonths,
    churn_monthly_base: sv.churnMonthly,
    churn_health_sensitivity: sv.churnSensitivity,
    mix_share: sv.mixShare,
    entry_process_id: LARKSPUR_PROCESS_ID,
    path_tags: [sv.key],
    fallback_ongoing_load: Object.fromEntries(Object.entries(sv.fallback).map(([role, hours]) => [larkspurRoleIds[role]!, hours])),
    active: true,
  }));
}

function servicingLinks(): ServiceServicingRow[] {
  let linkNo = 0;
  return LARKSPUR_SERVICES.flatMap((sv) =>
    sv.servicing.map(([process, recurrence, sla]) => ({
      id: id("1", ++linkNo),
      workspace_id: ws,
      service_id: larkspurServiceIds[sv.key]!,
      process_id: larkspurProcessIds[process]!,
      recurrence: "poissonPerMonth" in recurrence ? { poisson_per_month: recurrence.poissonPerMonth } : { ...recurrence },
      sla_hours: sla,
      provenance: { recurrence: ESTIMATE, sla_hours: ESTIMATE },
    })),
  );
}

function roster(): { clients: ClientRow[]; clientServices: ClientServiceRow[]; clientAssignments: ClientAssignmentRow[] } {
  const clients: ClientRow[] = [];
  const clientServices: ClientServiceRow[] = [];
  const clientAssignments: ClientAssignmentRow[] = [];
  LARKSPUR_ROSTER.forEach((c, i) => {
    const clientId = id("2", i + 1);
    clients.push({
      id: clientId,
      workspace_id: ws,
      name: c.name,
      start_date: c.start,
      mrr: c.mrr,
      health: c.health,
      provenance: c.health === null ? { mrr: ENTERED } : { mrr: ENTERED, health: ESTIMATE },
      notes: c.notes ?? null,
      active: true,
    });
    for (const sv of c.services) clientServices.push({ client_id: clientId, service_id: larkspurServiceIds[sv]!, workspace_id: ws, start_date: null });
    for (const [role, person] of Object.entries({ ...c.team, ops: "priti" })) {
      clientAssignments.push({ client_id: clientId, role_id: larkspurRoleIds[role]!, person_id: larkspurPersonIds[person]!, workspace_id: ws });
    }
  });
  return { clients, clientServices, clientAssignments };
}

/** Larkspur Creative's workspace, its pipeline "Enquiry to launch" and everything a run of it needs. */
export function larkspurBundle(): ProcessBundle {
  edgeNo = 0;
  const s = LARKSPUR_SETTINGS;
  const pipeline = part(
    {
      id: LARKSPUR_PROCESS_ID,
      workspace_id: ws,
      name: "Enquiry to launch",
      kind: "pipeline",
      entity_name: "enquiry",
      description: "From an enquiry to a launched social, content or website project.",
      live_revision_id: LARKSPUR_REVISION_ID,
      parent_process_id: null,
    },
    LARKSPUR_REVISION_ID,
    LARKSPUR_PIPELINE.steps,
    LARKSPUR_PIPELINE.edges,
  );
  const others = LARKSPUR_SERVICING.map((p, i) =>
    part(
      {
        id: larkspurProcessIds[p.key]!,
        workspace_id: ws,
        name: p.name,
        kind: "servicing",
        entity_name: p.entityName,
        description: p.description,
        live_revision_id: id("d", i + 2),
        parent_process_id: null,
      },
      id("d", i + 2),
      p.steps,
      p.edges,
    ),
  );
  return {
    workspace: {
      id: ws,
      name: "Larkspur Creative",
      slug: "larkspur",
      settings: {
        hours_per_week: s.hoursPerWeek,
        horizon_weeks: s.horizonWeeks,
        currency: s.currency,
        leads_per_week: s.leadsPerWeek,
        active_clients: s.activeClients,
        churn_monthly: s.churnMonthly,
        retainer: s.retainer,
        availability_floor: s.availabilityFloor,
        overtime_cap: s.overtimeCap,
        health_missed_penalty: s.healthMissedPenalty,
        health_initial: s.healthInitial,
      },
    },
    roles: LARKSPUR_ROLES.map(
      ([key, name, cost, color]): RoleRow => ({
        id: larkspurRoleIds[key]!,
        workspace_id: ws,
        name,
        color,
        default_cost_rate: cost,
        headcount: LARKSPUR_TEAM.filter((p) => p.roles[0] === key).length,
        ongoing_hours_per_client_week: 0,
        active: true,
        leadership: false,
      }),
    ),
    process: pipeline.process,
    revision: pipeline.revision,
    steps: pipeline.steps,
    edges: pipeline.edges,
    ...people(),
    services: services(),
    leadSources: LARKSPUR_LEAD_SOURCES.map(([, name, volume, conversion], i) => ({
      id: id("6", i + 1),
      workspace_id: ws,
      name,
      volume_week: volume,
      conversion_to_qualified: conversion,
      provenance: { volume_week: ESTIMATE, conversion_to_qualified: ESTIMATE },
    })),
    seasonality: LARKSPUR_SEASONALITY.map((multiplier, i) => ({
      id: id("0", 0x100 + i + 1),
      workspace_id: ws,
      month: i + 1,
      multiplier,
      provenance: { multiplier: ESTIMATE },
    })),
    demand: { workspace_id: ws, growth_monthly: LARKSPUR_GROWTH_MONTHLY, provenance: { growth_monthly: ESTIMATE } },
    ...roster(),
    servicingLinks: servicingLinks(),
    otherProcesses: others,
  };
}

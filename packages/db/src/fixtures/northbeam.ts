import { NORTHBEAM_CLIENT_GROUPS, NORTHBEAM_FALLBACK_LOAD, NORTHBEAM_ROSTER, NORTHBEAM_TEAM, northbeamClientKey } from "@transpera-flow/engine/northbeam-roster";
import { NORTHBEAM_SERVICING } from "@transpera-flow/engine/northbeam-servicing";
import { derivedSourceLinks, type NewSourceLink } from "@transpera-flow/db/source-links";
import type {
  ClientAssignmentRow,
  ClientGroupRow,
  ClientRow,
  ClientServiceRow,
  DemandSettingsRow,
  EdgeRow,
  IssueRow,
  LeadSourceRow,
  PersonRoleRow,
  PersonRow,
  ProcessBundle,
  ProcessPart,
  Provenance,
  RoleRow,
  ScenarioRow,
  ServiceRow,
  ServiceServicingRow,
  SourceRow,
  StepRow,
  WorkspaceAccess,
} from "../types";

// Northbeam Digital, the prototype's sample agency, as database rows. Ids are
// fixed so the seed is reproducible, and they sort in the prototype's order so
// the resolved engine model matches the engine's northbeamWithServices()
// exactly (and, without the services, its golden northbeamModel()).
// Each table has its own id prefix: 1 service servicing links, 2 clients, 3
// sources, 4 issues, 5 scenarios, 6 lead sources, 7 access, 8 services, 9
// people, a workspace, b roles, c processes, d revisions, e steps, f edges.

const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const NORTHBEAM_WORKSPACE_ID = id("a", 1);
export const NORTHBEAM_PROCESS_ID = id("c", 1);
export const NORTHBEAM_REVISION_ID = id("d", 1);

const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
const rev = NORTHBEAM_REVISION_ID;

export const northbeamRoleIds = {
  sales: id("b", 1),
  strat: id("b", 2),
  am: id("b", 3),
  seo: id("b", 4),
  ppc: id("b", 5),
  fin: id("b", 6),
} as const;

export const northbeamStepIds = {
  qualify: id("e", 1),
  discovery: id("e", 2),
  audit: id("e", 3),
  decision: id("e", 4),
  onboard: id("e", 5),
  kickoff: id("e", 6),
  seo: id("e", 7),
  ppc: id("e", 8),
  live: id("e", 9),
  start: id("e", 10),
  won: id("e", 11),
  lost: id("e", 12),
} as const;

/** Named people matching the prototype's head-counts (fictional). */
const PEOPLE: [RoleKey, string][] = [
  ["sales", "Priya Shah"],
  ["sales", "Tom Reed"],
  ["strat", "Maya Collins"],
  ["am", "Leah Brooks"],
  ["am", "Dan Okafor"],
  ["seo", "Sam Patel"],
  ["seo", "Chloe Evans"],
  ["seo", "Arjun Mehta"],
  ["ppc", "Nina Kowalski"],
  ["ppc", "Ben Carter"],
  ["fin", "Rosa Diaz"],
];

export const northbeamPersonIds: Record<string, string> = Object.fromEntries(
  PEOPLE.map(([, name], i) => [name, id("9", i + 1)]),
);

type RoleKey = keyof typeof northbeamRoleIds;
type StepKey = keyof typeof northbeamStepIds;

const role = (key: RoleKey, name: string, headcount: number, cost: number, ongoing: number, color: string): RoleRow => ({
  id: northbeamRoleIds[key],
  workspace_id: ws,
  name,
  color,
  default_cost_rate: cost,
  headcount,
  ongoing_hours_per_client_week: ongoing,
  active: true,
});

const step = (
  key: StepKey,
  name: string,
  roleKey: RoleKey | null,
  work: number,
  wait: number,
  rework: number,
  tool: string | null,
  x: number,
  y: number,
  kind: StepRow["kind"] = roleKey ? "task" : "decision",
): StepRow => ({
  id: northbeamStepIds[key],
  revision_id: rev,
  workspace_id: ws,
  process_id: proc,
  name,
  kind,
  outcome: kind === "end" ? (key as "won" | "lost") : null,
  role_id: roleKey ? northbeamRoleIds[roleKey] : null,
  person_id: null,
  work_hours: work,
  work_dist: "lognormal",
  work_params: {},
  wait_hours: wait,
  wait_dist: "lognormal",
  wait_params: {},
  rework_rate: rework,
  rework_to_step_id: null,
  tool,
  notes: null,
  sla_hours: null,
  expected_wait_hours: null,
  lost_per_day_waiting: null,
  dropoff_benchmark: null,
  target_cycle_hours: null,
  current_wip: null,
  parent_step_id: null,
  entry_step_id: null,
  child_process_id: null,
  x,
  y,
  assumption: false,
  conflict: false,
  provenance: {},
});

let edgeN = 0;
const edge = (from: StepKey, to: StepKey, probability: number, tag: string | null = null): EdgeRow => ({
  id: id("f", ++edgeN),
  revision_id: rev,
  workspace_id: ws,
  process_id: proc,
  from_step_id: northbeamStepIds[from],
  to_step_id: northbeamStepIds[to],
  probability,
  condition_tag: tag,
  label: null,
});

/** Ids sort in the engine fixture's order (seo, ppc). */
export const northbeamServiceIds = {
  seo: id("8", 1),
  ppc: id("8", 2),
} as const;

/** SEO and PPC retainers, as in the engine's northbeamWithServices(), with their fallback load per client (northbeamWithClients()). */
function services(): ServiceRow[] {
  const service = (
    key: keyof typeof northbeamServiceIds,
    name: string,
    price: number,
    margin: number,
    tenure: number,
    churn: number,
    mix: number,
  ): ServiceRow => ({
    id: northbeamServiceIds[key],
    workspace_id: ws,
    name,
    pricing_model: "retainer",
    price,
    margin,
    tenure_months: tenure,
    churn_monthly_base: churn,
    churn_health_sensitivity: 3,
    mix_share: mix,
    entry_process_id: proc,
    path_tags: [key],
    fallback_ongoing_load: Object.fromEntries(
      Object.entries(NORTHBEAM_FALLBACK_LOAD[key]).map(([roleKey, hours]) => [northbeamRoleIds[roleKey as RoleKey], hours]),
    ),
    active: true,
    // The churn sensitivity is the PRD's estimated default (§6.3.5), so the
    // robustness check perturbs it (issue #79); the other values are stamped
    // entered on insert.
    provenance: { churn_health_sensitivity: { source: "estimated", at: "2026-09-29T00:00:00Z", note: "Northbeam sample data" } },
  });
  return [
    service("seo", "SEO retainer", 3500, 0.45, 18, 0.03, 0.55),
    service("ppc", "PPC management", 4200, 0.4, 12, 0.04, 0.45),
  ];
}

/** Ids sort in the order below. */
export const northbeamLeadSourceIds = {
  website: id("6", 1),
  ads: id("6", 2),
  referrals: id("6", 3),
} as const;

/** The sample figures are estimates, as an audit's first pass would be. */
const ESTIMATE: Provenance = { source: "estimated", at: "2026-09-29T00:00:00Z", note: "Northbeam sample data" };

/**
 * Lead sources whose qualified leads add up to the 7 a week Northbeam has
 * always simulated: 8 × 25% + 4 × 50% + 3 × 100% = 2 + 2 + 3 (exact in
 * binary floating point, so the rate is exactly 7). No seasonality and no
 * growth, so arrivals are unchanged.
 */
function leadSources(): LeadSourceRow[] {
  const source = (key: keyof typeof northbeamLeadSourceIds, name: string, volume: number, conversion: number): LeadSourceRow => ({
    id: northbeamLeadSourceIds[key],
    workspace_id: ws,
    name,
    volume_week: volume,
    conversion_to_qualified: conversion,
    provenance: { volume_week: ESTIMATE, conversion_to_qualified: ESTIMATE },
  });
  return [
    source("website", "Website enquiries", 8, 0.25),
    source("ads", "Google Ads", 4, 0.5),
    source("referrals", "Client referrals", 3, 1),
  ];
}

/** Client ids, by the engine fixture's keys ("c01" …), in roster order. */
export const northbeamClientIds: Record<string, string> = Object.fromEntries(
  NORTHBEAM_ROSTER.map((_, i) => [northbeamClientKey(i), id("2", i + 1)]),
);

/** MRR comes from the invoices; health is the consultant's first estimate. */
const ENTERED: Provenance = { source: "entered", at: "2026-09-29T00:00:00Z", note: "Northbeam sample data" };

/** The 26 named clients of the engine's northbeamWithClients(), as rows. */
function roster(): { clients: ClientRow[]; clientServices: ClientServiceRow[]; clientAssignments: ClientAssignmentRow[] } {
  const person = (key: string) => northbeamPersonIds[NORTHBEAM_TEAM.find(([k]) => k === key)![1]]!;
  const clients: ClientRow[] = [];
  const clientServices: ClientServiceRow[] = [];
  const clientAssignments: ClientAssignmentRow[] = [];
  NORTHBEAM_ROSTER.forEach((c, i) => {
    const clientId = id("2", i + 1);
    clients.push({
      id: clientId,
      workspace_id: ws,
      name: c.name,
      start_date: c.start,
      mrr: c.mrr,
      health: c.health,
      provenance: { mrr: ENTERED, health: ESTIMATE },
      notes: c.health < 50 ? "Unhappy with lead volume since the spring; renewal call due." : null,
      active: true,
    });
    for (const sv of c.services) {
      clientServices.push({ client_id: clientId, service_id: northbeamServiceIds[sv], workspace_id: ws, start_date: null });
    }
    const assign = (roleKey: RoleKey, personKey: string) =>
      clientAssignments.push({ client_id: clientId, role_id: northbeamRoleIds[roleKey], person_id: person(personKey), workspace_id: ws });
    assign("strat", "maya");
    assign("am", c.am);
    if (c.seo) assign("seo", c.seo);
    if (c.ppc) assign("ppc", c.ppc);
    assign("fin", "rosa");
  });
  return { clients, clientServices, clientAssignments };
}

/**
 * Northbeam's clients counted per service (issue #120): what the audit would
 * enter, from the engine's NORTHBEAM_CLIENT_GROUPS. The 26 named clients above
 * stay in the database, hidden, and are not simulated while these exist.
 */
function clientGroups(): ClientGroupRow[] {
  return NORTHBEAM_CLIENT_GROUPS.map((g, i) => ({
    id: id("0", i + 1),
    workspace_id: ws,
    service_id: northbeamServiceIds[g.service],
    client_count: g.count,
    fee: g.fee,
    churn_monthly: g.churnMonthly,
    stay_months: g.stayMonths,
    starting_health: g.health,
    provenance: Object.fromEntries(["client_count", "fee", "churn_monthly", "stay_months", "starting_health"].map((c) => [c, ESTIMATE])),
  }));
}

function demandSettings(): DemandSettingsRow {
  return { workspace_id: ws, growth_monthly: 0, provenance: { growth_monthly: ESTIMATE } };
}

export const northbeamSourceIds = {
  strategyInterview: id("3", 1),
  salesNotes: id("3", 2),
} as const;

/**
 * What the audit recorded (fictional): an interview transcript and a set of
 * notes, which the sample's figures cite.
 */
export function northbeamSources(): SourceRow[] {
  const at = "2026-09-29T09:00:00Z";
  return [
    {
      id: northbeamSourceIds.strategyInterview,
      workspace_id: ws,
      kind: "transcript",
      title: "Strategy walkthrough",
      speakers: ["Maya Collins", "Rosa Diaz"],
      recorded_at: "2026-09-12",
      body: [
        "[00:14:05] Maya Collins: A proper audit and proposal is a day's work, call it six hours, if nobody interrupts me.",
        "[00:16:40] Rosa Diaz: From the time logs it looks more like twelve hours by the time it goes out.",
        "[00:21:10] Maya Collins: Kickoffs are quicker, half a day.",
      ].join("\n"),
      file_url: null,
      created_at: at,
      updated_at: at,
    },
    {
      id: northbeamSourceIds.salesNotes,
      workspace_id: ws,
      kind: "notes",
      title: "Sales team notes",
      speakers: ["Priya Shah", "Tom Reed"],
      recorded_at: "2026-09-15",
      body: [
        "Priya: discovery calls get booked within three working days of qualifying.",
        "Priya: about one proposal in seven comes back from sales review for changes.",
        "Tom: clients take a week to decide, sometimes longer.",
      ].join("\n"),
      file_url: null,
      created_at: at,
      updated_at: at,
    },
  ];
}

/**
 * What the sample's sources are linked to: the steps whose figures cite them and the issue that lists one (A53). The same
 * rows the migration copies from those citations, so a seeded database starts as a migrated one does.
 */
export function northbeamSourceLinks(): NewSourceLink[] {
  const bundle = northbeamBundle();
  const steps = [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)];
  return derivedSourceLinks(steps, northbeamIssues(), northbeamSources());
}

/**
 * The sample's step figures with the evidence behind them. Every cited value
 * is the step's own, so the model simulates exactly as before; they stay
 * estimates until someone confirms them.
 */
function withEvidence(steps: StepRow[]): StepRow[] {
  const { strategyInterview: interview, salesNotes: notes } = northbeamSourceIds;
  const cited: Partial<Record<StepKey, StepRow["provenance"]>> = {
    audit: {
      work_hours: {
        ...ESTIMATE,
        evidence: [
          {
            source_id: interview,
            speaker: "Maya Collins",
            quote: "A proper audit and proposal is a day's work, call it six hours.",
            timestamp: "00:14:05",
            value: 6,
          },
        ],
      },
      rework_rate: {
        ...ESTIMATE,
        evidence: [
          {
            source_id: notes,
            speaker: "Priya Shah",
            quote: "About one proposal in seven comes back from sales review for changes.",
            timestamp: null,
            value: 0.15,
          },
        ],
      },
    },
    discovery: {
      wait_hours: {
        ...ESTIMATE,
        evidence: [
          { source_id: notes, speaker: "Priya Shah", quote: "Discovery calls get booked within three working days of qualifying.", timestamp: null, value: 24 },
        ],
      },
    },
    decision: {
      wait_hours: {
        ...ESTIMATE,
        evidence: [{ source_id: notes, speaker: "Tom Reed", quote: "Clients take a week to decide, sometimes longer.", timestamp: null, value: 40 }],
      },
    },
  };
  const byId = new Map(Object.entries(cited).map(([key, prov]) => [northbeamStepIds[key as StepKey], prov]));
  return steps.map((s) => (byId.has(s.id) ? { ...s, provenance: byId.get(s.id)! } : s));
}

/**
 * Northbeam's servicing processes (issue #19), both published: a monthly
 * report and a fortnightly check-in (NORTHBEAM_SERVICING), after the
 * pipeline in id order. Their step and edge ids carry on from the pipeline's.
 */
export const northbeamServicingProcessIds: Record<string, string> = Object.fromEntries(
  NORTHBEAM_SERVICING.map((p, i) => [p.key, id("c", i + 2)]),
);

/** Servicing step ids by NORTHBEAM_SERVICING's keys ("report_seo" …), in the order they are listed. */
export const northbeamServicingStepIds: Record<string, string> = Object.fromEntries(
  NORTHBEAM_SERVICING.flatMap((p) => p.steps).map((s, i) => [s.key, id("e", Object.keys(northbeamStepIds).length + i + 1)]),
);

function servicingProcesses(firstEdge: number): { parts: ProcessPart[]; links: ServiceServicingRow[] } {
  let edgeNo = firstEdge;
  const parts = NORTHBEAM_SERVICING.map((p, i): ProcessPart => {
    const processId = northbeamServicingProcessIds[p.key]!;
    const revisionId = id("d", i + 2);
    return {
      process: {
        id: processId,
        workspace_id: ws,
        name: p.name,
        kind: "servicing",
        entity_name: p.entityName,
        description: p.description,
        live_revision_id: revisionId,
        parent_process_id: null,
      },
      revision: { id: revisionId, workspace_id: ws, process_id: processId, number: 1, status: "published" },
      steps: p.steps.map((s): StepRow => ({
        id: northbeamServicingStepIds[s.key]!,
        revision_id: revisionId,
        workspace_id: ws,
        process_id: processId,
        name: s.name,
        kind: s.kind,
        outcome: s.kind === "end" ? "done" : null,
        role_id: s.role ? northbeamRoleIds[s.role as RoleKey] : null,
        person_id: null,
        work_hours: s.work,
        work_dist: "lognormal",
        work_params: {},
        wait_hours: s.wait,
        wait_dist: "lognormal",
        wait_params: {},
        rework_rate: 0,
        rework_to_step_id: null,
        tool: s.tool,
        notes: null,
        sla_hours: null,
        expected_wait_hours: null,
        lost_per_day_waiting: null,
        dropoff_benchmark: null,
        target_cycle_hours: null,
        current_wip: null,
        parent_step_id: null,
        entry_step_id: null,
        child_process_id: null,
        x: s.x,
        y: s.y,
        assumption: false,
        conflict: false,
        provenance: {},
      })),
      edges: p.edges.map(([from, to, probability, tag]): EdgeRow => ({
        id: id("f", ++edgeNo),
        revision_id: revisionId,
        workspace_id: ws,
        process_id: processId,
        from_step_id: northbeamServicingStepIds[from]!,
        to_step_id: northbeamServicingStepIds[to]!,
        probability,
        condition_tag: tag,
        label: null,
      })),
    };
  });
  // Every client on either service runs both, estimated as the audit's first pass would.
  let linkNo = 0;
  const links = (["seo", "ppc"] as const).flatMap((sv) =>
    NORTHBEAM_SERVICING.map(
      (p): ServiceServicingRow => ({
        id: id("1", ++linkNo),
        workspace_id: ws,
        service_id: northbeamServiceIds[sv],
        process_id: northbeamServicingProcessIds[p.key]!,
        recurrence: { ...p.recurrence },
        sla_hours: p.slaHours,
        provenance: { recurrence: ESTIMATE, sla_hours: ESTIMATE },
      }),
    ),
  );
  return { parts, links };
}

export function northbeamBundle(): ProcessBundle {
  edgeN = 0;
  const pipelineEdges = pipelineEdgeRows();
  const servicing = servicingProcesses(edgeN);
  return {
    workspace: {
      id: ws,
      name: "Northbeam Digital",
      slug: "northbeam",
      settings: {
        hours_per_week: 40,
        horizon_weeks: 13,
        currency: "GBP",
        leads_per_week: 7,
        active_clients: 26,
        churn_monthly: 0.03,
        retainer: 3800,
        overtime_cap: 0.1,
        // Typical client health for a small SEO and PPC agency (issue #120), as an audit would enter it.
        client_health_benchmark_low: 70,
        client_health_benchmark_high: 80,
      },
    },
    roles: [
      role("sales", "Sales", 2, 45, 0, "#2a78d6"),
      role("strat", "Strategist", 1, 70, 0.4, "#eb6834"),
      role("am", "Account manager", 2, 55, 1.6, "#1baf7a"),
      role("seo", "SEO specialist", 3, 50, 2.4, "#8b5cf6"),
      role("ppc", "PPC specialist", 2, 50, 2.0, "#d4a106"),
      role("fin", "Finance", 1, 40, 0.3, "#64748b"),
    ],
    process: {
      id: proc,
      workspace_id: ws,
      name: "Lead to live",
      kind: "pipeline",
      entity_name: "lead",
      description: "From inbound lead to a live SEO or PPC campaign.",
      live_revision_id: rev,
      parent_process_id: null,
    },
    revision: { id: rev, workspace_id: ws, process_id: proc, number: 1, status: "published" },
    steps: withEvidence([
      step("qualify", "Qualify lead", "sales", 0.5, 4, 0, "HubSpot", 60, 50),
      step("discovery", "Discovery call", "sales", 1.5, 24, 0, "Zoom + HubSpot", 290, 50),
      // 5% of leads a day go cold while they wait for the audit: the waiting insight shows money (issue #108).
      { ...step("audit", "Audit & proposal", "strat", 6, 0, 0.15, "SEMrush, Google Docs", 520, 50), lost_per_day_waiting: 0.05 },
      step("decision", "Client decision", null, 0, 40, 0, "Email", 750, 50),
      step("onboard", "Contract & onboarding", "am", 3, 16, 0.1, "PandaDoc, Notion", 60, 290),
      step("kickoff", "Kickoff & strategy", "strat", 4, 8, 0, "Notion", 290, 320),
      step("seo", "SEO campaign setup", "seo", 10, 8, 0.1, "Ahrefs, WordPress", 520, 236),
      step("ppc", "PPC campaign setup", "ppc", 8, 8, 0.1, "Google Ads", 520, 384),
      step("live", "Go live & first report", "am", 2, 0, 0, "Looker Studio", 750, 290),
      step("start", "Lead arrives", null, 0, 0, 0, null, -150, 50, "start"),
      step("won", "Won", null, 0, 0, 0, null, 980, 290, "end"),
      step("lost", "Lost", null, 0, 0, 0, null, 290, -70, "end"),
    ]),
    edges: pipelineEdges,
    people: PEOPLE.map(
      ([, name]): PersonRow => ({
        id: northbeamPersonIds[name]!,
        workspace_id: ws,
        name,
        fte: 1,
        capacity_hours_week: null,
        cost_rate: null,
        active: true,
        start_date: null,
        end_date: null,
      }),
    ),
    personRoles: PEOPLE.map(
      ([roleKey, name]): PersonRoleRow => ({
        person_id: northbeamPersonIds[name]!,
        role_id: northbeamRoleIds[roleKey],
        workspace_id: ws,
      }),
    ),
    personSkills: [],
    personLeave: [],
    services: services(),
    leadSources: leadSources(),
    seasonality: [],
    demand: demandSettings(),
    ...roster(),
    clientGroups: clientGroups(),
    servicingLinks: servicing.links,
    otherProcesses: servicing.parts,
  };
}

function pipelineEdgeRows(): EdgeRow[] {
  return [
    edge("start", "qualify", 1),
    edge("qualify", "discovery", 0.55),
    edge("qualify", "lost", 0.45),
    edge("discovery", "audit", 0.7),
    edge("discovery", "lost", 0.3),
    edge("audit", "decision", 1),
    edge("decision", "onboard", 0.32),
    edge("decision", "lost", 0.68),
    edge("onboard", "kickoff", 1),
    edge("kickoff", "seo", 0.55, "seo"),
    edge("kickoff", "ppc", 0.45, "ppc"),
    edge("seo", "live", 1),
    edge("ppc", "live", 1),
    edge("live", "won", 1),
  ];
}

export const NORTHBEAM_DOMAIN = "northbeam.example";

/** Example access settings (fictional; `.example` and example.com never receive mail). */
export function northbeamAccess(): WorkspaceAccess {
  const person = (name: string) => northbeamPersonIds[name]!;
  return {
    domains: [{ id: id("7", 1), workspace_id: ws, domain: NORTHBEAM_DOMAIN }],
    emails: [
      { id: id("7", 2), workspace_id: ws, email: "rosa.diaz@northbeam.example", role: "owner", person_id: person("Rosa Diaz") },
      { id: id("7", 3), workspace_id: ws, email: "leah.brooks@northbeam.example", role: "editor", person_id: person("Leah Brooks") },
      // A contractor on a personal address: only the pre-assigned list can let them in.
      { id: id("7", 4), workspace_id: ws, email: "sam.patel.seo@example.com", role: "member", person_id: person("Sam Patel") },
    ],
  };
}

/**
 * Northbeam's scenario library: the four every workspace starts with (hire,
 * automate a step, more leads, downturn; see the scenarios migration), aimed
 * at Northbeam's own bottleneck. The seed replaces the generic versions the
 * workspace trigger created with these.
 */
export function northbeamScenarios(): ScenarioRow[] {
  const scenario = (n: number, name: string, description: string, patch: ScenarioRow["patch"]): ScenarioRow => ({
    id: id("5", n),
    workspace_id: ws,
    name,
    description,
    patch,
    parent_scenario_id: null,
  });
  return [
    scenario(1, "Hire a strategist", "A second full-time strategist to share audits, proposals and kickoffs.", [
      { path: `roles.${northbeamRoleIds.strat}.headcount`, op: "add", value: 1 },
    ]),
    scenario(2, "Automate proposals", "Templates and SEMrush exports cut hands-on time on audits and proposals by 60%.", [
      { path: `steps.${northbeamStepIds.audit}.work_hours`, op: "multiply", value: 0.4 },
    ]),
    scenario(3, "More leads", "25% more leads every week.", [{ path: "demand.leads_per_week", op: "multiply", value: 1.25 }]),
    scenario(4, "Downturn", "30% fewer leads a week, and client churn up by half.", [
      { path: "demand.leads_per_week", op: "multiply", value: 0.7 },
      { path: "demand.churn_monthly", op: "multiply", value: 1.5 },
    ]),
  ];
}

/**
 * Northbeam's register as the audit left it (after the prototype's findings):
 * two audit findings logged by hand, one linked to its fix, and the detected
 * single point of failure at audits promoted to a tracked issue, so each run
 * lists it once, as tracked.
 */
export function northbeamIssues(): IssueRow[] {
  const at = "2026-09-29T09:00:00Z";
  const base = {
    workspace_id: ws,
    process_id: proc,
    role_id: null,
    person_id: null,
    client_id: null,
    evidence_metrics: {},
    owner_person_id: null,
    scenario_id: null,
    detected_key: null,
    resolved_at: null,
    resolved_how: null,
    resolved_solution_id: null,
    resolution_note: null,
    dismissed_revision_id: null,
    created_at: at,
    updated_at: at,
  } satisfies Partial<IssueRow>;
  const scenario = (n: number) => northbeamScenarios()[n - 1]!.id;
  const person = (name: string) => northbeamPersonIds[name]!;
  const issues: Omit<IssueRow, "number" | "target_measure" | "target_now" | "target_goal" | "links" | "owner_ids" | "source_ids">[] = [
    {
      ...base,
      id: id("4", 1),
      step_id: northbeamStepIds.audit,
      role_id: northbeamRoleIds.strat,
      type: "manual",
      severity: "serious",
      title: "Every proposal is built by hand",
      evidence: "Audit interview, 12 Sep: 5–8 hours per proposal, and 15% go back for rework after sales review.",
      owner_person_id: person("Rosa Diaz"),
      status: "open",
      scenario_id: scenario(2),
      source: "manual",
    },
    {
      ...base,
      id: id("4", 2),
      step_id: northbeamStepIds.audit,
      role_id: northbeamRoleIds.strat,
      person_id: person("Maya Collins"),
      type: "spof",
      severity: "serious",
      title: "Only Maya Collins can do Audit & proposal",
      evidence: "Detected: nobody else can pick up audits when Maya is away. Proposals stalled for 9 days in July.",
      owner_person_id: person("Rosa Diaz"),
      status: "testing",
      scenario_id: scenario(1),
      source: "promoted",
      detected_key: `spof:step:${northbeamStepIds.audit}`,
    },
    {
      ...base,
      id: id("4", 3),
      step_id: northbeamStepIds.qualify,
      role_id: northbeamRoleIds.sales,
      type: "idea",
      severity: "info",
      title: "Lead scoring could skip unqualified discovery calls",
      evidence: "45% of leads drop out at qualification but still get a 4-hour response.",
      owner_person_id: person("Priya Shah"),
      status: "open",
      source: "manual",
    },
  ];
  return issues.map((issue, n) => ({
    number: n + 1,
    target_measure: n === 0 ? "Hands-on time per proposal" : null,
    target_now: n === 0 ? "6 hours" : null,
    target_goal: n === 0 ? "under 3 hours" : null,
    ...issue,
    // What it touches and who owns it, as the link tables hold them: the first step (else the process), the first owner.
    links: [{ process_id: issue.process_id, step_id: issue.step_id }],
    owner_ids: issue.owner_person_id ? [issue.owner_person_id] : [],
    source_ids: n === 0 ? [northbeamSourceIds.strategyInterview] : [],
  }));
}

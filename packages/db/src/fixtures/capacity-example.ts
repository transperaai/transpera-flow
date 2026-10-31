// An example workspace for building and testing the capacity app (capacity build, P2b section 3). It loads the prototype's `base()` example
// agency (docs/prototypes/client-capacity-app.PROTOTYPE.html) into an EMPTY workspace, as Set up data and processes:
//   - the two departments, tiers T1 to T3 and the six tier services with the prototype's deliverables (the capacity starter, capacity-starter.ts),
//     "taking both" counts, and a Sales role for the pipeline;
//   - the 27 people with their roles, team time, speed, tiers, counted-client portfolios, salary and label;
//   - the 13 named clients with their overrides, hand-holding hours, services and managers;
//   - the servicing processes and steps, linked to every tier of their department, and a four-step sales pipeline.
//
// THE DATA IS MADE UP (the prototype's), so this file and its output can be committed. It is NEVER loaded into the client's deployment:
// it is for a developer's or test workspace only. Every structural fact (who, what, how many) is read from the engine's `capacityModel()`
// fixture, so the two cannot drift apart; only what the engine does not carry (salary, titles, labels, "taking both") is keyed here.
//
// P4's columns. The engine reads driver recurrences ("tasks a month = per month x the tier's words / 1,000") and steps' work split, tier
// multiplier and `toClientManager`, but the database stores them only once P4's migration (20270120000000) is applied. The loader checks for
// them: with them it writes the fixture's driver recurrences and step columns as they are; without them each link gets the tier's FIXED rate
// worked out from its deliverables (4,000 words is `{every: "month", times: 4}`; ad hoc is `poisson_per_month` = chance x requests) and steps
// have no split, multiplier or manager routing. The fixed rate is exact for a counted client; a named client's own channels, meetings and
// ad-hoc values are stored but only reach the tasks through driver recurrences, and steps that go to the client's manager go to their role.
//
// It writes as whoever holds the connection (the owner login), in the caller's transaction, like the capacity starter. It refuses a workspace
// that has anything in it.

import { randomUUID } from "node:crypto";
import { capacityModel, type EngineStep, type Recurrence, type TierDeliverables } from "@transpera-flow/engine";
import { applyCapacityStarter, type Queryable } from "../capacity-starter";

/** The prototype's `both`: counted clients who take both departments' services, by tier. */
export const EXAMPLE_BOTH: Record<string, number> = { T1: 1, T2: 5, T3: 8 };

/** Salary a month (made up), title and label of each person, from the prototype. The engine doesn't carry these. */
const PERSON_EXTRAS: Record<string, { salary: number; title: string; label?: "contractor" | "offshore" }> = {
  laura: { salary: 12500, title: "SEO Director" },
  karl: { salary: 10000, title: "Senior SEO Manager & Link Lead" },
  nadiya: { salary: 7500, title: "SEO Manager" },
  zach: { salary: 7500, title: "SEO Manager" },
  jc: { salary: 6500, title: "Senior SEO Analyst" },
  khas: { salary: 5500, title: "SEO Analyst" },
  resign: { salary: 7500, title: "Leaves in a month" },
  sarah: { salary: 8500, title: "Content Manager (writes, edits)" },
  jess: { salary: 6000, title: "SEO Copywriter" },
  chloe: { salary: 6000, title: "SEO Copywriter" },
  hayley: { salary: 6500, title: "Content Specialist" },
  free: { salary: 0, title: "Contractors, not in DLER", label: "contractor" },
  tonie: { salary: 3000, title: "Outreach Specialist", label: "offshore" },
  jasfer: { salary: 3000, title: "Outreach Specialist", label: "offshore" },
  henry: { salary: 11000, title: "Technical SEO Director" },
  everhardt: { salary: 9000, title: "Senior Technical SEO Manager" },
  sid: { salary: 7000, title: "Technical SEO Specialist" },
  wendlley: { salary: 12500, title: "Performance Director" },
  sophie: { salary: 9500, title: "Senior PMM" },
  shrishti: { salary: 9500, title: "Senior PMM" },
  diya: { salary: 7500, title: "PMM" },
  thomas: { salary: 7500, title: "PMM" },
  tanya: { salary: 7500, title: "PMM" },
  tatiana: { salary: 6000, title: "Performance Coordinator" },
  michaela: { salary: 6500, title: "Performance Specialist" },
  liam: { salary: 7500, title: "Conversion Tracking Specialist" },
  sales: { salary: 8000, title: "Sales lead" },
};

/** The starter's department names, by the model's department key. */
const DEPARTMENT_NAME: Record<string, string> = { org: "Organic (SEO)", perf: "Performance" };

export type ExampleResult =
  | { applied: true; people: number; clients: number; processes: number; steps: number; links: number; stepBaseValues: boolean; driverRecurrences: boolean; changes: number }
  | { applied: false; reason: string };

const ESTIMATE = (at: string) => JSON.stringify({ source: "estimate", at });

/** The fixed rate a servicing link runs at until driver recurrences can be stored: tasks a month from the tier's deliverables. Null: none. */
export function fixedRecurrence(r: Recurrence, deliverables: TierDeliverables, adhoc: { chance: number; requests: number } | undefined): Record<string, unknown> | null {
  if ("driver" in r) {
    if (r.driver === "adhoc") {
      const rate = adhoc ? adhoc.chance * adhoc.requests * r.perMonth : 0;
      return rate > 0 ? { poisson_per_month: round(rate) } : null;
    }
    const rate = (r.perMonth * (deliverables[r.driver] ?? 0)) / (r.per ?? 1);
    return rate > 0 ? { every: "month", times: round(rate) } : null;
  }
  if ("poissonPerMonth" in r) return { poisson_per_month: r.poissonPerMonth };
  return { every: r.every, times: round(r.times) };
}
const round = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Loads the example into an empty workspace. Run inside a transaction. Does nothing, and says why, when the workspace has anything in it.
 * `today` (an ISO date) is only for the one person who leaves a month in.
 */
export async function loadCapacityExample(db: Queryable, workspaceId: string, today: string = new Date().toISOString().slice(0, 10)): Promise<ExampleResult> {
  const ws = await db.query("select id from public.workspaces where id = $1 for update", [workspaceId]);
  if (ws.rows.length === 0) return { applied: false, reason: "No such workspace." };
  // (A new workspace has its company map, a process that is a picture, not a process: it doesn't count.)
  for (const [table, where] of [["processes", "is_company is not true"], ["lead_sources", "true"]] as const) {
    const found = await db.query(`select 1 from public.${table} where workspace_id = $1 and ${where} limit 1`, [workspaceId]);
    if (found.rows.length > 0) return { applied: false, reason: `The workspace already has ${table.replace("_", " ")}: the example is only for an empty one.` };
  }
  // Departments, tiers, the six tier services and nine roles (it refuses a workspace with tiers, roles, people, clients, services or counted clients).
  const starter = await applyCapacityStarter(db, workspaceId);
  if (!starter.applied) return { applied: false, reason: starter.reason };

  const model = capacityModel();
  const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[]) => (await rows(sql, params))[0]!;
  const at = new Date().toISOString();

  // ---- ids of what the starter made -------------------------------------------------------------------------------------------------
  const tierIds = new Map((await rows("select id, key from public.tiers where workspace_id = $1", [workspaceId])).map((r) => [String(r.key), String(r.id)]));
  const serviceIds = new Map<string, string>();
  for (const r of await rows("select s.id, d.name as dept, t.key as tier from public.services s join public.departments d on d.id = s.department_id join public.tiers t on t.id = s.tier_id where s.workspace_id = $1", [workspaceId])) {
    const dept = Object.entries(DEPARTMENT_NAME).find(([, name]) => name === r.dept)![0];
    serviceIds.set(`${dept}-${String(r.tier)}`, String(r.id));
  }
  const roleIds = new Map<string, string>();
  const starterRoles = await rows("select id, name from public.roles where workspace_id = $1", [workspaceId]);
  for (const [key, role] of Object.entries(model.roles)) {
    const found = starterRoles.find((r) => r.name === role.name);
    if (found) roleIds.set(key, String(found.id));
  }
  // Is P4's migration applied? Its step columns, and whether the recurrence check accepts a driver.
  const stepBaseValues = (await rows("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'steps' and column_name = 'to_client_manager'")).length > 0;
  const driverRecurrences = (await one("select private.is_recurrence($1::jsonb) as ok", [JSON.stringify({ driver: "words", perMonth: 1, per: 1000 })])).ok === true;
  // Sales runs the pipeline, not a department's clients: a shared team counted in hours.
  const sales = await one(
    "insert into public.roles (workspace_id, name, kind, unit, line, provenance) values ($1, $2, 'shared', 'hours', 0.85, $3::jsonb) returning id",
    [workspaceId, model.roles.sales!.name, JSON.stringify({ line: { source: "estimate", at }, unit: { source: "estimate", at } })],
  );
  roleIds.set("sales", String(sales.id));
  for (const key of Object.keys(model.roles)) if (!roleIds.has(key)) throw new Error(`The example's role "${key}" is not among the starter's roles.`);

  // ---- settings, demand, "taking both" and tenure ------------------------------------------------------------------------------------
  await db.query(
    `update public.workspaces set settings = settings || $2::jsonb where id = $1`,
    [workspaceId, JSON.stringify({ hours_per_week: model.hoursPerWeek, horizon_weeks: model.horizonWeeks, churn_monthly: model.churnMonthly, retainer: model.retainer, active_clients: 0, capacity_factor_enabled: true })],
  );
  await db.query("insert into public.lead_sources (workspace_id, name, volume_week, conversion_to_qualified) values ($1, 'Leads', $2, 1)", [workspaceId, round(model.leadsPerWeek)]);
  for (const [key, n] of Object.entries(EXAMPLE_BOTH)) await db.query("update public.tiers set both_count = $3 where workspace_id = $1 and key = $2", [workspaceId, key, n]);
  for (const [key, sv] of Object.entries(model.services!)) await db.query("update public.services set tenure_months = $2 where id = $1", [serviceIds.get(key), sv.tenureMonths]);

  // ---- people ---------------------------------------------------------------------------------------------------------------------------
  const personIds = new Map<string, string>();
  const monthLater = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  for (const [key, p] of Object.entries(model.people!)) {
    const extra = PERSON_EXTRAS[key]!;
    const r = await one(
      `insert into public.people (workspace_id, name, fte, capacity_hours_week, reserved_share, salary_monthly, label, notes, end_date)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8) returning id`,
      [workspaceId, p.name, p.capacity, p.reservedShare ?? 0, extra.salary, extra.label ?? null, extra.title, p.until !== undefined ? monthLater : null],
    );
    const id = String(r.id);
    personIds.set(key, id);
    for (const role of p.roles) await db.query("insert into public.person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [id, roleIds.get(role), workspaceId]);
    for (const tier of p.tiers ?? []) await db.query("insert into public.person_tiers (person_id, tier_id, workspace_id) values ($1, $2, $3)", [id, tierIds.get(tier), workspaceId]);
    for (const [sid, n] of Object.entries(p.portfolio ?? {})) {
      await db.query("insert into public.person_portfolio (person_id, service_id, client_count, workspace_id) values ($1, $2, $3, $4)", [id, serviceIds.get(sid), n, workspaceId]);
    }
    // Speed is a time factor (1 / speed), kept as the person's time on every step.
    if (p.capacityFactor?.default !== undefined) {
      await db.query("insert into public.person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, null, $3)", [id, workspaceId, round(p.capacityFactor.default)]);
    }
  }

  // ---- named clients --------------------------------------------------------------------------------------------------------------------
  let clients = 0;
  for (const c of Object.values(model.clients!)) {
    const o = c.overrides ?? {};
    const hand = c.handHoldingHours ? Object.values(c.handHoldingHours)[0]! : null;
    const r = await one(
      `insert into public.clients (workspace_id, name, mrr, meetings, channels, adhoc_chance, adhoc_requests, adhoc_hours, hand_holding_hours)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [workspaceId, c.name, c.mrr, o.meetings ?? null, o.channels ?? null, o.adhocChance ?? null, o.adhocRequests ?? null, o.adhocHours ?? null, hand],
    );
    const id = String(r.id);
    for (const sid of c.services) await db.query("insert into public.client_services (client_id, service_id, workspace_id) values ($1, $2, $3)", [id, serviceIds.get(sid), workspaceId]);
    for (const [role, person] of Object.entries(c.assignments)) {
      await db.query("insert into public.client_assignments (client_id, role_id, person_id, workspace_id) values ($1, $2, $3, $4)", [id, roleIds.get(role), personIds.get(person), workspaceId]);
    }
    clients++;
  }

  // ---- processes and steps ----------------------------------------------------------------------------------------------------------
  const stepById = new Map(model.steps.map((s) => [s.id, s]));
  let steps = 0;
  /** The model's step id -> the id of the step row it became (what a stored change points at). */
  const stepDbIds = new Map<string, string>();
  /** A published process: a start step, the given steps in `list` order, and the end steps `ends` (id -> outcome). Returns its id. */
  const makeProcess = async (name: string, kind: "pipeline" | "servicing", entity: string, entry: string, list: EngineStep[], ends: Record<string, "won" | "lost" | "done">) => {
    const processId = randomUUID();
    const revisionId = randomUUID();
    await db.query("insert into public.processes (id, workspace_id, name, kind, entity_name) values ($1, $2, $3, $4, $5)", [processId, workspaceId, name, kind, entity]);
    await db.query("insert into public.process_revisions (id, workspace_id, process_id, number, status, published_at) values ($1, $2, $3, 1, 'published', now())", [revisionId, workspaceId, processId]);
    const ids = new Map<string, string>();
    const startId = randomUUID();
    const insertStep = async (id: string, label: string, kindOf: string, x: number, y: number, extra: { outcome?: string; role?: string; person?: string; work?: number; wait?: number; base?: EngineStep } = {}) => {
      // P4's step columns, when the database has them: the work split, the tier multipliers and routing to the client's manager.
      const base = stepBaseValues && extra.base ? extra.base : undefined;
      const more = base
        ? { cols: ", split, tier_multiplier, to_client_manager", marks: ", $14::jsonb, $15::jsonb, $16", values: [base.split ? JSON.stringify(base.split) : null, base.tierMultiplier ? JSON.stringify(base.tierMultiplier) : null, base.toClientManager === true] }
        : { cols: "", marks: "", values: [] };
      await db.query(
        `insert into public.steps (id, revision_id, workspace_id, process_id, name, kind, outcome, role_id, person_id, work_hours, wait_hours, rework_rate, x, y${more.cols})
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13${more.marks})`,
        [id, revisionId, workspaceId, processId, label, kindOf, extra.outcome ?? null, extra.role ?? null, extra.person ?? null, extra.work ?? 0, extra.wait ?? 0, x, y, ...more.values],
      );
      steps++;
    };
    await insertStep(startId, "Start", "start", 40, 60);
    for (const s of list) {
      ids.set(s.id, randomUUID());
      stepDbIds.set(s.id, ids.get(s.id)!);
    }
    for (const [i, s] of list.entries()) {
      await insertStep(ids.get(s.id)!, s.name, "task", 220 + i * 240, 60, {
        role: s.role ? roleIds.get(s.role) : undefined,
        person: s.person ? personIds.get(s.person) : undefined,
        work: round(s.work),
        wait: s.wait,
        base: s,
      });
    }
    let n = 0;
    for (const [end, outcome] of Object.entries(ends)) {
      ids.set(end, randomUUID());
      await insertStep(ids.get(end)!, outcome === "won" ? "Won" : outcome === "lost" ? "Lost" : "Done", "end", 220 + list.length * 240, 60 + 140 * n++, { outcome });
    }
    const edge = (from: string, to: string, p: number) =>
      db.query("insert into public.edges (revision_id, workspace_id, process_id, from_step_id, to_step_id, probability) values ($1, $2, $3, $4, $5, $6)", [revisionId, workspaceId, processId, from, to, p]);
    await edge(startId, ids.get(entry)!, 1);
    for (const s of list) for (const next of s.next) await edge(ids.get(s.id)!, ids.get(next.to)!, next.p);
    await db.query("update public.processes set live_revision_id = $2 where id = $1", [processId, revisionId]);
    return processId;
  };

  const pipelineIds = ["qualify", "discovery", "pitch", "contract"];
  await makeProcess("Win new clients", "pipeline", "lead", model.entry, pipelineIds.map((id) => stepById.get(id)!), { [model.sinks.won]: "won", [model.sinks.lost]: "lost" });
  let processes = 1;
  const processDbIds = new Map<string, string>();
  for (const [key, p] of Object.entries(model.servicingProcesses!)) {
    // "done" is the model's one end; the step ids of the model's other processes' steps are never targets here.
    processDbIds.set(key, await makeProcess(p.name, "servicing", "task", p.entry, p.steps.map((id) => stepById.get(id)!), { done: "done" }));
    processes++;
  }

  // ---- servicing links: every tier of the department runs the process, at the tier's rate -------------------------------------------------
  let links = 0;
  for (const [sid, sv] of Object.entries(model.services!)) {
    for (const link of sv.servicing ?? []) {
      const recurrence = driverRecurrences ? link.recurrence : fixedRecurrence(link.recurrence, sv.deliverables ?? {}, sv.adhoc);
      if (!recurrence) continue;
      await db.query(
        "insert into public.service_servicing (workspace_id, service_id, process_id, recurrence, sla_hours, provenance) values ($1, $2, $3, $4::jsonb, $5, $6::jsonb)",
        [workspaceId, serviceIds.get(sid), processDbIds.get(link.process), JSON.stringify(recurrence), link.sla, JSON.stringify({ recurrence: JSON.parse(ESTIMATE(at)), sla_hours: JSON.parse(ESTIMATE(at)) })],
      );
      links++;
    }
  }

  // ---- the prototype's 13 changes (P7): stored, so the Sandbox can swap them in. Their effects point at the step rows above ----------------------
  let changes = 0;
  if ((await rows("select 1 from information_schema.tables where table_schema = 'public' and table_name = 'capacity_changes'")).length > 0) {
    for (const c of model.changes ?? []) {
      const effects = c.effects.map((e) => ({ ...e, step: stepDbIds.get(e.step) ?? e.step }));
      await db.query(
        "insert into public.capacity_changes (workspace_id, name, kind, effects, adoption, ramp_months, tiers, source) values ($1, $2, $3, $4::jsonb, $5, $6, $7, 'estimate')",
        [workspaceId, c.name, c.kind, JSON.stringify(effects), c.adoption, c.rampMonths, c.tiers ?? null],
      );
      changes++;
    }
  }
  return { applied: true, people: personIds.size, clients, processes, steps, links, stepBaseValues, driverRecurrences, changes };
}

import {
  factorsFromPercents,
  flattenModel,
  isFlatDemand,
  isNeutralMarket,
  marketFromSchedule,
  NestingError,
  type EngineMarket,
  type EngineDemand,
  type Distribution as EngineDistribution,
  type EngineClient,
  type EngineChurnDriver,
  type EngineClientGroup,
  type EngineEnd,
  type EngineHealthRules,
  type EngineGroup,
  type EngineModel,
  type EnginePerson,
  type EngineService,
  type EngineServicingProcess,
  type EngineStep,
} from "@transpera-flow/engine";
import { engineRecurrence } from "./servicing";
import type { DistParams, Distribution, EdgeRow, LeadSourceRow, ProcessBundle, ProcessPart, SeasonalityRow, StepRow, WorkspaceSettings } from "./types";

const WORKING_DAYS_PER_WEEK = 5;
const DAY_MS = 86_400_000;

/** Working days (Mon–Fri) from `from` up to, not including, `to`. Negative if `to` is earlier. */
export function workingDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (b < a) return -workingDaysBetween(to, from);
  let days = 0;
  for (let t = a; t < b; t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return days;
}

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

export interface ModelOptions {
  /** ISO date the simulation starts on; leave and start/end dates are measured from it. Defaults to today. */
  startDate?: string;
}

export class ModelError extends Error {}

/** The graph of one process revision, resolved for the engine. */
interface Graph {
  /** The step (or end) the start step leads to. */
  entry: string;
  /** Working (leaf) steps, by id, including those of child processes held by its steps. */
  working: EngineStep[];
  /** End steps, by id. A child process's `done` ends are not here: they are exits of its group. */
  endSteps: StepRow[];
  /** The process's target time end to end, in working hours, set on its start step (rule 13). */
  targetCycleHours: number | null;
  /** Its groups, and the child processes its steps hold as groups, by the holder step's id. */
  groups: Record<string, EngineGroup>;
}

/** The processes a graph's holder steps may hold (live revisions), and those on the way down, to refuse loops. */
interface GraphContext {
  parts: ReadonlyMap<string, ProcessPart>;
  stack: readonly string[];
}

const NO_CONTEXT: GraphContext = { parts: new Map(), stack: [] };

/**
 * A process revision's graph: its single start step's edge is the entry, and
 * every edge leads to a working step or an end step of the same revision.
 * `tags`: whether edges keep their condition tags (only when there are services).
 *
 * Nesting (issue #102): a `group` step becomes an engine group (its steps point
 * at it); a `subprocess` step holding a child process becomes a group of the
 * child's own graph, resolved the same way (its `done` ends are the group's
 * exits; its `won` and `lost` ends stay ends). Neither is a working step, so
 * the engine simulates leaf steps only; `flattenModel` does the rest.
 */
function resolveGraph(steps: StepRow[], edges: EdgeRow[], tags: boolean, ctx: GraphContext = NO_CONTEXT): Graph {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const starts = steps.filter((step) => step.kind === "start");
  if (starts.length !== 1) throw new ModelError(`Process needs exactly one start step, found ${starts.length}`);
  const startEdges = edges.filter((e) => e.from_step_id === starts[0]!.id);
  if (startEdges.length !== 1) throw new ModelError("The start step needs exactly one outgoing edge");
  const entry = startEdges[0]!.to_step_id;

  /** An edge may lead to a working step or an end step (any outcome); anything else would strand items in the engine. */
  const checkTarget = (from: string, to: string) => {
    const target = byId.get(to);
    if (!target) throw new ModelError(`Edge from '${from}' points at a missing step`);
    if (target.kind === "start") throw new ModelError(`Edge from '${from}' leads back to the start step`);
  };
  checkTarget(starts[0]!.name, entry);

  // Tags route only entities whose service carries them, so without services they are left out.
  const tagOf = (tag: string | null) => (tags && tag?.trim() ? { tag: tag.trim() } : {});
  const edgesOut = (step: StepRow) =>
    edges
      .filter((e) => e.from_step_id === step.id)
      .sort(byIdAsc)
      .map((e) => ({ to: e.to_step_id, p: Number(e.probability), ...tagOf(e.condition_tag) }));
  const parentOf = (step: StepRow) => {
    if (step.parent_step_id === null || step.parent_step_id === undefined) return {};
    if (byId.get(step.parent_step_id)?.kind !== "group") throw new ModelError(`Step '${step.name}' sits inside a group that isn't there`);
    return { parent: step.parent_step_id };
  };

  const groups: Record<string, EngineGroup> = {};
  const heldSteps: EngineStep[] = [];
  const heldEnds: StepRow[] = [];
  for (const step of steps.filter(isHolderStep).sort(byIdAsc)) {
    const next = edgesOut(step);
    for (const n of next) checkTarget(step.name, n.to);
    if (step.kind === "group") {
      const entryStep = step.entry_step_id ? byId.get(step.entry_step_id) : undefined;
      if (!steps.some((s) => s.parent_step_id === step.id)) throw new ModelError(`Group '${step.name}' has no steps`);
      if (!entryStep) throw new ModelError(`Group '${step.name}' needs a first step`);
      groups[step.id] = { name: step.name, ...parentOf(step), entry: entryStep.id, next };
      continue;
    }
    // The step's link is what puts the child here (B12): the revision being simulated says what it holds, whatever holds the
    // child elsewhere. (A process is in at most one live version; the database refuses a second on publish.)
    // A link back to a process this one sits inside (at any depth) is a loop, whether or not that process is among the parts.
    if (ctx.stack.includes(step.child_process_id!)) {
      const name = ctx.parts.get(step.child_process_id!)?.process.name ?? step.name;
      throw new ModelError(`this would put '${name}' inside itself: '${step.name}' links back to it. Take one of the links out`);
    }
    const child = ctx.parts.get(step.child_process_id!);
    if (!child) throw new ModelError(`Publish '${step.name}' first: this step links to it, and it has no published version yet`);
    let sub: Graph;
    try {
      sub = resolveGraph(child.steps, child.edges, tags, { parts: ctx.parts, stack: [...ctx.stack, child.process.id] });
    } catch (err) {
      throw err instanceof ModelError ? new ModelError(`Child process '${child.process.name}': ${err.message}`) : err;
    }
    const done = sub.endSteps.filter((e) => e.outcome === "done").map((e) => e.id);
    groups[step.id] = { name: step.name, ...parentOf(step), entry: sub.entry, next, ...(done.length ? { exits: done } : {}) };
    // The child's steps and groups sit inside the holder's group.
    for (const [id, g] of Object.entries(sub.groups)) groups[id] = g.parent === undefined ? { ...g, parent: step.id } : g;
    heldSteps.push(...sub.working.map((w) => (w.parent === undefined ? { ...w, parent: step.id } : w)));
    heldEnds.push(...sub.endSteps.filter((e) => e.outcome !== "done"));
  }

  const working = steps
    .filter((step) => step.kind !== "start" && step.kind !== "end" && !isHolderStep(step))
    .sort(byIdAsc)
    .map((step): EngineStep => {
      const next = edgesOut(step);
      // Inside a group, no way out means leaving the group.
      if (!next.length && !step.parent_step_id) throw new ModelError(`Step '${step.name}' has no outgoing edge`);
      for (const n of next) checkTarget(step.name, n.to);
      return {
        id: step.id,
        name: step.name,
        role: step.role_id,
        ...(step.person_id ? { person: step.person_id } : {}),
        work: Number(step.work_hours),
        wait: Number(step.wait_hours),
        rework: Number(step.rework_rate),
        ...optional("workDist", engineDistribution(step.work_dist, step.work_params, Number(step.work_hours))),
        ...optional("waitDist", engineDistribution(step.wait_dist, step.wait_params, Number(step.wait_hours))),
        // Entered WIP (0 included) makes the run start from it instead of a warm-up.
        ...(step.current_wip != null ? { currentWip: Number(step.current_wip) } : {}),
        // An SLA only counts breaches (detected issues); it doesn't change the run.
        ...(step.sla_hours != null ? { sla: Number(step.sla_hours) } : {}),
        // The rules' per-step settings (docs/analysis-rules.md rules 5, 12): they rate the report, not the run.
        ...(step.expected_wait_hours != null ? { expectedWaitHours: Number(step.expected_wait_hours) } : {}),
        ...(step.lost_per_day_waiting != null ? { lostPerDayWaiting: Number(step.lost_per_day_waiting) } : {}),
        ...(step.dropoff_benchmark != null ? { dropoffBenchmark: Number(step.dropoff_benchmark) } : {}),
        ...parentOf(step),
        next,
      };
    });
  return {
    entry,
    // Sorted by id with the child processes' steps among them, so the order doesn't depend on how the model is nested.
    working: heldSteps.length ? [...working, ...heldSteps].sort(byIdAsc) : working,
    // The process's own ends first, so its win and loss are the model's sinks.
    endSteps: [...steps.filter((step) => step.kind === "end").sort(byIdAsc), ...heldEnds],
    groups,
    targetCycleHours: starts[0]!.target_cycle_hours != null ? Number(starts[0]!.target_cycle_hours) : null,
  };
}

/**
 * The pipeline a run simulates: the bundle's own process, or, for a
 * servicing process, the pipeline it runs beside (the first of the other
 * processes that is one).
 */
function pipelineOf(bundle: ProcessBundle): ProcessPart {
  if (bundle.process.kind !== "servicing") {
    return { process: bundle.process, revision: bundle.revision, steps: bundle.steps, edges: bundle.edges };
  }
  // A child process runs inside the process that holds it, never as the business pipeline.
  const pipeline = (bundle.otherProcesses ?? []).find((p) => p.process.kind !== "servicing" && !p.process.parent_process_id);
  if (!pipeline) throw new ModelError("A servicing process runs beside a pipeline; publish a pipeline process to simulate it");
  return pipeline;
}

/**
 * Resolve a stored process revision into the engine's model.
 *
 * - The single `start` step marks the entry: its one outgoing edge points at
 *   the first real step.
 * - Client servicing (see `engineServicing`): the servicing processes the
 *   services' clients run, their steps beside the pipeline's. A servicing
 *   process's bundle simulates the whole business too: the pipeline it runs
 *   beside, with this process at the bundle's revision (its draft, say).
 * - `end` steps by outcome: the first `won` and first `lost` (by id) become
 *   the engine's sinks; any further `won`/`lost` ends and every `done` end go
 *   to `ends`.
 * - Services (see `engineServices`) and, only when there are some, the edges'
 *   condition tags. A process with no services maps exactly as it did before
 *   services existed.
 * - Arrivals (see `arrivalsPerWeek` and `engineDemand`): the lead sources'
 *   qualified leads split by the services mix, with seasonality and growth
 *   placed in the calendar from the start date. Flat demand is left out.
 * - The client roster (see `engineClients`) and the overtime cap. A
 *   workspace with no clients maps exactly as before the roster existed.
 * - Client groups (see `engineClientGroups`): clients counted per service.
 *   With any, they replace the named roster, which the engine no longer sees.
 * - Steps and roles are ordered by id so the result, and therefore the
 *   simulation, doesn't depend on database row order.
 */
export function toEngineModel(bundle: ProcessBundle, options: ModelOptions = {}): EngineModel {
  const { workspace, roles } = bundle;
  const s = workspace.settings;
  // The company map's steps are holders of whole processes, laid out as a picture: nothing to simulate (B11).
  if (bundle.process.is_company) throw new ModelError("The company map is a picture of the business, not a process: it can't be simulated. Simulate one of its processes.");
  const pipeline = pipelineOf(bundle);
  const baseServices = engineServices(bundle, pipeline.process.id);
  const held = heldProcesses(bundle);
  const { entry, working: pipelineSteps, endSteps, groups: pipelineGroups, targetCycleHours } = resolveGraph(pipeline.steps, pipeline.edges, Boolean(baseServices), {
    parts: held,
    stack: [pipeline.process.id],
  });

  const sinkFor = (outcome: "won" | "lost") => endSteps.find((step) => step.outcome === outcome)?.id ?? `__${outcome}__`;
  const sinks = { won: sinkFor("won"), lost: sinkFor("lost") };
  const ends: Record<string, EngineEnd> = {};
  for (const step of endSteps) {
    // The database requires an outcome on every end step; "done" is the harmless reading of a missing one.
    if (step.id !== sinks.won && step.id !== sinks.lost) ends[step.id] = { outcome: step.outcome ?? "done" };
  }

  const servicing = engineServicing(bundle, baseServices, held);
  const services = servicing.services;
  const working = [...pipelineSteps, ...servicing.steps];
  const groups = { ...pipelineGroups, ...servicing.groups };
  Object.assign(ends, servicing.ends);

  const engineRoles: EngineModel["roles"] = {};
  for (const role of [...roles].sort(byIdAsc)) {
    engineRoles[role.id] = {
      name: role.name,
      count: role.headcount,
      cost: Number(role.default_cost_rate),
      ongoing: Number(role.ongoing_hours_per_client_week),
    };
  }

  const startDate = options.startDate ?? new Date().toISOString().slice(0, 10);
  const people = resolvePeopleRows(bundle, working, startDate);
  const demand = engineDemand(bundle, startDate);
  // Client groups replace the named roster, which stays stored but is not simulated.
  const clientGroups = engineClientGroups(bundle, services);
  const clients = clientGroups ? undefined : engineClients(bundle, services, startDate);
  const market = engineMarket(bundle);
  const churnDrivers = engineChurnDrivers(bundle);

  const model: EngineModel = {
    horizonWeeks: s.horizon_weeks,
    hoursPerWeek: s.hours_per_week,
    leadsPerWeek: arrivalsPerWeek(bundle, services),
    ...(demand ? { demand } : {}),
    ...(market ? { market } : {}),
    ...(churnDrivers ? { churnDrivers } : {}),
    activeClients: clientGroups
      ? Object.values(clientGroups).reduce((a, g) => a + Math.round(g.count), 0)
      : clients
        ? Object.keys(clients).length
        : s.active_clients,
    churnMonthly: s.churn_monthly,
    retainer: s.retainer,
    roles: engineRoles,
    ...(services ? { services } : {}),
    ...(people ? { people } : {}),
    ...(s.availability_floor !== undefined ? { availabilityFloor: s.availability_floor } : {}),
    ...(s.overtime_cap !== undefined && s.overtime_cap !== null ? { overtimeCap: Number(s.overtime_cap) } : {}),
    ...(clients ? { clients } : {}),
    ...(clientGroups ? { clientGroups } : {}),
    ...(Object.keys(servicing.processes).length ? { servicingProcesses: servicing.processes } : {}),
    ...optional("health", healthRules(s)),
    ...(targetCycleHours !== null ? { targetCycleHours } : {}),
    ...(Object.keys(groups).length ? { groups } : {}),
    entry,
    sinks,
    ...(Object.keys(ends).length ? { ends } : {}),
    steps: working,
  };
  // Groups and child processes are a view: the engine's model is the leaf steps (a no-op without any).
  try {
    return flattenModel(model);
  } catch (err) {
    // A group with nowhere to go, or a loop of groups, is a problem with the process, as any other bad graph is.
    if (err instanceof NestingError) {
      // The engine calls every holder a group; a step linking a process is called by its name, as the person sees it.
      const stuck = /^Group '(.*)' has nothing leaving it/.exec(err.message)?.[1];
      const all = [...bundle.steps, ...(bundle.otherProcesses ?? []).flatMap((p) => p.steps)];
      if (stuck !== undefined && all.some((x) => x.name === stuck && x.child_process_id) && !all.some((x) => x.name === stuck && x.kind === "group")) {
        throw new ModelError(`'${stuck}' has nothing leaving it: join it to a next step`);
      }
      throw new ModelError(err.message);
    }
    throw err;
  }
}

/**
 * The processes steps of this run's processes may hold, by id, at their live
 * revisions: every one the bundle carries (`loadServicingContext` loads the
 * ones the run's revisions link to, any depth). Only a holder step's link
 * brings one into the run.
 */
function heldProcesses(bundle: ProcessBundle): Map<string, ProcessPart> {
  const parts = new Map<string, ProcessPart>();
  for (const p of bundle.otherProcesses ?? []) parts.set(p.process.id, p);
  return parts;
}

/**
 * The engine's services for this process: the workspace's active services
 * whose arrivals enter it. PRD §5 gives a service an `entry_process_id`, not a
 * step. A service entering this process, or with none set (meaning the
 * workspace's pipeline), enters at the process's own entry step, which is the
 * engine's default, so `entry` is left out. Services entering another process
 * don't arrive here. Undefined when none apply: then the interim `retainer`
 * prices every win, as before services existed.
 */
function engineServices(bundle: ProcessBundle, processId: string): Record<string, EngineService> | undefined {
  const here = bundle.services
    .filter((sv) => sv.active && (sv.entry_process_id === null || sv.entry_process_id === processId))
    .sort(byIdAsc);
  if (!here.length) return undefined;
  if (!(here.reduce((sum, sv) => sum + Number(sv.mix_share), 0) > 0)) {
    throw new ModelError("The services' mix shares add up to 0; give at least one service a share");
  }
  const services: Record<string, EngineService> = {};
  const roleIds = new Set(bundle.roles.map((r) => r.id));
  for (const sv of here) {
    const fallback = fallbackLoad(sv.fallback_ongoing_load, roleIds);
    services[sv.id] = {
      name: sv.name,
      pricingModel: sv.pricing_model,
      price: Number(sv.price),
      margin: Number(sv.margin),
      tenureMonths: Number(sv.tenure_months),
      churnMonthly: Number(sv.churn_monthly_base),
      // Rows written before it existed may not carry it: then health doesn't move churn.
      ...(sv.churn_health_sensitivity != null && Number.isFinite(Number(sv.churn_health_sensitivity))
        ? { churnSensitivity: Number(sv.churn_health_sensitivity) }
        : {}),
      mixShare: Number(sv.mix_share),
      pathTags: sv.path_tags.map((t) => t.trim()).filter(Boolean),
      ...(fallback ? { fallbackOngoing: fallback } : {}),
    };
  }
  return services;
}

/**
 * A service's fallback ongoing load for the engine: hours a month by role id,
 * for the workspace's roles, in id order. Undefined when none is entered, so
 * the roles' hours per client apply (docs/PRD.md §6.3.4).
 */
function fallbackLoad(stored: unknown, roleIds: Set<string>): Record<string, number> | undefined {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const entries = Object.entries(stored as Record<string, unknown>)
    .map(([rid, v]) => [rid, num(v)] as const)
    .filter((e): e is readonly [string, number] => roleIds.has(e[0]) && e[1] !== null && e[1] >= 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Client servicing for the engine (docs/PRD.md §6.2 `servicing`, §6.3.5):
 * the servicing processes the services' clients run, at their live revision
 * (or, for the bundle's own process, the bundle's revision), with their
 * working steps (after the pipeline's, by process id and then step id) and
 * their ends (all `done`: a task books nothing), and each service's links.
 * Links to processes that aren't servicing or have no revision here, or with
 * a malformed recurrence, are left out. Nothing when there are no links, so
 * a workspace without servicing maps exactly as before.
 */
function engineServicing(
  bundle: ProcessBundle,
  services: Record<string, EngineService> | undefined,
  held: ReadonlyMap<string, ProcessPart>,
): {
  services: Record<string, EngineService> | undefined;
  steps: EngineStep[];
  ends: Record<string, EngineEnd>;
  processes: Record<string, EngineServicingProcess>;
  groups: Record<string, EngineGroup>;
} {
  const none = { services, steps: [], ends: {}, processes: {}, groups: {} };
  if (!services) return none;
  const parts = new Map<string, ProcessPart>();
  for (const p of bundle.otherProcesses ?? []) if (p.process.kind === "servicing") parts.set(p.process.id, p);
  if (bundle.process.kind === "servicing") {
    parts.set(bundle.process.id, { process: bundle.process, revision: bundle.revision, steps: bundle.steps, edges: bundle.edges });
  }
  const links = (bundle.servicingLinks ?? [])
    .filter((l) => l.service_id in services && parts.has(l.process_id))
    .map((l) => ({ l, recurrence: engineRecurrence(l.recurrence), sla: Number(l.sla_hours) }))
    .filter((x) => x.recurrence !== null && x.sla > 0)
    .sort((a, b) => cmp(a.l.process_id, b.l.process_id) || cmp(a.l.id, b.l.id));
  // The bundle's own servicing process is simulated even before it is linked, so its steps show results.
  const used = [...new Set([...links.map((x) => x.l.process_id), ...(bundle.process.kind === "servicing" ? [bundle.process.id] : [])])].sort(cmp);
  if (!used.length) return none;

  const steps: EngineStep[] = [];
  const ends: Record<string, EngineEnd> = {};
  const processes: Record<string, EngineServicingProcess> = {};
  const groups: Record<string, EngineGroup> = {};
  for (const pid of used) {
    const part = parts.get(pid)!;
    let graph: Graph;
    try {
      graph = resolveGraph(part.steps, part.edges, true, { parts: held, stack: [pid] });
    } catch (err) {
      if (err instanceof ModelError && pid !== bundle.process.id) throw new ModelError(`Servicing process '${part.process.name}': ${err.message}`);
      throw err;
    }
    steps.push(...graph.working);
    Object.assign(groups, graph.groups);
    for (const end of graph.endSteps) ends[end.id] = { outcome: "done" };
    processes[pid] = { name: part.process.name, entry: graph.entry, steps: graph.working.map((st) => st.id) };
  }
  const withLinks: Record<string, EngineService> = {};
  for (const [sid, sv] of Object.entries(services)) {
    const mine = links.filter((x) => x.l.service_id === sid);
    withLinks[sid] = mine.length ? { ...sv, servicing: mine.map((x) => ({ process: x.l.process_id, recurrence: x.recurrence!, sla: x.sla })) } : sv;
  }
  return { services: withLinks, steps, ends, processes, groups };
}

/** Health rules from the workspace settings; undefined when none is set, so the engine's estimated defaults apply. */
function healthRules(s: WorkspaceSettings): EngineHealthRules | undefined {
  const pick = (v: unknown) => (v !== undefined && v !== null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  const rules: EngineHealthRules = {
    ...optional("initial", pick(s.health_initial)),
    ...optional("recover", pick(s.health_recover)),
    ...optional("latePenalty", pick(s.health_late_penalty)),
    ...optional("missedPenalty", pick(s.health_missed_penalty)),
  };
  return Object.keys(rules).length ? rules : undefined;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The client roster for the engine (docs/PRD.md §6.2, decision D13): active
 * clients that had started by the start date, in id order, with the services
 * among this process's that they take and their assignments per role.
 * Services entering other processes aren't in the engine model, so a client
 * with only those carries the roles' hours per client. Undefined when the
 * workspace has no clients at all: then the interim `active_clients` count
 * applies, as before the roster existed.
 */
function engineClients(
  bundle: ProcessBundle,
  services: Record<string, EngineService> | undefined,
  startDate: string,
): Record<string, EngineClient> | undefined {
  const rows = bundle.clients ?? [];
  if (!rows.length) return undefined;
  const roleIds = new Set(bundle.roles.map((r) => r.id));
  const clients: Record<string, EngineClient> = {};
  for (const c of [...rows].sort(byIdAsc)) {
    if (!c.active || (c.start_date && c.start_date > startDate)) continue;
    const assignments: Record<string, string> = {};
    for (const a of (bundle.clientAssignments ?? [])
      .filter((a) => a.client_id === c.id && roleIds.has(a.role_id))
      .sort((a, b) => (a.role_id < b.role_id ? -1 : a.role_id > b.role_id ? 1 : 0))) {
      assignments[a.role_id] = a.person_id;
    }
    clients[c.id] = {
      name: c.name,
      services: (bundle.clientServices ?? [])
        .filter((cs) => cs.client_id === c.id && services && cs.service_id in services)
        .map((cs) => cs.service_id)
        .sort(),
      mrr: Number(c.mrr),
      ...(c.health !== null && c.health !== undefined ? { health: Number(c.health) } : {}),
      assignments,
    };
  }
  return clients;
}

/**
 * The churn drivers you have set, for the engine (A56): a built-in's row by its
 * key, your own as `custom:<id>`, in creation order. Undefined with no rows, so
 * such a workspace simulates exactly as before churn drivers existed.
 */
export function engineChurnDrivers(bundle: ProcessBundle): EngineChurnDriver[] | undefined {
  const out: EngineChurnDriver[] = [];
  for (const d of bundle.churnDrivers ?? []) {
    out.push({
      id: d.driver ?? `custom:${d.id}`,
      weight: Number(d.weight),
      enabled: d.enabled,
      ...(d.value !== null && d.value !== undefined ? { value: Number(d.value) } : {}),
      ...(d.month !== null && d.month !== undefined ? { month: Number(d.month) } : {}),
      ...(d.driver === null ? { name: d.name ?? "" } : {}),
    });
  }
  return out.length ? out : undefined;
}

/**
 * Clients counted per service for the engine (docs/PRD.md decision D27; issue
 * #120): one group for each service among this process's that has a row. With
 * any, the engine simulates unnamed clients from them and the named roster is
 * left out (it stays in the database, hidden). Undefined when no group applies:
 * then the named roster, or the interim `active_clients`, as before.
 */
function engineClientGroups(bundle: ProcessBundle, services: Record<string, EngineService> | undefined): Record<string, EngineClientGroup> | undefined {
  const groups: Record<string, EngineClientGroup> = {};
  for (const g of [...(bundle.clientGroups ?? [])].sort((a, b) => cmp(a.service_id, b.service_id))) {
    if (!services || !(g.service_id in services)) continue;
    groups[g.service_id] = {
      count: Number(g.client_count),
      fee: Number(g.fee),
      churnMonthly: Number(g.churn_monthly),
      stayMonths: Number(g.stay_months),
      health: Number(g.starting_health),
    };
  }
  // Switch to groups only once some clients are counted; all-zero groups leave the interim count or roster in place.
  const counted = Object.values(groups).reduce((a, g) => a + Math.round(g.count), 0);
  return counted > 0 ? groups : undefined;
}

/**
 * Qualified leads a week from the lead sources: Σ volume × conversion
 * (docs/PRD.md §6.2), summed in id order so the result doesn't depend on row
 * order. Null when there are none.
 */
export function qualifiedLeadsPerWeek(
  sources: readonly Pick<LeadSourceRow, "id" | "volume_week" | "conversion_to_qualified">[],
): number | null {
  if (!sources.length) return null;
  return [...sources].sort(byIdAsc).reduce((sum, src) => sum + Number(src.volume_week) * Number(src.conversion_to_qualified), 0);
}

/** The seasonality curve: twelve multipliers, January first. A month with no row is 1. */
export function seasonalityCurve(rows: readonly Pick<SeasonalityRow, "month" | "multiplier">[]): number[] {
  const curve = new Array<number>(12).fill(1);
  for (const row of rows) if (row.month >= 1 && row.month <= 12) curve[row.month - 1] = Number(row.multiplier);
  return curve;
}

/**
 * This process's arrivals a week (docs/PRD.md §6.2): the lead sources'
 * qualified leads (or, with none, the interim `settings.leads_per_week`),
 * times the share of the active services' mix that enters this process.
 * The share is exactly 1 when every active service enters here, as in a
 * single-pipeline workspace, and 0 when none does.
 */
function arrivalsPerWeek(bundle: ProcessBundle, here: Record<string, EngineService> | undefined): number {
  const total = qualifiedLeadsPerWeek(bundle.leadSources ?? []) ?? bundle.workspace.settings.leads_per_week;
  const mix = (shares: number[]) => shares.reduce((sum, m) => sum + m, 0);
  const all = mix(bundle.services.filter((sv) => sv.active).sort(byIdAsc).map((sv) => Number(sv.mix_share)));
  // No mix to split by: every arrival is this process's.
  if (!(all > 0)) return total;
  const mine = here ? mix(Object.values(here).map((sv) => sv.mixShare)) : 0;
  return mine === all ? total : (total * mine) / all;
}

/**
 * The market schedule for the engine (A57): the 24 months from the workspace's
 * schedule and conditions. Undefined with no schedule, or when every month is
 * Stable, so such a workspace simulates exactly as before market conditions
 * existed.
 */
export function engineMarket(bundle: ProcessBundle): EngineMarket | undefined {
  const schedule = bundle.marketSchedule ?? [];
  if (!schedule.length) return undefined;
  const byId = new Map((bundle.marketConditions ?? []).map((c) => [c.id, c]));
  const market = marketFromSchedule(
    schedule.map((e) => ({ from: e.from_month, to: e.to_month, condition: e.condition_id })),
    (id) => {
      const c = byId.get(id);
      return c ? factorsFromPercents(c) : undefined;
    },
  );
  return isNeutralMarket(market) ? undefined : market;
}

/**
 * Seasonality and growth for the engine, with the start date placed in the
 * calendar (1 September is month 8; the 16th of a 30-day month is half a
 * month further on). Undefined when flat with no growth, so such a
 * workspace simulates exactly as before demand settings existed.
 */
function engineDemand(bundle: ProcessBundle, startDate: string): EngineDemand | undefined {
  const seasonality = seasonalityCurve(bundle.seasonality ?? []);
  const growth = Number(bundle.demand?.growth_monthly ?? 0);
  const [year, month, day] = startDate.split("-").map(Number) as [number, number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const demand: EngineDemand = {
    ...(seasonality.some((m) => m !== 1) ? { seasonality } : {}),
    ...(growth ? { growthMonthly: growth } : {}),
    startMonth: month - 1 + (day - 1) / daysInMonth,
  };
  return isFlatDemand(demand) ? undefined : demand;
}

/**
 * Named people for the engine: active people employed on the start date, with
 * capacity from their hours (or FTE × the workspace week), their roles, the
 * steps of this process they are skilled for, and leave as simulation hours.
 * Returns undefined when the workspace has no people, so head-counts apply.
 */
function resolvePeopleRows(bundle: ProcessBundle, working: EngineStep[], startDate: string) {
  const s = bundle.workspace.settings;
  const hoursPerDay = s.hours_per_week / WORKING_DAYS_PER_WEEK;
  const roleIds = new Set(bundle.roles.map((r) => r.id));
  const stepIds = new Set(working.map((st) => st.id));
  const employed = bundle.people
    .filter((p) => p.active)
    .filter((p) => (!p.start_date || p.start_date <= startDate) && (!p.end_date || p.end_date >= startDate))
    .sort(byIdAsc);
  if (!employed.length) return undefined;

  const people: Record<string, EnginePerson> = {};
  for (const p of employed) {
    const skillRows = bundle.personSkills.filter((k) => k.person_id === p.id);
    const leave = bundle.personLeave
      .filter((l) => l.person_id === p.id)
      .map((l): [number, number] => [
        Math.max(0, workingDaysBetween(startDate, l.start_date)) * hoursPerDay,
        workingDaysBetween(startDate, nextDay(l.end_date)) * hoursPerDay,
      ])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    people[p.id] = {
      name: p.name,
      roles: bundle.personRoles
        .filter((r) => r.person_id === p.id && roleIds.has(r.role_id))
        .map((r) => r.role_id)
        .sort(),
      capacity: p.capacity_hours_week != null ? Number(p.capacity_hours_week) : Number(p.fte) * s.hours_per_week,
      ...(p.cost_rate != null ? { cost: Number(p.cost_rate) } : {}),
      ...(skillRows.length ? { skills: skillRows.map((k) => k.step_id).filter((id) => stepIds.has(id)).sort() } : {}),
      ...(leave.length ? { leave } : {}),
    };
  }
  return people;
}

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/** A finite number from a jsonb value, or null. */
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;

/**
 * A triangular range in hours from a step's params. Missing or inconsistent
 * values fall back to half to one and a half times the mean, peaking at it.
 */
export function triangularRange(params: DistParams | null | undefined, mean: number): { min: number; mode: number; max: number } {
  const min = num(params?.min);
  const mode = num(params?.mode);
  const max = num(params?.max);
  if (min !== null && mode !== null && max !== null && min >= 0 && min <= mode && mode <= max) return { min, mode, max };
  return { min: mean * 0.5, mode: mean, max: mean * 1.5 };
}

/**
 * The engine's distribution for a stored `*_dist` and `*_params`. Undefined
 * means the engine's default (lognormal with its default spread), which is
 * what a lognormal step without a `cv` gets, so untouched rows simulate as before.
 */
export function engineDistribution(
  dist: Distribution,
  params: DistParams | null | undefined,
  mean: number,
): EngineDistribution | undefined {
  if (dist === "constant") return { kind: "constant" };
  if (dist === "triangular") return { kind: "triangular", ...triangularRange(params, mean) };
  const cv = num(params?.cv);
  return cv !== null && cv >= 0 ? { kind: "lognormal", cv } : undefined;
}

function byIdAsc(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A step that holds others: a group, or a step holding a child process. It does no work itself (issue #102). */
export function isHolderStep(step: Pick<StepRow, "kind" | "child_process_id">): boolean {
  return step.kind === "group" || (step.child_process_id !== null && step.child_process_id !== undefined);
}

/** A step that does work, so the engine simulates it: not a start, an end or a holder of other steps. */
export function isWorkingStep(step: StepRow): boolean {
  return step.kind !== "start" && step.kind !== "end" && !isHolderStep(step);
}

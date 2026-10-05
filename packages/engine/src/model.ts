// Engine input and output shapes. This is the prototype's model, extended so
// far with named people, services, end-step outcomes, seasonal demand, a client
// roster, overtime, and client servicing with health and churn (docs/PRD.md §6).

import type { ChurnCauses, ChurnReplication, EngineChurnDriver } from "./churn-drivers";
import type { EngineMarket } from "./market";
import type { Loop } from "./loops";

/** Times are in working hours. */
export interface EngineRole {
  name: string;
  /** Number of interchangeable people in the role; used only when the model has no `people`. */
  count: number;
  /** Cost per hour. */
  cost: number;
  /** Ongoing (retainer) hours per active client per week. */
  ongoing: number;
}

/**
 * How a duration varies around its mean. Triangular uses its own bounds, so
 * its mean is (min + mode + max) / 3.
 */
export type Distribution =
  | { kind: "lognormal"; cv: number }
  | { kind: "exponential" }
  | { kind: "constant" }
  | { kind: "triangular"; min: number; mode: number; max: number };

/** A named person who does the work (docs/PRD.md §6.3.3). */
export interface EnginePerson {
  name: string;
  /** Role ids; ongoing client load and utilisation roll up to these roles. */
  roles: string[];
  /** Working hours per week (FTE × the workspace's hours per week). */
  capacity: number;
  /** Step ids this person can perform; omitted means every step of their roles. */
  skills?: string[];
  /** Leave windows as [start, end) in simulation hours; no new work starts during leave. */
  leave?: [number, number][];
  /** Cost per hour, for overtime cost; omitted means the mean of their roles' costs. */
  cost?: number;
}

export interface EngineEdge {
  /** Target step id, or an end id (a sink or a key of `ends`). */
  to: string;
  /** Branch probability; a step's edges sum to 1. */
  p: number;
  /**
   * Condition tag (docs/PRD.md §6.3.6): tagged edges take precedence for
   * entities whose service carries the tag; the others split between the
   * untagged edges (see `routeFor` in simulate.ts). Ignored when the model
   * has no services.
   */
  tag?: string;
}

/** What reaching an end step means (docs/PRD.md §6.4, decision D8). */
export type Outcome = "won" | "lost" | "done";

/**
 * An end step beyond the two `sinks`. With `handoff`, the entity carries on
 * at that step: this is how a pipeline's `won` end chains into a downstream
 * process (onboarding, delivery) once processes are flattened into one model.
 */
export interface EngineEnd {
  outcome: Outcome;
  /** Step the entity continues at, e.g. the entry of a downstream process. */
  handoff?: string;
}

/**
 * How a service is priced. Only retainers add MRR; hourly services bill
 * through servicing work, which the engine does not simulate yet, so for now
 * they add nothing to the revenue KPIs.
 */
export type PricingModel = "retainer" | "one_off" | "hourly";

/** Something the business sells (docs/PRD.md §5 `services`). */
export interface EngineService {
  name: string;
  pricingModel: PricingModel;
  /** Monthly fee for a retainer; the whole fee for a one-off; the rate for hourly. */
  price: number;
  /** Gross margin as a share of price (0–1); carried for reporting, not used by the KPIs yet. */
  margin: number;
  /** Expected tenure of a retainer client, in months (LTV and lost revenue). */
  tenureMonths: number;
  /** Base monthly churn of a client on this service; billed-in-horizon is net of it. */
  churnMonthly: number;
  /** Relative share of arrivals; shares are normalised over the model's services. */
  mixShare: number;
  /** Step this service's arrivals enter at; defaults to the model's `entry`. */
  entry?: string;
  /** Condition tags this service's entities follow (see `EngineEdge.tag`). */
  pathTags: string[];
  /**
   * Fallback ongoing load (docs/PRD.md §6.3.4): hours per month each client
   * on this service needs from each role id, for services with no servicing
   * process. Omitted: the roles' `ongoing` hours per client apply instead.
   * Used only when the model has a client roster (`EngineModel.clients`), and
   * ignored while the service has `servicing` processes: their tasks are the
   * client work then.
   */
  fallbackOngoing?: Record<string, number>;
  /**
   * How much a client's health raises its churn (docs/PRD.md §6.3.5): monthly
   * churn = `churnMonthly` × (1 + sensitivity × (100 − health) / 100).
   * Omitted: 0, so churn is the base rate whatever the health (as before
   * health existed). The database's default is the PRD's estimated 3.
   */
  churnSensitivity?: number;
  /**
   * Servicing processes each client on this service runs, and how often
   * (docs/PRD.md §5 `service_servicing`, §6.3.5). Only with a client roster.
   */
  servicing?: EngineServicingLink[];
}

/**
 * How often a client generates a servicing task (docs/PRD.md §5
 * `service_servicing.recurrence`): `times` tasks evenly spaced in every week
 * or month (a fortnightly check-in is `{every: "week", times: 0.5}`), or
 * ad-hoc requests at random, `poissonPerMonth` a month on average.
 */
export type Recurrence = { every: "week" | "month"; times: number } | { poissonPerMonth: number };

/** One servicing process a service's clients run (a monthly report, a fortnightly check-in). */
export interface EngineServicingLink {
  /** Key of `EngineModel.servicingProcesses`. */
  process: string;
  recurrence: Recurrence;
  /**
   * Working hours from a task's creation to its completion that count as on
   * time. Completed later is late; not completed within 2 × `sla` is missed.
   */
  sla: number;
}

/**
 * A servicing process: its working steps are in `EngineModel.steps` and its
 * end steps in `EngineModel.ends` (outcome `done`), beside the pipeline's. Its
 * tasks compete for the same people as the pipeline; at a step whose role the
 * client has an assigned person for, a task queues for that person only,
 * falling back to the role's pool while they are on leave (docs/PRD.md §6.3.3).
 */
export interface EngineServicingProcess {
  name: string;
  /** Step (or end) a task starts at. */
  entry: string;
  /** Ids of its working steps. */
  steps: string[];
}

/** How servicing moves client health (docs/PRD.md §6.3.5, decision D9). The defaults are estimates. */
export interface EngineHealthRules {
  /** Health of a client with none entered, and of clients won during the run (default 80). */
  initial?: number;
  /** Added for a task completed within its SLA, up to 100 (default 2). */
  recover?: number;
  /** Taken off for a task completed late (default 5). */
  latePenalty?: number;
  /** Taken off for a task not completed within 2 × its SLA (default 12). */
  missedPenalty?: number;
}

/**
 * A client on the roster (docs/PRD.md §5 `clients`, §6.2, decision D13).
 * Real clients seed the run; clients won during it are added as synthetic ones.
 */
export interface EngineClient {
  name: string;
  /** Service ids it takes. Ids the model doesn't know are ignored. */
  services: string[];
  /** Monthly recurring revenue: what it bills a month while active. */
  mrr: number;
  /**
   * Months it has been a client when the run starts, for what losing it is
   * worth (the tenure it has left, docs/analysis-rules.md "Cost per month").
   * Omitted: counted as new. It doesn't change the simulation.
   */
  monthsActive?: number;
  /** Health 0–100 at the start of the run. Omitted: `EngineHealthRules.initial` (80). */
  health?: number;
  /**
   * The person looking after it, per role id. A role with no assignment, or
   * one to a person the model doesn't have, is shared across that role's
   * members by capacity, as the pooled `ongoing` load is.
   */
  assignments: Record<string, string>;
}

/**
 * The clients of one service, counted instead of named (docs/PRD.md §3 "Client
 * group", decision D27). The engine simulates that many unnamed clients, each
 * billing `fee` a month, churning at `churnMonthly` and starting at `health`,
 * so late or missed servicing work still lowers health and drives churn
 * (see `withClientGroups` in clients.ts).
 */
export interface EngineClientGroup {
  /** How many clients the service has today (whole clients; rounded). */
  count: number;
  /** Average fee one client pays a month. */
  fee: number;
  /** Normal churn a month (0-1) at full health: the service's base churn for these clients and for clients won later. */
  churnMonthly: number;
  /** Typical stay in months: the service's expected tenure (lifetime value and lost revenue). */
  stayMonths: number;
  /** Average health at the start, 0-100. */
  health: number;
}

export interface EngineStep {
  id: string;
  name: string;
  /** Role that performs the step; null for pure waits/decisions. */
  role: string | null;
  /** Pinned assignee: only this person works the step. */
  person?: string | null;
  /** Mean hands-on hours. */
  work: number;
  /** Mean external wait after service, in hours. */
  wait: number;
  /** Probability of repeating the step. */
  rework: number;
  /** Defaults to lognormal with CV 0.35. */
  workDist?: Distribution;
  /** Defaults to lognormal with CV 0.3. */
  waitDist?: Distribution;
  /**
   * Items sitting at this step when the run starts (docs/PRD.md §6.3.1).
   * Entering WIP at any step starts the run from it instead of a warm-up.
   */
  currentWip?: number;
  /**
   * Target hours for one visit to the step, from queueing to leaving it
   * (queue, hands-on time and external wait). Visits over it are counted as
   * SLA breaches; it doesn't change how the step is worked.
   */
  sla?: number;
  /**
   * The group this step sits in (a key of `EngineModel.groups`), if any. A step
   * with no `next` inside a group leaves through the group's own `next`.
   */
  parent?: string;
  /**
   * How long an item may queue for a person before it counts as waiting too
   * long, in hours (docs/analysis-rules.md rule 5). Omitted: the rating
   * config's default for the step's kind (1 working day for pipeline steps, 2
   * for servicing steps). It rates the report; it doesn't change the simulation.
   */
  expectedWaitHours?: number;
  /**
   * The share of items that go cold for each working day they wait here
   * (0.05 is 5% a day), for the cost of waiting (docs/analysis-rules.md rule
   * 5, A43). It prices the report; it doesn't change the simulation.
   */
  lostPerDayWaiting?: number;
  /**
   * The share of the items leaving this step that may be lost here and still
   * be fine (0.3 is 30%), for "work lost at a step" (rule 12). Omitted: the
   * rule doesn't rate this step. It rates the report; it doesn't change the
   * simulation.
   */
  dropoffBenchmark?: number;
  next: EngineEdge[];
}

/**
 * A box of steps, or a child process, held by one step of the parent graph
 * (docs/PRD.md §4.1 nesting, issue #102). The engine simulates only the leaf
 * steps: `flattenModel` removes groups before a run, so a nested model gives
 * the same numbers as the same model drawn flat.
 */
export interface EngineGroup {
  name: string;
  /** The group this one sits in, if any. */
  parent?: string;
  /** Where entities enter: a leaf step, another group (its entry), or an end id. */
  entry: string;
  /**
   * Where entities go when they leave the group, as the parent graph's edges.
   * Empty: the group is the last thing in its own parent, so they leave that too.
   */
  next: EngineEdge[];
  /**
   * End ids inside the group that mean "leave the group" instead of ending the
   * run: a child process's `done` ends. An edge to one of them leaves through
   * `next`, and the id is no longer an end of the model.
   */
  exits?: string[];
}

/**
 * How demand moves with the calendar (docs/PRD.md §6.3.2). The arrival rate
 * in a calendar month is `leadsPerWeek × seasonality[month] × (1 +
 * growthMonthly)^k`, where k counts calendar months from the one the run
 * starts in (negative during a warm-up). Months are 52/12 weeks long, so
 * twelve of them make a 52-week year.
 */
export interface EngineDemand {
  /** Twelve multipliers on the rate, January first. Omitted: 1 in every month. */
  seasonality?: number[];
  /** Compound change in the rate per calendar month (0.02 is +2% a month). Omitted: 0. */
  growthMonthly?: number;
  /**
   * Where t = 0 falls in the calendar, in months since 1 January: 0 is
   * 1 January, 8 is 1 September, 8.5 is mid-September. Omitted: 0.
   */
  startMonth?: number;
}

export interface EngineModel {
  horizonWeeks: number;
  hoursPerWeek: number;
  /**
   * Mean arrivals per week: qualified leads into this process (docs/PRD.md
   * §6.2: lead sources' volume × conversion, split by the services mix).
   */
  leadsPerWeek: number;
  /**
   * Seasonality and growth on top of `leadsPerWeek`. Omitted, or flat with no
   * growth: a constant rate, simulated exactly as before this field existed.
   */
  demand?: EngineDemand;
  /**
   * Market conditions month by month from the start of the run (D29; see
   * market.ts). Omitted, or Stable in every month: the model runs exactly as
   * before this field existed.
   */
  market?: EngineMarket;
  activeClients: number;
  churnMonthly: number;
  /**
   * Monthly retainer price per won client. Used only when the model has no
   * `services`: then every entity is on one implicit retainer at this price,
   * churning at `churnMonthly`, with an expected tenure of 1 / `churnMonthly`
   * months (none, so no LTV, when churn is 0).
   */
  retainer: number;
  /**
   * Services by id. Each arrival is tagged with one, drawn from the mix, and
   * is routed and priced by it. Omitted or empty: the implicit retainer above.
   */
  services?: Record<string, EngineService>;
  roles: Record<string, EngineRole>;
  /** Named people. When omitted, each role gets `count` anonymous people. */
  people?: Record<string, EnginePerson>;
  /** Minimum share of a person's time left for pipeline work (default 0.08). */
  availabilityFloor?: number;
  /**
   * Overtime a person may work when their ongoing client load exceeds their
   * capacity, as a share of that capacity (docs/PRD.md §6.3.4, decision D7).
   * Default 0: none, and the model runs exactly as before this field existed.
   */
  overtimeCap?: number;
  /**
   * The client roster by id. When present, ongoing load is per client: each
   * client's services' `fallbackOngoing` hours (or the roles' `ongoing`) go to
   * the people assigned to it, clients churn one by one at their services'
   * base churn, and each retainer won adds a synthetic client assigned per
   * role by round-robin. `activeClients` and the pooled load are then unused.
   * Omitted: the pooled `activeClients` × `ongoing` load, as before.
   */
  clients?: Record<string, EngineClient>;
  /**
   * Client groups by service id (decision D27): the clients counted per
   * service. When present, the engine builds the roster from them (unnamed
   * clients, nobody assigned, so their work is shared across each role's
   * people) and they replace `clients`. A group also sets its service's base
   * churn and expected tenure. Omitted or empty: `clients` (named) or the
   * pooled `activeClients`, as before.
   */
  clientGroups?: Record<string, EngineClientGroup>;
  /**
   * Churn drivers (decision D28, issue #121): the reasons clients leave, each with a
   * weight and an on/off switch, plus any of your own (churn-drivers.ts). Omitted:
   * the defaults, which are exactly how the engine churned clients before drivers
   * existed (health and the market's "clients leaving" factor, both at weight 1).
   */
  churnDrivers?: EngineChurnDriver[];
  /**
   * Servicing processes by id (see `EngineService.servicing`). Omitted or
   * empty: no servicing, and the model runs exactly as before it existed.
   */
  servicingProcesses?: Record<string, EngineServicingProcess>;
  /** How servicing moves client health. Omitted: `DEFAULT_HEALTH_RULES`. */
  health?: EngineHealthRules;
  /**
   * Warm-up run before measuring, in weeks, discarded from every reported
   * metric. Omitted means automatic: 4 weeks, or 2x the P90 cycle time of a
   * pilot run if longer (capped at 52 weeks). 0 starts from an empty business.
   * Ignored when any step has `currentWip`: the run starts from that instead.
   */
  warmupWeeks?: number;
  /**
   * How long an item should take end to end, in working hours (rule 13, "too
   * slow overall"). Omitted: the rule doesn't rate this process. It rates the
   * report; it doesn't change the simulation.
   */
  targetCycleHours?: number;
  /**
   * Groups by id (see `EngineGroup`), for steps inside groups or child
   * processes. Omitted: a flat model, simulated exactly as before groups existed.
   */
  groups?: Record<string, EngineGroup>;
  entry: string;
  /** The terminal `won` and `lost` end steps' ids. */
  sinks: { won: string; lost: string };
  /** Further end steps by id: more `won`/`lost` ends, `done` ends, and hand-offs. */
  ends?: Record<string, EngineEnd>;
  steps: EngineStep[];
}

/**
 * How a run started (docs/PRD.md §6.3.1): from entered work in progress, after
 * a discarded warm-up, or from an empty business (warm-up switched off).
 */
export type InitialState =
  | { kind: "wip"; items: number }
  | { kind: "warmup"; hours: number }
  | { kind: "empty" };

/** One visit of an entity to a step: queued, started, ended service, left. */
export interface TraceSegment {
  step: string;
  /** Who served it; null for steps with no resource. */
  person: string | null;
  tQ: number;
  tS: number | null;
  tE: number | null;
  tL: number | null;
}

export interface TraceEntity {
  id: number;
  t0: number;
  trace: TraceSegment[];
  /** When it reached a terminal end step. */
  done?: number;
  /** A win sticks: once won, later ends downstream don't change it. */
  outcome?: Outcome;
  /** Its service id, when the model has services. */
  service?: string;
  /** A servicing task: its servicing process, and the client it is for (a roster id, or `won:<n>`). */
  servicing?: { process: string; client: string };
}

export interface StepResult {
  arrivals: number;
  avgQueue: number;
  maxQueue: number;
  avgWait: number;
  reworks: number;
  /** Items still queued at the horizon. */
  wip: number;
  /**
   * How fast the queue grows, in items per week: the average queue over the
   * second half of the measured window minus that over the first half,
   * divided by the half's length in weeks. Near 0 for a stable queue.
   */
  queueGrowth: number;
  /** Visits that left the step in the measured window. */
  departures: number;
  /** Of those, visits that took longer than the step's `sla` (0 when it has none). */
  slaBreaches: number;
  /**
   * Visits that went straight from this step to a lost end (work lost here,
   * docs/analysis-rules.md rule 12). Divided by `departures`. Absent from runs
   * saved before the rule.
   */
  lostHere?: number;
  /**
   * The 90th percentile across replications of the step's average wait, of its
   * share of visits repeated (`reworks / departures`) and of its share of
   * visits over the SLA: a bad month, for the rating model's escalator
   * (ratings.ts). Absent from runs saved before the rating model.
   */
  p90?: { avgWait: number; reworkShare: number; slaBreachShare: number; lostShare?: number };
  /**
   * Mean hands-on hours of a visit that was worked by a person, and mean
   * external (fixed) wait after service. With `avgWait` (queue wait) they split
   * a step's elapsed time into working and waiting. Absent from runs saved
   * before the process page redesign (#174).
   */
  avgHandsOn?: number;
  avgFixedWait?: number;
  /** Mean extra elapsed time of a worked visit from part-time availability (elapsed minus hands-on). */
  avgStretch?: number;
  /** The visits behind `avgHandsOn` / `avgStretch` and behind `avgFixedWait`, so means across runs can be weighted. */
  handsOnVisits?: number;
  fixedWaitVisits?: number;
}

/**
 * Utilisation over the measured window. Ongoing hours follow the live client
 * count (clients won and churned during the run), exactly as the engine
 * applied them to availability. Shares are of contracted capacity; `util` is
 * of capacity plus the overtime worked, so it goes above 1 only when the work
 * exceeds even that (docs/PRD.md §6.3.4, §13).
 */
export interface RoleResult {
  /** Share of capacity spent on pipeline work. */
  pipeline: number;
  /** Share of capacity spent on ongoing (fallback) client work. */
  ongoing: number;
  /** Share of capacity spent on servicing tasks, hands-on. */
  servicing: number;
  /** Total utilisation: (pipeline + servicing + ongoing hours) / (capacity + overtime hours). */
  util: number;
  pipelineHours: number;
  ongoingHours: number;
  /** Servicing hands-on hours a week. */
  servicingHours: number;
  /** Overtime as a share of capacity. */
  overtime: number;
  /** Overtime hours a week. */
  overtimeHours: number;
}

export interface PersonResult {
  /** Total utilisation: (pipeline + servicing + ongoing hours) / (capacity + overtime hours). */
  util: number;
  pipeline: number;
  ongoing: number;
  servicing: number;
  pipelineHours: number;
  ongoingHours: number;
  servicingHours: number;
  /** Overtime as a share of capacity. */
  overtime: number;
  /** Overtime hours a week. */
  overtimeHours: number;
  /** Services completed. */
  completed: number;
  /** With a client roster: clients assigned to them in any role, averaged over the window. */
  clients?: number;
}

/** Servicing touchpoints (docs/PRD.md §6.3.5): tasks completed on time, late, or not within 2 × their SLA. */
export interface Touchpoints {
  onTime: number;
  late: number;
  missed: number;
}

/** One roster client in one replication. */
export interface ClientReplication {
  /** Health at t = 0 and after each week of the horizon (frozen once it churns). */
  health: number[];
  /** Touchpoints decided in the measured window. */
  touchpoints: Touchpoints;
  /** Whether it churned in the measured window. */
  churned: boolean;
  /** Monthly churn probability at the horizon: base × (1 + the drivers' pressure) × the market's factor, at most 1. */
  churnMonthly: number;
}

/** Per-service counts in one replication. */
export interface ServiceCounts {
  arrivals: number;
  won: number;
  lost: number;
}

/** Weekly samples of one replication, taken at each weekly tick when asked for (the absence test). */
export interface WeeklySamples {
  /** Queue length at each step at the end of week 1, 2, ... */
  queue: Record<string, number[]>;
  /** Cumulative completed items (won, done, and servicing tasks on time or late) at the end of each week. */
  completed: number[];
  /** Cumulative wins (entities reaching their first `won` end) at the end of each week. */
  won: number[];
}

export interface ReplicationResult {
  /** Entities reaching their first `won` end. */
  won: number;
  /** Entities reaching a `lost` end without having been won. */
  lost: number;
  /** Entities reaching a `done` end without having been won. */
  done: number;
  /** Revenue KPIs (docs/PRD.md §13); see `Kpis`. */
  newMrr: number;
  billed: number;
  ltvAdded: number;
  lostRevenue: number;
  /** By service id; empty when the model has no services. */
  services: Record<string, ServiceCounts>;
  /** Overtime hours over the measured window, everyone together. */
  overtimeHours: number;
  /** Their cost: each person's overtime hours × their cost rate. */
  overtimeCost: number;
  /** With a client roster: clients that churned in the measured window. */
  clientsChurned?: number;
  /** With a client roster: active clients (roster and won) with health below 50 at the horizon. */
  clientsAtRisk?: number;
  /** With a client roster: every client's servicing touchpoints in the measured window. */
  touchpoints?: Touchpoints;
  /** With a client roster: each roster client, by id. */
  clients?: Record<string, ClientReplication>;
  /** With a client roster: who the churn is blamed on (churn-drivers.ts). */
  churn?: ChurnReplication;
  /** Cycle times of won and done entities. */
  cycle: number[];
  steps: Record<string, StepResult>;
  roles: Record<string, RoleResult>;
  people: Record<string, PersonResult>;
  /** What each rework loop did in the measured window, by loop id (empty when the model has none). */
  loops?: Record<string, LoopReplication>;
  /** All repeat passes of the run together (each counted once, so overlapping loops don't double count). */
  rework?: { roleHours: Record<string, number>; extraElapsed: number; items: number };
  /**
   * Entities in the measured window (replication 0 only). Those that entered
   * during the warm-up or as starting WIP have negative times.
   */
  entities: TraceEntity[] | null;
  /** Present only when the run was asked to sample weekly (see `WeeklySamples`). */
  weekly?: WeeklySamples;
  H: number;
  /** Warm-up simulated before t = 0 and discarded. */
  warmupHours: number;
  /** Active clients at the horizon (with a roster: whole clients). */
  activeEnd: number;
}

/**
 * One rework loop in one replication (loops.ts), counted as events in the
 * measured window so long loops aren't under-counted. "Went round" is first
 * send-backs of a stay in the loop (an item that joined at any step); "entered"
 * is those plus stays that ended with none; "rounds" is every send-back.
 * Hands-on hours and `extraElapsed` are over the window, each repeat pass in the
 * innermost loop it is on. Working hours.
 */
export interface LoopReplication {
  entered: number;
  /** Items that went round at least once. */
  went: number;
  /** Send-backs in the window, and of those the ones by an item already on a repeat pass (`again`) and the items on a repeat pass that left (`left`). */
  rounds: number;
  again: number;
  left: number;
  /** Hands-on hours on repeat passes by role id (a person-pinned step with no role counts to the person's first role). */
  roleHours: Record<string, number>;
  /** Elapsed hours (queue, hands-on and waiting) spent on repeat passes, as each repeat pass ends (innermost loop only). */
  extraElapsed: number;
}

/** All rework together, across replications: what the loops add up to, with overlaps counted once (for the Overview's rework slice). */
export interface ReworkTotal {
  extraHandsOnHoursPerMonth: Record<string, Stat>;
  extraHandsOnHoursPerMonthTotal: Stat;
  /** Working hours repeat passes add per finished item (won, lost or done). */
  extraCycleHoursPerItem: Stat;
}

/** A rework loop across replications (docs/PRD.md §6; issue #174). Means with a 10-90% band. */
export interface LoopResult extends Omit<Loop, "body"> {
  /** Items that went round at least once, as a share of items that entered the loop. */
  share: Stat;
  /** Times round per item that goes round at least once (0 when none does). */
  meanRounds: Stat;
  /** Extra hands-on hours a month on repeat passes, by role id and in total. */
  extraHandsOnHoursPerMonth: Record<string, Stat>;
  extraHandsOnHoursPerMonthTotal: Stat;
  /** Working hours a repeat pass adds to the cycle time of an item that enters the loop, on average (all items; 0 with none). */
  extraCycleHours: Stat;
  /** The same, per item that goes round. */
  extraCycleHoursPerLooper: Stat;
}

/** What one step looks like for the process page and the analysis (issue #174). Hours per visit. */
export interface StepFacts {
  /** Mean hands-on time of a visit worked by a person. */
  handsOnHours: number;
  /** Mean extra elapsed time from part-time availability while it is worked (hands-on stretched over the person's pipeline share). */
  stretchHours: number;
  /** Mean time queueing for a person. */
  queueWaitHours: number;
  /** Mean fixed (external) wait after the work. */
  fixedWaitHours: number;
  /** `handsOnHours` as a share of hands-on plus stretch plus queue plus fixed wait (0 when all are 0). */
  handsOnShare: number;
  /**
   * Only one person can do it: the step is staffed and exactly one person with
   * capacity can work it (a role of head-count 1, or a pinned person with no
   * alternative). Null when more than one can, or the step is a pure wait.
   */
  keyPerson: { personId: string; personName: string } | null;
  /** The step is staffed but nobody can do it (a role with no head-count, a pinned person with no capacity, everyone able is away all run). */
  nobodyCanDo: boolean;
}

/** A metric across replications: the mean and the 10th–90th percentile band. */
export interface Stat {
  mean: number;
  p10: number;
  p90: number;
}

/** Headline metrics with their spread across replications (docs/PRD.md §6.4). */
export interface Kpis {
  won: Stat;
  lost: Stat;
  done: Stat;
  labour: Stat;
  /** Over replications that won at least one item. */
  costPerWin: Stat;
  /** New MRR: Σ over entities reaching their first `won` end of their service's price (retainers only). */
  mrrAdded: Stat;
  /**
   * Revenue billed in the horizon (docs/PRD.md §13): Σ over clients of weeks
   * active in the horizon × weekly price (monthly / 4.33); a one-off bills its
   * price when won. With a client roster: every client, the roster's at its
   * MRR and those won at their service's price, each until it churns.
   * Without one: the clients won in the horizon, net of the expected weekly
   * churn decay.
   */
  billed: Stat;
  /** LTV added: Σ over new wins of price × expected tenure (retainers) or price (one-off). */
  ltvAdded: Stat;
  /** Lost revenue: Σ over lost entities of their service's expected value (as for LTV). */
  lostRevenue: Stat;
  wipEnd: Stat;
  /** Overtime hours over the horizon, everyone together (0 unless `overtimeCap` is above 0). */
  overtimeHours: Stat;
  /** Overtime cost over the horizon: overtime hours × cost rate. */
  overtimeCost: Stat;
  /** Over every completed item in every replication. */
  cycle: { mean: number; p50: number; p90: number };
  roles: Record<string, { util: Stat; pipeline: Stat; ongoing: Stat; servicing: Stat; overtime: Stat }>;
  people: Record<string, { util: Stat; pipeline: Stat; ongoing: Stat; servicing: Stat; overtime: Stat }>;
  /** By service id; empty when the model has no services. */
  services: Record<string, { arrivals: Stat; won: Stat; lost: Stat }>;
  /** With a client roster: clients that churned in the horizon. */
  clientsChurned?: Stat;
  /** With a client roster: clients at risk, health below 50, at the horizon (docs/PRD.md §13). */
  clientsAtRisk?: Stat;
  /** With a client roster: servicing touchpoints in the horizon. */
  touchpoints?: { onTime: Stat; late: Stat; missed: Stat };
}

/** A roster client across replications (docs/PRD.md §6.4 "Per client"). */
export interface ClientResult {
  name: string;
  /** Health at the horizon (frozen when it churns). */
  health: Stat;
  /** Mean health at t = 0 and after each week. */
  trajectory: number[];
  /** Mean touchpoints per replication. */
  touchpoints: Touchpoints;
  /** Monthly churn probability at the horizon (see `ClientReplication.churnMonthly`). */
  churnMonthly: Stat;
  /** Share of replications in which it churned. */
  churned: number;
  /** Share of replications in which its health ended below 50. */
  atRisk: number;
}

/**
 * Headline metrics per replication, in replication order. Replication i of
 * every run with the same seed uses the same random streams, so two runs'
 * samples pair up for a delta's range (common random numbers; see compare.ts).
 */
export interface ReplicationSamples {
  won: number[];
  lost: number[];
  mrrAdded: number[];
  billed: number[];
  labour: number[];
  wipEnd: number[];
  /** Mean cycle time of the replication's completed items (0 when none completed). */
  cycleMean: number[];
}

export interface SimulationResult {
  /** The engine version that produced it (`ENGINE_VERSION`); saved runs record it. */
  engineVersion: string;
  /** Means and ranges; the flat fields below are the prototype's shape, kept for compatibility. */
  kpi: Kpis;
  /** Per-replication values behind `kpi`, for paired comparisons. */
  samples: ReplicationSamples;
  /** The seed the run started from. */
  seed: number;
  won: number;
  wonLow: number;
  wonHigh: number;
  lost: number;
  cycleP50: number;
  cycleP90: number;
  steps: Record<string, StepResult>;
  roles: Record<string, RoleResult>;
  people: Record<string, PersonResult>;
  /** The resolved people the run used (named, or synthesised from role counts). */
  resolvedPeople: Record<string, EnginePerson>;
  labour: number;
  costPerWin: number;
  /** Mean new MRR (`kpi.mrrAdded.mean`). */
  mrrAdded: number;
  bnRole: string | null;
  bnStep: string | null;
  /** Person with the highest utilisation. */
  bnPerson: string | null;
  /** Replication 0's entities, for animation. */
  trace: TraceEntity[] | null;
  /** Rework loops, in `detectLoops` order, with what each costs (empty when none). Absent from runs saved before #174. */
  loops?: LoopResult[];
  /** All rework loops together, overlaps counted once; the loops' hours add up to this. */
  rework?: ReworkTotal;
  /** Hands-on versus waiting, and key-person risk, per step. Absent from runs saved before #174. */
  stepFacts?: Record<string, StepFacts>;
  H: number;
  reps: number;
  wipEnd: number;
  /** Whether the run started from entered WIP, a warm-up, or empty. */
  initialState: InitialState;
  /** With a client roster: each roster client, by id. */
  clients?: Record<string, ClientResult>;
  /** With a client roster: how much of the churn each driver causes (docs/analysis-rules.md rule 10). */
  churnCauses?: ChurnCauses;
}

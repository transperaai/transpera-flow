// Engine input and output shapes. This is the prototype's model, extended so
// far with named people, services, end-step outcomes, seasonal demand, a client
// roster, overtime, and client servicing with health and churn (docs/PRD.md §6).

import type { ChurnCauses, ChurnReplication, DriverEvents, EngineChurnDriver } from "./churn-drivers";
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
  /**
   * What a shared team's work is counted in, for display (D27): "words", "links", "ticket hours", "tasks", "set-ups and incidents".
   * `perHour` is how many of the unit one person does in an hour; blank until the client keys it (D35). Reporting only: the
   * engine's own unit is working hours, and the label is turned into hours outside it (capacity-inputs.ts). Omitted: none.
   */
  unit?: { label: string; perHour?: number };
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
  /**
   * A planned hire's first hour, in simulation hours from t = 0 (the forecast, issue #35). Before it they take no
   * work and carry no share of the clients' work: their role's pool is the others. Omitted: there from the start.
   */
  from?: number;
  /** The hour a person leaves for good (their end date). From it on they are gone, as before `from`. Omitted: there to the end. */
  until?: number;
  /**
   * Per-person time (capacity factor; PRD §6.3.7, D20; C6, #198): the hands-on time they take on a step is the drawn time ×
   * the factor. 1 is the role's normal time, 0.8 is 20% faster. `steps` wins over `default`; a step in neither is 1.
   * Omitted: 1 everywhere. Only for steps they can do (a factor on any other step is never used).
   */
  capacityFactor?: { default?: number; steps?: Record<string, number> };
  /**
   * Team time (0-1): the share of their hours kept for leading, mentoring and reviews. Their hours for client work are
   * the hours they have × (1 − share) (`availableShare`, capacity-inputs.ts). Omitted: 0, all their hours, as before this
   * field existed. Read by the simulation from engine 1.15.0 (availability.ts): it lowers their hours for work, not their pay.
   */
  reservedShare?: number;
  /**
   * New-starter ramp: the share of full capacity in each month from `from` (the first entry is the month `from` falls in),
   * e.g. `[0.4, 0.6, 0.8]`, then 1 (`rampShare`). Omitted: full from the start, as before this field existed. Read by
   * the simulation from engine 1.15.0, with team time (availability.ts).
   */
  ramp?: number[];
  /**
   * Tier keys (`EngineService.tier`) they can serve, used to place won clients. Omitted: every tier, as before this field
   * existed. Read by the simulation from engine 1.15.0, for `placeNewClients: "least-busy"`.
   */
  tiers?: string[];
  /**
   * Counted clients assigned to them, by service id: that many of the service's counted clients (`clientGroups`), in each of
   * the person's roles that the service's servicing steps use. The group's remainder (count minus the sum over people) stays
   * unassigned and shared, as today; a sum above the count is an input error (`checkCapacityInputs`). Omitted: none
   * assigned, as before this field existed. Read by the simulation from engine 1.15.0 (`withClientGroups` deals them out in people order).
   */
  portfolio?: Record<string, number>;
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
 * How a service is priced. Only retainers add MRR. An hourly service bills
 * its rate for the hands-on hours worked for clients won during the run
 * (engine 1.11.0, docs/engine-versioning.md "Profit"); a client already
 * there at the start bills the fee entered for it, whatever its service's
 * pricing.
 */
export type PricingModel = "retainer" | "one_off" | "hourly";

/** Something the business sells (docs/PRD.md §5 `services`). */
export interface EngineService {
  name: string;
  pricingModel: PricingModel;
  /** Monthly fee for a retainer; the whole fee for a one-off; the rate for hourly. */
  price: number;
  /**
   * Fee range of a client won on this service (sandbox phase 3, A5): its fee is drawn from a triangular low – price – high, from
   * its own random stream. Omitted, or low = high = price: the price, and no draw. The engine uses min(low, price) and max(high, price).
   * Existing clients (a named client's `mrr`, a client group's `fee`) keep their entered fee.
   */
  priceRange?: { low: number; high: number };
  /** Gross margin as a share of price (0–1); recorded for reference, not used: profit comes from the hours people are paid for (see `labourCost`). */
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
  /**
   * The department this tier belongs to (Organic, Performance): a service is one tier of one department, so "Organic Tier 1"
   * and "Performance Tier 2" are two services. Reporting and assignment only. Omitted: none, as before this field existed.
   */
  department?: string;
  /**
   * The tier key shared by both departments (`"T1"`). Step tier multipliers, change filters and `EnginePerson.tiers` key on
   * it. Each department's tier has its own values. Omitted: none, so tier multipliers and filters don't apply to this
   * service's clients, as before this field existed.
   */
  tier?: string;
  /**
   * What one client on this tier gets each month (`TierDeliverables`). A servicing link whose recurrence has a `driver`
   * reads it (a named client's `overrides` replace single values). Omitted: all 0, so a driver recurrence makes no tasks.
   */
  deliverables?: TierDeliverables;
  /**
   * Ad-hoc requests (D26): the share of this tier's clients who ask in a month (0-1), and the requests from a client who
   * asks. The expected requests a client makes a month are `chance × requests`. Omitted: none, as before this field existed.
   */
  adhoc?: ServiceAdhoc;
}

/** The ad-hoc rule of a tier: who asks, and how many requests they make (D26). */
export interface ServiceAdhoc {
  /** Share of clients who ask in a month, 0-1. */
  chance: number;
  /** Requests from a client who asks. */
  requests: number;
}

/**
 * What one client of a tier gets in a month, each a number a month (decision D5; requirements section 4). Every key is
 * optional: unset means 0. These are labels and rates for the plan, not hours: a servicing step's own time turns them into
 * hours, and the engine's unit stays working hours.
 */
export interface TierDeliverables {
  /** Words of content. A recurrence reads it per `per: 1000`. */
  words?: number;
  /** Links built. */
  links?: number;
  /** Technical SEO ticket hours. */
  techHours?: number;
  /** Client meetings. */
  meetings?: number;
  /** Campaign builds and changes. */
  builds?: number;
  /** Creative sets. */
  creativeSets?: number;
  /** Ad channels run (Performance); "per channel" steps read it. */
  channels?: number;
}

/** A key of `TierDeliverables`. */
export type DeliverableKey = keyof TierDeliverables;

/** Where a base value came from; reporting only (requirements section 7). */
export type SourceLabel = "interview" | "calculator" | "measured" | "estimate";

/**
 * How often a client generates a servicing task (docs/PRD.md §5
 * `service_servicing.recurrence`): `times` tasks evenly spaced in every week
 * or month (a fortnightly check-in is `{every: "week", times: 0.5}`), or
 * ad-hoc requests at random, `poissonPerMonth` a month on average.
 */
export type Recurrence =
  | { every: "week" | "month"; times: number }
  | { poissonPerMonth: number }
  | {
      /**
       * Tasks a month driven by what the client's tier gets: `perMonth × value ÷ (per ?? 1)`, where `value` is the client's
       * effective deliverable (its override, else its tier's; `effectiveDeliverables`). `driver: "adhoc"` reads `chance × requests`
       * (arrivals are Bernoulli(chance) a month, then that many requests). Words use `per: 1000`. Spaced evenly in the month
       * like `{ every: "month", times }`. A driver of 0 means no tasks. Read by the simulation from engine 1.15.0. Ad-hoc tasks are placed
       * uniformly in the month.
       */
      perMonth: number;
      driver: DeliverableKey | "adhoc";
      per?: number;
    };

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
  /**
   * This client's own values, each replacing its tier's (`effectiveDeliverables`). Omitted: the tier's values, as before this
   * field existed.
   */
  overrides?: ClientOverrides;
  /**
   * Unplanned hours a month for this client, per role id, done by the client's assignee in that role. Load like
   * `fallbackOngoing`, on top of the servicing tasks. Omitted: none, as before this field existed.
   */
  handHoldingHours?: Record<string, number>;
  /**
   * Person id of the client's manager: the person a step with `toClientManager` goes to. Counted clients get theirs from
   * `EnginePerson.portfolio`. Omitted: the manager is whoever `assignments` names for the step's role, or the role's pool.
   */
  manager?: string;
}

/** A named client's own values (requirements section 4). Each replaces the tier's; unset keeps it. */
export interface ClientOverrides extends TierDeliverables {
  /** Replaces `ServiceAdhoc.chance` for this client. */
  adhocChance?: number;
  /** Replaces `ServiceAdhoc.requests` for this client. */
  adhocRequests?: number;
  /** Hands-on hours per ad-hoc request, replacing the ad-hoc process's step time. */
  adhocHours?: number;
  /** × on every step's time for this client, or × per step id (a step not listed is 1). */
  stepFactor?: number | Record<string, number>;
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
  /** What the step achieves (sandbox G): an opaque key the app maps to a category. Omitted: "". Reporting only: never changes the run. */
  purpose?: string;
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
  /**
   * The step goes to the client's manager (D32): the person who holds the client in their portfolio or assignments, whatever
   * their role (a director or a manager). Falls back to `role`'s pool if the client has none. A step for a shared team keeps
   * `role` and leaves this off; a pinned step keeps `person`. Needs a `role`. Omitted: false, as before this field existed.
   * Read by the simulation from engine 1.15.0.
   */
  toClientManager?: boolean;
  /**
   * Shares of the step's hands-on time (D6) that can be automated, augmented or only done by hand; they sum to 1. Changes
   * act on the first two (`stepParts`). Omitted: the whole time is manual and no change touches it, as before this field
   * existed. Read by the simulation from engine 1.16.0.
   */
  split?: { automatable: number; augmentable: number; manual: number };
  /**
   * × on the step's time for a client of that tier key (D7), e.g. `{ T1: 1.5, T3: 0.7 }`. A tier not listed is 1. Omitted: 1
   * for every tier, as before this field existed. Read by the simulation from engine 1.16.0.
   */
  tierMultiplier?: Record<string, number>;
  /** Where each base value came from (requirements section 7). Reporting only: never changes the run. */
  sources?: Partial<Record<"work" | "split" | "tierMultiplier", SourceLabel>>;
  next: EngineEdge[];
}

/** One effect of a change: what it does to one part of one step. */
export type StepChangeEffect =
  /** Takes `remove` (0-1) of the automatable part away, leaving `residualHours` of checking per visit. */
  | { step: string; part: "automatable"; remove: number; residualHours?: number }
  /** Speeds the augmentable part up by `factor` (at least 1). */
  | { step: string; part: "augmentable"; factor: number };

/**
 * An automation or augmentation that acts on parts of steps (D8; requirements section 7): never a new time. The future time
 * is worked out from the step's base time and split (`stepParts`). Read by the simulation from engine 1.16.0.
 */
export interface EngineStepChange {
  id: string;
  name: string;
  kind: "automation" | "augmentation";
  effects: StepChangeEffect[];
  /** Share of people or time actually using it, 0-1 (D8). */
  adoption: number;
  /** The 1-based month of the run it starts in. */
  startMonth: number;
  /** Months to full effect; 0 = at once. */
  rampMonths: number;
  /** Only clients of these tier keys; omitted = all. */
  tiers?: string[];
  /** The issue it fixes (P8). Reporting only. */
  issueId?: string;
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

/**
 * Monthly channels (sandbox phase 3, channels.ts): per-month values the engine reads while it runs, so a change from a month
 * is one run and the months before it are exactly the run without it. Month 0 starts at t = 0 and also covers the warm-up;
 * an array shorter than `starts.length + 1` holds its last value. Multipliers are 0 or more.
 */
export interface EngineChannels {
  /** Hours inside the run where months 1, 2, … start (the run's `monthStarts`); ascending, in (0, H). */
  starts: number[];
  /** × arrival rate, on top of seasonality, growth and the market's leads. */
  leads?: number[];
  /** × the market's conv (the share of enquiries that sign). */
  conv?: number[];
  /** Service id → its mix weight that month (absolute; replaces `mixShare`). */
  mix?: Record<string, number[]>;
  /** Service id or "*" → × the price a client won that month pays (retainer fee, one-off price, hourly rate). */
  newFee?: Record<string, number[]>;
  /** Service id or "*" → × what every active client pays that month (existing and won). A rise carries churn through the price driver. */
  fee?: Record<string, number[]>;
  /** Service id → the fee range in force that month; null is the service's own. */
  priceRange?: Record<string, ({ low: number; high: number } | null)[]>;
  /** Service id or "*" → × base churn (a pooled model: "*" only). */
  churn?: Record<string, number[]>;
  /** Driver id → its chance-and-effect settings that month; null is as the model's `churnDrivers` say. */
  drivers?: Record<string, (DriverEvents | null)[]>;
  /** Step id → × hands-on time. */
  work?: Record<string, number[]>;
  /** Step id → mean external wait that month, in hours (absolute). */
  wait?: Record<string, number[]>;
  /** Step id → probability the step is repeated that month (absolute, at most 0.95). */
  rework?: Record<string, number[]>;
  /** Role id → × the role's cost an hour. */
  roleCost?: Record<string, number[]>;
  /** × `overheadMonthly`. */
  overheads?: number[];
  /** Person id or "*" → × contracted capacity. */
  capacity?: Record<string, number[]>;
}

export interface EngineModel {
  /**
   * True when the caller may not see people's pay (members and viewers; B1 slice 2a): no person has a `cost`, and the
   * figures that depend on individual pay are not computed (`kpi.overtimeCost` is null; issue costs that need a person's
   * rate are marked `payHidden`). Omitted or false: simulated exactly as before this field existed.
   */
  payHidden?: boolean;
  /** Fixed costs a month (rent, tools), per 52/12-week month. Omitted or 0: none. Not pay, so kept when `payHidden`. */
  overheadMonthly?: number;
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
   * Per-month values the engine reads while it runs (sandbox phase 3, channels.ts). Omitted, or every array neutral: the run
   * is exactly as before this field existed.
   */
  channels?: EngineChannels;
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
  /**
   * How counted clients (`clientGroups`) and named clients (`clients`) combine. "groups-replace" (the default) is today's rule:
   * groups replace the named roster. "groups-add": the groups are unnamed clients in addition to the named ones. Omitted:
   * "groups-replace", as before this field existed. Read by the simulation from engine 1.15.0 (`withClientGroups`).
   */
  clientMix?: "groups-replace" | "groups-add";
  /**
   * How won clients are assigned. "round-robin" (the default) is today's rule. "least-busy": the least-busy person who serves
   * the tier (`EnginePerson.tiers`), in each needed role. Omitted: "round-robin", as before this field existed. Read by
   * the simulation from engine 1.15.0.
   */
  placeNewClients?: "round-robin" | "least-busy";
  /**
   * Automations and augmentations acting on steps' parts (`EngineStepChange`). Omitted or empty: no step's time is changed,
   * as before this field existed. Read by the simulation from engine 1.16.0.
   */
  changes?: EngineStepChange[];
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

/**
 * One replication month by month (the forecast, issue #35), when the run is asked for it. Months are the engine's
 * 52/12-week months from t = 0; the last ends at the horizon, so it may be part of one. Every array has one entry per
 * month. Hours are totals over the month, not a week. Reading these never changes the run.
 */
export interface MonthlyReplication {
  /** The months' edges in working hours: 0, each month's start, the horizon. */
  bounds: number[];
  /**
   * Work per role id: pipeline and servicing hands-on time (spread over the time it is worked) and ongoing client
   * hours, all of it, including the client hours of someone on leave.
   */
  roleWork: Record<string, number[]>;
  /** Hours each role has: its people's capacity (split across their roles) less leave, and before a start or after an end date. */
  roleCapacity: Record<string, number[]>;
  /** Overtime hours, split across the roles of the people who worked it. */
  roleOvertime: Record<string, number[]>;
  /**
   * Work nobody in the role was there to do: client hours no one of the role carried (nobody on the team), and in
   * months the role has no hours at all, the hands-on time of the items that reached its steps (at each step's mean).
   */
  roleUncovered: Record<string, number[]>;
  /**
   * Client hours of someone on leave that nobody else of the role was there that month to take (the role's `roleWork` counts
   * them, no person's `personWork` does). Reporting only: `MonthlyResult.time` shows them as uncovered, not as the role's work.
   */
  roleAwayUnshared: Record<string, number[]>;
  /**
   * Work per person id. Client hours that fall in someone's leave go to the others of the same role who are there
   * that month (not to them), by the hours each has, so a person's month is the work they actually face.
   */
  personWork: Record<string, number[]>;
  personCapacity: Record<string, number[]>;
  personOvertime: Record<string, number[]>;
  /** First-pass hands-on hours by purpose key, then role id / person id (the hours `roleWork` / `personWork` count for steps). Repeat passes are in `rework…`, never here. */
  purposeRoleWork: Record<string, Record<string, number[]>>;
  purposePersonWork: Record<string, Record<string, number[]>>;
  /** Hands-on hours on repeat passes (the redo loops' second and later passes), whatever the step's purpose. */
  reworkRoleWork: Record<string, number[]>;
  reworkPersonWork: Record<string, number[]>;
  /** Hours waited for a person, and the waits, per step id (by when the work was picked up). */
  waitSum: Record<string, number[]>;
  waitN: Record<string, number[]>;
  /** Servicing tasks done late or not done within twice their deadline, by when that was decided. */
  lateTasks: number[];
  /** Active clients per service id (the first service a client takes; "" for none, and for the pooled count), averaged over the month's weekly ticks. */
  clients: Record<string, number[]>;
  /**
   * Monthly recurring revenue of the active clients at each weekly tick, averaged over the month's ticks: with a client
   * roster (named clients or client groups), each retainer client's monthly fee as it bills (`weeklyBill × 4.33`); without
   * one, what the interim clients pay (their count × `pooledMonthlyFee`) plus each retainer won since at its price at the market's, less churn. One-off and hourly services add nothing
   * here (hourly work bills in `revenueHourly`).
   */
  mrr: number[];
  /** Qualified arrivals, wins and losses (at an end reached from t = 0), by month. */
  opportunities: number[];
  won: number[];
  lost: number[];
  /** Wins that become clients (not one-offs), and clients that leave (pooled: the fractional fall in the count at the tick). */
  clientsWon: number[];
  clientsLost: number[];
  /** Revenue billed in the month (totals): recurring fees, one-off prices and hourly work, and of those what came from clients won in the run. */
  revenueRecurring: number[];
  revenueOneOff: number[];
  revenueHourly: number[];
  revenueFromNew: number[];
  /** Of the revenue above, the part a fee channel added to what clients pay (the `fee` channel's (factor - 1) share): "gained from clients who stay". */
  revenueRise: number[];
  /** Monthly fees of the clients that left in the month (`weeklyBill` × 4.33; pooled: the fall in the pool's fees). */
  mrrLost: number[];
  /** Paid hours × rate in the month, overtime excluded (see `ReplicationResult.labourCost`); null when `model.payHidden`. */
  labour: number[] | null;
  labourByRole: Record<string, number[]> | null;
  labourByPerson: Record<string, number[]> | null;
  /** Overtime hours × rate in the month; null when `model.payHidden`. */
  overtimeCost: number[] | null;
  /** `overheadMonthly` × the month's weeks ÷ (52/12). */
  overheads: number[];
  /**
   * With a client roster only: active clients whose health is below 50 (`AT_RISK_HEALTH`), per service key (the same keys
   * as `clients`, each present even when 0), averaged over the month's ticks. Empty without a roster.
   */
  atRisk: Record<string, number[]>;
}

/**
 * Where working time goes in a month (sandbox G), hours in the month (not a week), each a `Stat` over replications.
 * purpose + rework + ongoing + idle = max(hours, work) in every replication.
 */
export interface TimeSplit {
  /** First-pass hands-on hours per purpose key. */
  purpose: Record<string, Stat[]>;
  /** Repeat-pass hands-on hours. */
  rework: Stat[];
  /**
   * Per purpose key, its first-pass hours plus all the repeat-pass hours, as one series per replication: the range of the sum (a
   * category that also takes the rework, as the app's Fixing does), which adding the two ranges would not give.
   */
  withRework: Record<string, Stat[]>;
  /** Client hours not drawn as steps: max(0, work - sum of purpose - rework). For a role, work leaves out `roleAwayUnshared`. */
  ongoing: Stat[];
  /** max(0, hours - work). */
  idle: Stat[];
  /** Hours available plus overtime worked: the 100%. */
  hours: Stat[];
  /**
   * Work nobody was there to do (roles and the team; null for people): `roleUncovered`, plus the client hours of someone on leave that
   * no colleague of the role was there to take (`roleAwayUnshared`), which are not the role's work in this split.
   */
  uncovered: Stat[] | null;
}

/**
 * Where each person's time goes, by step (the Capacity page links each item to its step, D32). Asked for with
 * `simulate(…, { personTime: true })`; not asked for, nothing is allocated and no other output changes. Only the non-zero
 * entries are listed.
 */
export interface PersonTime {
  /** Mean hands-on hours a month per person id per step id, over the measured window (pipeline and servicing work both). */
  stepHours: Record<string, Record<string, number>>;
  /**
   * Mean clients per person id per service id over the window: the clients who have them assigned in any role, or as their
   * manager, counted under each service the client takes.
   */
  clients: Record<string, Record<string, number>>;
  /**
   * Hands-on hours by part of the step (engine 1.16.0, P3): what the steps with a work split took, per person and step, a month on
   * average. `actual` is after the changes; `before` is the same draws without any change (the tier multiplier stays), so the
   * hours freed are `before − actual`. A step with no split is all `manual` in both. Present only when a step has a split.
   */
  partHours?: { actual: Record<string, Record<string, PartHours>>; before: Record<string, Record<string, PartHours>> };
  /**
   * Hours the changes freed, a month on average (P3; present with `partHours`). `byChange` lists every change of the model (0 when it
   * freed nothing), `byPerson` the people it freed time for, each by change, and `total` is their sum. When two changes act on one
   * part the earlier one in the model's `changes` list is credited first (`stepPartsDetail`). A change can free a negative number
   * of hours (a checking time above what it removes).
   */
  freed?: { total: number; byChange: Record<string, number>; byPerson: Record<string, Record<string, number>> };
  /**
   * The same by month, everyone together, in hours in that month (not a monthly average), on the months of a monthly run: parts
   * after and before the changes, and the hours freed per change. Present only when the run is monthly (`simulate(…, { monthly: true })`).
   */
  monthly?: { actual: PartHours[]; before: PartHours[]; freed: Record<string, number[]> };
}

/** Hours of hands-on time in the three parts of a step's split (`EngineStep.split`). */
export interface PartHours {
  automatable: number;
  augmentable: number;
  manual: number;
}

/** One month of a role's or person's busy share across replications. */
export interface MonthBusy extends Stat {
  /** Hours a week they have that month (capacity less leave, and before a start or after an end date). */
  capacity: number;
  /** Hours a week of work that month, on average. */
  work: number;
}

/**
 * A run month by month (the forecast, issue #35): `simulate(model, reps, seed, { monthly: true })`. Busy shares are
 * work ÷ (hours available + overtime), the same sum the run's own utilisation uses, but per month and with leave and
 * planned starts and end dates taken off the hours available.
 */
export interface MonthlyResult {
  /** Each month's start and end, in working hours from t = 0. */
  months: { start: number; end: number }[];
  /** Per role id and month; null when nobody in the role is there that month. */
  roles: Record<string, (MonthBusy | null)[]>;
  /** Per role id and month: hours a week of work nobody in the role was there to do (see `MonthlyReplication.roleUncovered`); null when none. */
  uncovered: Record<string, (number | null)[]>;
  /** Per person id and month; null when they aren't there at all that month. */
  people: Record<string, (MonthBusy | null)[]>;
  /** Mean hours waited for a person per step id and month (all replications together); null with no waits that month. */
  waits: Record<string, (number | null)[]>;
  /** Where working time goes by what the steps achieve (sandbox G, engine 1.14.0). */
  time: {
    /** Purpose keys on the model's steps, in first-seen step order; "" when a step has none. */
    purposes: string[];
    roles: Record<string, TimeSplit>;
    people: Record<string, TimeSplit>;
    /** Everyone together: the sum over people (so nobody in two roles is counted twice), uncovered summed over roles. */
    team: TimeSplit;
  };
  /** Servicing tasks done late or missed, per month. */
  lateTasks: Stat[];
  /** Active clients per service id per month ("" for none, and for the pooled count). */
  clients: Record<string, Stat[]>;
  /** Monthly recurring revenue per month (see `MonthlyReplication.mrr`). */
  mrr: Stat[];
  /** Sales: qualified opportunities, wins and losses per month, and wins ÷ (wins + losses) (`ratioStat`). */
  sales: { opportunities: Stat[]; won: Stat[]; lost: Stat[]; conversion: Stat[] };
  clientsWon: Stat[];
  clientsLost: Stat[];
  /** Billed revenue per month, split three ways, with what came from clients won in the run and the fees lost to churn. */
  revenue: { total: Stat[]; recurring: Stat[]; oneOff: Stat[]; hourly: Stat[]; fromNew: Stat[]; lostToChurn: Stat[]; rise: Stat[] };
  /** Overtime hours per month, everyone together. */
  overtimeHours: Stat[];
  /**
   * Costs and profit per month; null when `model.payHidden`. `labour` (and its splits) is the same in every replication
   * (paid hours × rate, no overtime). Profit per month is the spread of each replication's own profit, so the months'
   * profits can differ a little from the run's `kpi.profit` (overtime is worked out month by month here).
   */
  money: {
    labour: number[];
    labourByRole: Record<string, number[]>;
    labourByPerson: Record<string, number[]>;
    overtimeCost: Stat[];
    overheads: number[];
    profit: Stat[];
  } | null;
  /** Clients at risk (health below 50) per service key and month; empty without a client roster. */
  atRisk: Record<string, Stat[]>;
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
  /** Their cost: each person's overtime hours × their cost rate. Null when `model.payHidden`. */
  overtimeCost: number | null;
  /**
   * Revenue billed in the window (engine 1.11.0): recurring fees (every active client, pro rata; a pooled model's include
   * the interim clients, which `billed` leaves out), one-off prices, and hourly work for clients won in the run. `fromNew`
   * is the part from clients won in the run. Total = recurring + oneOff + hourly.
   */
  revenue: { recurring: number; oneOff: number; hourly: number; fromNew: number; rise: number };
  /** Per hourly service id: hands-on hours billed and what they bill (present, 0, when none). */
  hourly: Record<string, { hours: number; revenue: number }>;
  /** Paid hours × rate (capacity × weeks on the team × `rateOf`), overtime excluded; leave is paid. Null when `model.payHidden`. */
  labourCost: number | null;
  /** `overheadMonthly` × weeks ÷ (52/12). */
  overheads: number;
  /** Revenue total − labourCost − overtimeCost − overheads. Null when `model.payHidden`. */
  profit: number | null;
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
  /** Present only when the run was asked for month-by-month numbers (see `MonthlyReplication`). */
  monthly?: MonthlyReplication;
  /** Present only when the run was asked for where each person's time goes (see `PersonTime`). */
  personTime?: PersonTime;
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
  /** Overtime cost over the horizon: overtime hours × cost rate. Null when `model.payHidden`: it depends on each person's pay. */
  overtimeCost: Stat | null;
  /**
   * Total billed revenue (engine 1.11.0): recurring + one-off + hourly. Not `billed`, which is kept as it was (a
   * pooled model's `billed` leaves out the interim clients; this includes them).
   */
  revenue: Stat;
  revenueHourly: Stat;
  /** By hourly service id: hands-on hours billed and their revenue. */
  hourly: Record<string, { hours: Stat; revenue: Stat }>;
  /** Paid hours × rate, overtime excluded. Null when `model.payHidden`. */
  labourCost: Stat | null;
  /** Fixed costs over the horizon (`overheadMonthly` × weeks ÷ (52/12)); never hidden. */
  overheads: number;
  /** Revenue − labour cost − overtime cost − overheads. Null when `model.payHidden`. */
  profit: Stat | null;
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
  /** Total billed revenue and profit (null when `model.payHidden`) per replication. */
  revenue: number[];
  profit: number[] | null;
  /** Revenue a fee channel added (the part of `revenue` above the fees without it), per replication. */
  revenueRise: number[];
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
  /** Month by month, only when the run was asked for it (`simulate(…, { monthly: true })`). */
  monthly?: MonthlyResult;
  /** Where each person's time goes, by step, and their clients by service: only when asked for (`simulate(…, { personTime: true })`). Means over the replications. */
  personTime?: PersonTime;
  /**
   * With `monthly`: each replication's own months (replication × month), for paired comparisons such as the price-rise
   * trade-off (the same seed and warm-up give the same random numbers, so two runs' replications pair up).
   */
  monthlySamples?: { revenue: number[][]; rise: number[][]; clientsLost: number[][] };
}

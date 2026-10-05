// Discrete-event Monte Carlo simulation, ported from the Northbeam
// prototype's `ProcessSim` (prototype/northbeam-process-simulator.html).
// Fixed so far (docs/PRD.md §6.8): separate random streams per purpose, a
// binary-heap event queue, dispatch to named people, a start from current
// WIP or a discarded warm-up instead of an empty business, and revenue priced
// per service and booked once per entity at its first win, and ongoing
// utilisation reported from the live client count the run actually used
// (item 2). With a client roster, ongoing load is per client and person, and
// overtime extends capacity up to the workspace's cap (§6.3.4, issue #18).
// Clients generate servicing tasks that move their health, and health drives
// their churn (§6.3.5, issue #19).
//
// Time runs from -warmup to H; everything reported is measured over [0, H].

import {
  AWAY_PRESSURE,
  EARLY_TENURE_WEEKS,
  loadPressure,
  onboardingPressure,
  pricePressure,
  PRICE_WEIGHT_WEEKS,
  resolveChurnDrivers,
  responsePressure,
  resultsPressure,
  reworkPressure,
  summariseChurn,
  type ChurnReplication,
} from "./churn-drivers";
import { carriersFor, clientChurnMonthly, clientRoleLoads, rolePools, withClientGroups } from "./clients";
import {
  AT_RISK_HEALTH,
  clampHealth,
  clientChurnSensitivity,
  healthRules,
  poissonMeanGap,
  recurrenceInterval,
  servicingLinks,
  servicingStepIds,
} from "./servicing";
import { arrivalTimes as drawArrivals } from "./demand";
import { activeMarket, type MarketFactors } from "./market";
import { EventQueue } from "./event-queue";
import { eligible } from "./eligibility";
import { flattenModel } from "./flatten";
import { detectLoops, type Loop } from "./loops";
import type {
  ClientReplication,
  ClientResult,
  Distribution,
  EngineServicingLink,
  EngineEdge,
  EngineEnd,
  EngineModel,
  EnginePerson,
  EngineService,
  EngineStep,
  InitialState,
  Kpis,
  LoopReplication,
  LoopResult,
  ReworkTotal,
  Outcome,
  PersonResult,
  ReplicationResult,
  ReplicationSamples,
  RoleResult,
  ServiceCounts,
  Stat,
  SimulationResult,
  StepFacts,
  StepResult,
  Touchpoints,
  TraceEntity,
  TraceSegment,
  WeeklySamples,
} from "./model";
import { expo, lognormal, lognormalSampler, StreamLabels, Streams, triangular, type Rng } from "./random";
import { ENGINE_VERSION } from "./version";

/** The trace of every entity in a run that keeps none: never written to. */
const NO_TRACE: TraceSegment[] = [];

/** Minimum share of a person's time left for pipeline work, unless the model sets one. */
export const DEFAULT_AVAILABILITY_FLOOR = 0.08;
const DEFAULT_WORK_DIST: Distribution = { kind: "lognormal", cv: 0.35 };
const DEFAULT_WAIT_DIST: Distribution = { kind: "lognormal", cv: 0.3 };
const WEEKS_PER_MONTH = 4.33;
/** Stride between replication seeds. */
export const SEED_STRIDE = 7919;
/** Automatic warm-up: at least this many weeks (docs/PRD.md §6.3.1)... */
const DEFAULT_WARMUP_WEEKS = 4;
/** ...or twice the pilot run's P90 cycle time if longer, up to this cap. */
const MAX_WARMUP_WEEKS = 52;
/** Seed of the pilot run that sizes the automatic warm-up; fixed, so the warm-up is a property of the model. */
const PILOT_SEED = 1;
/** Each model's rework loops, found once and shared by its replications. */
const loopCache = new WeakMap<EngineModel, Loop[]>();
function loopsOf(model: EngineModel): Loop[] {
  let loops = loopCache.get(model);
  if (!loops) loopCache.set(model, (loops = detectLoops(model)));
  return loops;
}
/** Each model's stream labels, shared by its replications. */
const streamLabels = new WeakMap<EngineModel, StreamLabels>();

interface SimEntity extends TraceEntity {
  seg: TraceSegment | null;
  /** Index of its service in the run's service list. */
  svc: number;
  /** Set for a servicing task. */
  task?: Task;
  /**
   * Per rework loop (by index in the run's loop list), where the item is: `LP_*` bits, and in `lv` its rounds and
   * the elapsed hours its repeat passes added, two numbers a loop. Null until it first reaches a step in a loop.
   */
  lp: Uint8Array | null;
  lv: Float64Array | null;
}

/** Bits of `SimEntity.lp`: in the loop's region now; went round at least once on this stay (so it is on a repeat pass). */
const LP_INSIDE = 1;
const LP_WENT = 2;

/** A rework loop as a run tracks it (see loops.ts). */
interface LoopRun {
  def: Loop;
  idx: number;
  body: Set<string>;
  redo: boolean;
  /** Items that left the loop's region in the measured window (resolved), those that went round, and their rounds and extra elapsed hours. */
  entered: number;
  went: number;
  rounds: number;
  extraElapsed: number;
  /** Hands-on hours on repeat passes in the measured window, by role (each pass counted in the innermost loop it is on). */
  roleHours: Map<string, number>;
}

/** A servicing task in flight: whose it is and when it is due. */
interface Task {
  client: RosterClient;
  /** Done by then: on time. */
  due: number;
  /** Not done by then: missed. */
  deadline: number;
  state: "open" | "done" | "missed";
  /** An ad-hoc request (a Poisson link) rather than scheduled work: it feeds the response-time driver. */
  adhoc: boolean;
}

/** One recurring servicing process of one client. */
interface LinkState {
  link: EngineServicingLink;
  /** Entry step or end of its process, resolved. */
  entry: Target;
  svc: number;
  /** Hours between tasks; null for Poisson requests (`gap` is then their mean). */
  interval: number | null;
  gap: number;
  rng: Rng;
}

type EventType = "arrive" | "week" | "measure" | "back" | "away" | "end" | "leave" | "task";

/**
 * A timed event. One shape for every type (unused fields null), so the event
 * loop's property reads stay monomorphic, and handled events are recycled
 * (see `schedule`) rather than left to the garbage collector:
 * arrive, week, measure: no fields; back, away: `p`; end: `e`, `st`, `p`;
 * leave: `e`, `st`; task: `c`, `l`.
 */
interface SimEvent {
  t: number;
  type: EventType;
  e: SimEntity | null;
  st: StepState | null;
  p: PersonState | null;
  c: RosterClient | null;
  l: LinkState | null;
}

interface StepStat {
  arrivals: number;
  qLen: number;
  qArea: number;
  qLast: number;
  qMax: number;
  waitSum: number;
  waitN: number;
  reworks: number;
  /** Queue area over the second half of the measured window. */
  qAreaLate: number;
  departures: number;
  slaBreaches: number;
  /** Visits that went straight to a lost end (a lead lost at this step). */
  lostHere: number;
  /** Hands-on hours of visits a person worked, and how many; external wait hours and the visits that had it. `stretchSum`: extra elapsed time from part-time availability (elapsed minus hands-on). */
  stretchSum: number;
  handsOnSum: number;
  handsOnN: number;
  fixedWaitSum: number;
  fixedWaitN: number;
}

/** A first-in, first-out queue of items waiting at a step. */
class Fifo {
  /** A ring buffer (its length a power of 2): `n` items from `head` on, wrapping round. */
  private buf: (SimEntity | null)[] = [null, null, null, null, null, null, null, null];
  private head = 0;
  private n = 0;

  get size(): number {
    return this.n;
  }

  /** The oldest item, if any. */
  peek(): SimEntity | undefined {
    return this.n ? this.buf[this.head]! : undefined;
  }

  push(e: SimEntity): void {
    const buf = this.buf;
    const cap = buf.length;
    if (this.n === cap) {
      // Full: double it, oldest first.
      const next: (SimEntity | null)[] = new Array<SimEntity | null>(cap * 2).fill(null);
      for (let i = 0; i < cap; i++) next[i] = buf[(this.head + i) & (cap - 1)]!;
      this.buf = next;
      this.head = 0;
      next[cap] = e;
    } else {
      buf[(this.head + this.n) & (cap - 1)] = e;
    }
    this.n++;
  }

  shift(): void {
    const buf = this.buf;
    buf[this.head] = null;
    this.head = (this.head + 1) & (buf.length - 1);
    this.n--;
  }
}

/** Where an edge leads: a working step, or an end (resolved once per run, not per visit). */
interface Target {
  id: string;
  st: StepState | undefined;
  end: EngineEnd | undefined;
}

/** Hands-on hours a role worked in the measured window, pipeline and servicing. */
interface RoleAcc {
  busy: number;
  svc: number;
}

/** Servicing tasks waiting for a client's assigned person at one step: a queue per person, in the order they first had one. */
interface Assigned {
  people: PersonState[];
  lists: Fifo[];
  /** Tasks waiting across the lists, so steps with none are skipped. */
  waiting: number;
}

/** A step's run-time state: its statistics, queue, who can work it, and its random streams. */
interface StepState {
  s: EngineStep;
  stat: StepStat;
  queue: Fifo;
  /** Eligible people; unstaffed for pure waits and decisions. */
  people: PersonState[];
  staffed: boolean;
  work: () => number;
  /** Null when the step has no external wait. */
  wait: (() => number) | null;
  rework: Rng;
  route: Rng;
  /** Edges to choose from per service index, when any edge is condition-tagged; null otherwise. */
  routes: Route[] | null;
  /** Where each of the step's edges (`s.next`) leads. */
  targets: Target[];
  /** The rework loops whose body holds this step (empty for most). */
  loops: LoopRun[];
  /** With a market: which of `s.next` lead to the sale (see `signingEdges`); null when conv doesn't apply here. */
  winEdges: EdgeKind[] | null;
  /** With a market: the sale is still ahead (a lost end can be reached from here), so "time to decide" applies to its external wait. */
  beforeSale: boolean;
  /** Its role's hour counters; null when the step has no role the model knows. */
  acc: RoleAcc | null;
  /**
   * Servicing steps: tasks waiting for the client's assigned person, by
   * person (the rest wait in `queue`, for anyone eligible). Null for the
   * pipeline's steps.
   */
  assigned: Assigned | null;
}

/** The edges an entity picks from at a step, and their total probability. */
interface Route {
  next: EngineEdge[];
  total: number;
  /** Where each of `next` leads. */
  targets: Target[];
  /** As `StepState.winEdges`, for `next`. */
  winEdges: EdgeKind[] | null;
}

/** A service as a run uses it. */
interface ServiceState {
  /** Null for the implicit retainer of a model without services. */
  id: string | null;
  s: EngineService;
  entry: string;
  /** Expected value of one client: price × tenure (retainer), price (one-off), nothing (hourly). */
  value: number;
  counts: ServiceCounts;
  /** Wins in the measured window, each weighted by the market's price factor in its month (market.ts); equals `counts.won` with no market. */
  wonUnits: number;
}

/**
 * The model's services, or one implicit retainer at `model.retainer` when it
 * has none, so such a model's revenue is `won × retainer` as before.
 */
function resolveServices(model: EngineModel): ServiceState[] {
  const given = Object.entries(model.services ?? {});
  const churn = model.churnMonthly;
  const entries: [string | null, EngineService][] = given.length
    ? given
    : [
        [
          null,
          {
            name: "Retainer",
            pricingModel: "retainer",
            price: model.retainer,
            margin: 0,
            tenureMonths: churn > 0 ? 1 / churn : 0,
            churnMonthly: churn,
            mixShare: 1,
            pathTags: [],
          },
        ],
      ];
  return entries.map(([id, s]) => ({
    id,
    s,
    entry: s.entry ?? model.entry,
    value: s.pricingModel === "retainer" ? s.price * s.tenureMonths : s.pricingModel === "one_off" ? s.price : 0,
    counts: { arrivals: 0, won: 0, lost: 0 },
    wonUnits: 0,
  }));
}

/**
 * Which of a step's edges an entity on this service picks from. Tagged edges
 * take precedence: the entity follows the edges tagged with one of its
 * service's path tags; if none match, the untagged edges; if the step has no
 * untagged edges either, all of them. Probabilities are renormalised within
 * the chosen edges (all of them: as entered). So `seo` and `ppc` tagged edges
 * split entities by service, and a `fast-track` tagged edge next to untagged
 * ones diverts only entities carrying that tag while the rest split between
 * the untagged edges in proportion to their probabilities.
 */
export function routeFor(edges: EngineEdge[], tags: string[]): Route {
  const sum = (next: EngineEdge[]) => next.reduce((a, n) => a + n.p, 0);
  const tagged = edges.filter((n) => n.tag !== undefined && tags.includes(n.tag));
  if (tagged.length) return { next: tagged, total: sum(tagged), targets: [], winEdges: null };
  const untagged = edges.filter((n) => n.tag === undefined);
  if (untagged.length) return { next: untagged, total: sum(untagged), targets: [], winEdges: null };
  return { next: edges, total: 1, targets: [], winEdges: null };
}

/** What an edge or step can lead to: a won end, a lost end, or both (through different paths). */
interface Reach {
  won: boolean;
  lost: boolean;
}

/**
 * For every step and end, whether a won end and a lost end can be reached
 * from it (through any edge; an end with a hand-off continues there, unless it
 * is itself a win or a loss). Used by the market to find where a sale is
 * decided and which steps come before it.
 */
function outcomeReach(stepStates: Map<string, StepState>, ends: Map<string, EngineEnd>): Map<string, Reach> {
  const reach = new Map<string, Reach>();
  const of = (id: string): Reach => {
    const end = ends.get(id);
    if (end) {
      if (end.outcome === "won") return { won: true, lost: false };
      if (end.outcome === "lost") return { won: false, lost: true };
      return end.handoff ? { ...(reach.get(end.handoff) ?? { won: false, lost: false }) } : { won: false, lost: false };
    }
    return reach.get(id) ?? { won: false, lost: false };
  };
  for (const id of stepStates.keys()) reach.set(id, { won: false, lost: false });
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, st] of stepStates) {
      const r = reach.get(id)!;
      for (const n of st.s.next) {
        const t = of(n.to);
        if (t.won && !r.won) {
          r.won = true;
          changed = true;
        }
        if (t.lost && !r.lost) {
          r.lost = true;
          changed = true;
        }
      }
    }
  }
  const all = new Map(reach);
  for (const id of ends.keys()) all.set(id, of(id));
  return all;
}

/** Where an edge leads, for the market's "enquiries that sign": only to a win, only to a loss, or still either way. */
type EdgeKind = "win" | "lose" | "open";

/**
 * How each edge of a step leads, when this step is where a sale is decided:
 * at least one edge goes only to a win (a won end, or steps that go on to one
 * and can't be lost) and at least one goes only to a loss. Edges that can
 * still end either way (a follow-up loop) are "open" and keep their
 * probability. Elsewhere (earlier steps, or steps with no such pair: kickoff
 * splitting between services, say) it is null, so "enquiries that sign"
 * applies once per path.
 */
function signingEdges(targets: Target[], reach: Map<string, Reach>): EdgeKind[] | null {
  const kinds = targets.map((t): EdgeKind => {
    const r = reach.get(t.id);
    return r?.won && !r.lost ? "win" : r?.lost && !r.won ? "lose" : "open";
  });
  return kinds.includes("win") && kinds.includes("lose") ? kinds : null;
}

/**
 * Pick an edge when the market scales "enquiries that sign" by `conv`: with W
 * the win-only edges' probability and L the loss-only edges', the wins become
 * min(W + L, W × conv) and the losses take the rest of W + L; open edges keep
 * theirs, so the total is unchanged. Uses the same single draw `u`.
 */
function pickWithSigning(next: EngineEdge[], kinds: EdgeKind[], u: number, conv: number): number {
  let win = 0;
  let lose = 0;
  for (let i = 0; i < next.length; i++) {
    if (kinds[i] === "win") win += next[i]!.p;
    else if (kinds[i] === "lose") lose += next[i]!.p;
  }
  const newWin = Math.min(win + lose, win * conv);
  const winScale = win > 0 ? newWin / win : 1;
  const loseScale = lose > 0 ? (win + lose - newWin) / lose : 1;
  let acc = 0;
  for (let i = 0; i < next.length; i++) {
    acc += next[i]!.p * (kinds[i] === "win" ? winScale : kinds[i] === "lose" ? loseScale : 1);
    if (u < acc) return i;
  }
  return next.length - 1;
}

/** Repeated duration draws with the given mean (same values as `sampleDuration`). */
function durationSampler(rng: Rng, mean: number, dist: Distribution): () => number {
  if (dist.kind === "lognormal") return lognormalSampler(rng, mean, dist.cv);
  return () => sampleDuration(rng, mean, dist);
}

/** Sample a duration with the given mean. */
export function sampleDuration(rng: Rng, mean: number, dist: Distribution): number {
  switch (dist.kind) {
    case "constant":
      return mean;
    case "exponential":
      return mean > 0 ? expo(rng, mean) : 0;
    case "lognormal":
      return lognormal(rng, mean, dist.cv);
    case "triangular":
      return triangular(rng, dist.min, dist.mode, dist.max);
  }
}

/** The model's people, or one anonymous person per role head-count when it has none. */
export function resolvePeople(model: EngineModel): Record<string, EnginePerson> {
  if (model.people && Object.keys(model.people).length) return model.people;
  const people: Record<string, EnginePerson> = {};
  for (const rid in model.roles) {
    const role = model.roles[rid]!;
    const count = Math.max(1, role.count);
    for (let i = 1; i <= count; i++) {
      people[`${rid}#${i}`] = { name: `${role.name} ${i}`, roles: [rid], capacity: model.hoursPerWeek };
    }
  }
  return people;
}

interface PersonState {
  id: string;
  person: EnginePerson;
  busy: boolean;
  /** When they last became free; the longest-idle eligible person gets new work. */
  freeSince: number;
  busyHours: number;
  /** Hands-on hours on servicing tasks (not in `busyHours`). */
  svcHours: number;
  completed: number;
  steps: StepState[];
  leave: [number, number][] | null;
  /** Pipeline share of the week, cached until their ongoing load changes. */
  frac: number;
  fracDirty: boolean;
  /** The service in progress, so hands-on time straddling the end of the warm-up can be split. */
  cur: { start: number; end: number; handsOn: number; acc: RoleAcc | null; over: boolean; svc: boolean } | null;
  /** Ongoing client hours a week they carry now, in total and by role (indexed as `roleIds`; `roleHas` marks the roles they carry any of). */
  load: number;
  roleLoad: Float64Array;
  roleHas: Uint8Array;
  /** With a roster: each active client's share of their load, as flat (role index, hours a week) pairs. */
  contrib: Map<RosterClient, number[]>;
  /** With a roster: active clients assigned to them in any role. */
  clients: number;
  /** Measured-window integrals of the above, from `lastT` on. */
  lastT: number;
  ongoingHours: number;
  roleOngoingHours: Float64Array;
  roleOngoingHas: Uint8Array;
  clientWeeks: number;
  /** While overloaded (load above capacity, with an overtime cap): weeks, ongoing hours and pipeline hands-on hours. */
  overWeeks: number;
  overOngoing: number;
  overPipeline: number;
  /** Which team's list they were last added to (see `teamFor`). */
  teamMark: number;
  /** Their busy share so far in the measured window, as of the last weekly churn tick (the team-overload driver). */
  util: number;
}

/** The people who look after some clients, shared by every client with the same services and assignees: their busy share and leave are read once a tick. */
interface Team {
  people: PersonState[];
  /** The busiest of them so far, and whether any is away, as of the tick `stamp`. */
  util: number;
  away: boolean;
  stamp: number;
}

/** A client active in a run: a roster client, or one won during it. */
interface RosterClient {
  /** Roster id, or `won:<n>`. */
  key: string;
  /** Whether it is on the roster (reported per client) rather than won during the run. */
  roster: boolean;
  /** Base monthly churn and health sensitivity (docs/PRD.md §6.3.5). */
  churnBase: number;
  sensitivity: number;
  rng: Rng;
  /** Who carries its load: [person, role, hours a week]. */
  carriers: [PersonState, string, number][];
  /** People assigned to it in any role. */
  assigned: PersonState[];
  /** Its assigned person per role id, for servicing tasks. */
  assignees: Map<string, PersonState>;
  active: boolean;
  health: number;
  touch: Touchpoints;
  /** Health at t = 0 and each weekly tick (roster clients only). */
  trajectory: number[] | null;
  churned: boolean;
  /** What it bills a week while active, and since when. */
  weeklyBill: number;
  since: number;
  /**
   * Its tasks that can still be missed within the run, by deadline (ties in
   * creation order). A task is marked missed when the run reaches its
   * deadline, found lazily (`settleMisses`) rather than by an event each.
   * Those before `openHead` are settled.
   */
  open: Task[];
  openHead: number;
  /** The service whose group or roster entry it is (the first it takes), "" for none. */
  svcKey: string;
  /** People who look after it: its carriers and the people of its servicing processes' roles. */
  team: Team;
  /** Churn drivers' measures: ad-hoc requests and those late or missed, servicing visits and those repeated. */
  adhocN: number;
  adhocBad: number;
  visits: number;
  reworks: number;
  /** When its first servicing task was done (hours; -1 until then). */
  firstDone: number;
  /** At the last weekly tick: the churn drivers' pressure other than late work, and the market's multiplier. */
  extraA: number;
  lastB: number;
  /** Its service's row of the per-service churn accounting, found at its first tick. */
  causeRow: Float64Array | null;
  /** Whether any of its services has a servicing process: only then is there a first delivery to wait for. */
  serviced: boolean;
  /** What it shares with clients of the same services and assignees (see `shapeFor`). */
  shape: ClientShape;
}

/**
 * What clients with the same services and assignees have in common, worked out once a run for the first of them and
 * shared, read-only, by the rest: who carries their load and in what parts, who is assigned, and the team.
 */
interface ClientShape {
  churnBase: number;
  sensitivity: number;
  carriers: [PersonState, string, number][];
  assigned: PersonState[];
  assignees: Map<string, PersonState>;
  svcKey: string;
  serviced: boolean;
  team: Team;
  /** Each carrier once, in the order first met, and their parts of the load as flat (role index, hours a week) pairs. */
  touched: PersonState[];
  parts: number[][];
}

/** True when any step has current WIP entered (0 counts: "nothing here right now"). */
function hasWip(model: EngineModel): boolean {
  return model.steps.some((s) => s.currentWip != null);
}

/**
 * How a run starts (docs/PRD.md §6.3.1): from entered WIP if any step has it;
 * otherwise after a warm-up of `warmupWeeks`, or an automatic one (4 weeks,
 * extended to 2x the P90 cycle time of a pilot run from empty, capped at 52
 * weeks; the cap too when nothing completes in the pilot).
 */
export function initialState(model: EngineModel): InitialState {
  model = flattenModel(model);
  if (hasWip(model)) {
    return { kind: "wip", items: model.steps.reduce((a, s) => a + wipCount(s), 0) };
  }
  const hours =
    model.warmupWeeks !== undefined ? Math.max(0, model.warmupWeeks) * model.hoursPerWeek : autoWarmupHours(model);
  return hours > 0 ? { kind: "warmup", hours } : { kind: "empty" };
}

/** A pilot run from empty over the model's horizon; if nothing completes in it, the cap. */
function autoWarmupHours(model: EngineModel): number {
  const cap = MAX_WARMUP_WEEKS * model.hoursPerWeek;
  const pilot = runOnce(model, PILOT_SEED, false, { kind: "empty" });
  if (!pilot.cycle.length) return cap;
  return Math.min(cap, Math.max(DEFAULT_WARMUP_WEEKS * model.hoursPerWeek, 2 * pct(pilot.cycle, 0.9)));
}

const wipCount = (s: EngineStep) => Math.max(0, Math.floor(s.currentWip ?? 0));

export function runOnce(
  model: EngineModel,
  seed: number,
  keepTrace: boolean,
  start: InitialState = initialState(model),
  sampleWeekly = false,
): ReplicationResult {
  // Groups and child processes are only a view: runs see leaf steps (a no-op for flat models).
  model = withClientGroups(flattenModel(model));
  const streams = new Streams(seed);
  let labels = streamLabels.get(model);
  if (!labels) streamLabels.set(model, (labels = new StreamLabels()));
  const H = model.horizonWeeks * model.hoursPerWeek;
  const W = start.kind === "warmup" ? start.hours : 0;
  const floor = model.availabilityFloor ?? DEFAULT_AVAILABILITY_FLOOR;
  const overtimeCap = Math.max(0, model.overtimeCap ?? 0);
  const roster = model.clients !== undefined;
  const peopleModel = resolvePeople(model);
  const services = resolveServices(model);
  const hasServices = services[0]!.id !== null;
  // Market conditions (market.ts); null when the model has none or they are all Stable, which leaves every path below as it was.
  const market = activeMarket(model);
  // The month the factors come from is looked up per event, so the checks and the month length are done once here.
  const monthHours = (52 / 12) * model.hoursPerWeek;
  const lastMonth = market ? market.months.length - 1 : 0;
  const mkt = (t: number): MarketFactors => market!.months[t < 0 ? 0 : Math.min(Math.floor(t / monthHours), lastMonth)]!;
  for (const sv of services) {
    if (!(sv.s.mixShare >= 0)) throw new Error(`Service '${sv.s.name}' needs a mix share of 0 or more`);
  }
  const mixTotal = services.reduce((a, sv) => a + sv.s.mixShare, 0);
  if (!(mixTotal > 0)) throw new Error("The services' mix shares must add up to more than 0");
  /** Draw an arrival's service from the mix; always the implicit one when the model has none. */
  const drawService = (rng: Rng) => {
    if (!hasServices) return 0;
    const u = rng() * mixTotal;
    let acc = 0;
    for (let i = 0; i < services.length - 1; i++) {
      acc += services[i]!.s.mixShare;
      if (u < acc) return i;
    }
    return services.length - 1;
  };

  // Servicing (docs/PRD.md §6.3.5): only with a roster, whose clients generate the tasks.
  const rules = healthRules(model);
  const processes = model.servicingProcesses ?? {};
  const linksBySvc = services.map((sv) => (roster ? servicingLinks(model, sv.s) : []));
  const servicing = linksBySvc.some((links) => links.length > 0);
  const servicingSteps = new Set<string>();
  if (servicing) for (const p of Object.values(processes)) for (const id of p.steps) servicingSteps.add(id);

  // Hands-on hours per role, shared by the role's steps.
  const roleAcc: Record<string, RoleAcc> = {};
  for (const rid in model.roles) roleAcc[rid] = { busy: 0, svc: 0 };

  const stepStates = new Map<string, StepState>();
  for (const s of model.steps) {
    const waitDist = s.waitDist ?? DEFAULT_WAIT_DIST;
    stepStates.set(s.id, {
      s,
      stat: {
        arrivals: 0,
        qLen: 0,
        qArea: 0,
        qLast: 0,
        qMax: 0,
        waitSum: 0,
        waitN: 0,
        reworks: 0,
        qAreaLate: 0,
        departures: 0,
        slaBreaches: 0,
        lostHere: 0,
        stretchSum: 0,
        handsOnSum: 0,
        handsOnN: 0,
        fixedWaitSum: 0,
        fixedWaitN: 0,
      },
      queue: new Fifo(),
      people: [],
      staffed: Boolean(s.role || s.person),
      work: durationSampler(streams.get(labels.join("work", s.id)), s.work, s.workDist ?? DEFAULT_WORK_DIST),
      wait:
        s.wait || waitDist.kind === "triangular"
          ? durationSampler(streams.get(labels.join("wait", s.id)), s.wait, waitDist)
          : null,
      rework: streams.get(labels.join("rework", s.id)),
      route: streams.get(labels.join("route", s.id)),
      routes:
        hasServices && s.next.some((n) => n.tag !== undefined)
          ? services.map((sv) => routeFor(s.next, sv.s.pathTags))
          : null,
      targets: [],
      loops: [],
      winEdges: null,
      beforeSale: false,
      acc: s.role !== null && Object.hasOwn(roleAcc, s.role) ? roleAcc[s.role]! : null,
      assigned: servicingSteps.has(s.id) ? { people: [], lists: [], waiting: 0 } : null,
    });
  }
  // End steps: the two sinks, then any further ones (which may override them).
  const ends = new Map<string, EngineEnd>([
    [model.sinks.won, { outcome: "won" }],
    [model.sinks.lost, { outcome: "lost" }],
    ...Object.entries(model.ends ?? {}),
  ]);
  for (const sv of services) {
    if (!stepStates.has(sv.entry)) throw new Error(`Service '${sv.s.name}' enters at unknown step '${sv.entry}'`);
  }
  const stepList = [...stepStates.values()];
  // Each edge's target, resolved once: a working step or an end (unknown ones throw when reached).
  const targetFor = (id: string): Target => ({ id, st: stepStates.get(id), end: ends.get(id) });
  for (const st of stepList) {
    st.targets = st.s.next.map((n) => targetFor(n.to));
    if (st.routes) for (const r of st.routes) r.targets = r.next.map((n) => targetFor(n.to));
  }
  // Rework loops (loops.ts): found once per model, tracked per item below without touching any random stream.
  const loopRuns: LoopRun[] = loopsOf(model).map((def, idx) => ({
    def,
    idx,
    body: new Set(def.body),
    redo: def.kind === "redo",
    entered: 0,
    went: 0,
    rounds: 0,
    extraElapsed: 0,
    roleHours: new Map(),
  }));
  for (const L of loopRuns) for (const id of L.def.body) stepStates.get(id)?.loops.push(L);
  // Innermost first (smallest body, then loop order): a repeat pass is counted once, in the first active loop.
  for (const st of stepList) st.loops.sort((a, b) => a.body.size - b.body.size || a.idx - b.idx);
  const nLoops = loopRuns.length;
  /** All repeat passes together, so loops that overlap are not double counted. */
  const reworkRoles = new Map<string, number>();
  let reworkElapsed = 0;
  if (market) {
    const reach = outcomeReach(stepStates, ends);
    for (const st of stepList) {
      st.beforeSale = reach.get(st.s.id)?.lost === true;
      st.winEdges = signingEdges(st.targets, reach);
      if (st.routes) for (const r of st.routes) r.winEdges = signingEdges(r.targets, reach);
    }
  }
  const entryTargets = services.map((sv) => targetFor(sv.entry));

  // Who can do what.
  const canDo = (pid: string, p: EnginePerson, s: EngineStep) =>
    s.person ? s.person === pid : p.skills ? p.skills.includes(s.id) : s.role !== null && p.roles.includes(s.role);
  // Roles by index, for people's loads (a person's sums per role are kept in arrays rather than maps).
  const roleIds = Object.keys(model.roles);
  const roleIndex = new Map(roleIds.map((rid, i) => [rid, i]));
  const people: PersonState[] = Object.entries(peopleModel).map(([id, person]) => ({
    id,
    person,
    busy: false,
    freeSince: 0,
    busyHours: 0,
    svcHours: 0,
    completed: 0,
    steps: stepList.filter((st) => canDo(id, person, st.s)),
    leave: person.leave?.length ? person.leave : null,
    frac: 0,
    fracDirty: true,
    cur: null,
    load: 0,
    roleLoad: new Float64Array(roleIds.length),
    roleHas: new Uint8Array(roleIds.length),
    contrib: new Map(),
    clients: 0,
    lastT: -W,
    ongoingHours: 0,
    roleOngoingHours: new Float64Array(roleIds.length),
    roleOngoingHas: new Uint8Array(roleIds.length),
    clientWeeks: 0,
    overWeeks: 0,
    overOngoing: 0,
    overPipeline: 0,
    teamMark: 0,
    util: 0,
  }));
  for (const st of stepList) st.people = people.filter((p) => p.steps.includes(st));

  // Capacity per role: each person's capacity split evenly across their roles.
  const roleCapacity: Record<string, number> = {};
  for (const rid in model.roles) roleCapacity[rid] = 0;
  for (const p of people) {
    for (const rid of p.person.roles) {
      if (!(rid in roleCapacity)) continue;
      roleCapacity[rid]! += p.person.capacity / p.person.roles.length;
    }
  }

  let active = roster ? 0 : model.activeClients;
  const events = new EventQueue<SimEvent>();
  let entities: SimEntity[] = [];
  let eid = 0;
  const cycle: number[] = [];
  let won = 0;
  let lost = 0;
  let done = 0;
  let billed = 0;

  /** Handled events, reused by `schedule`. */
  const pool: SimEvent[] = [];
  const schedule = (
    t: number,
    type: EventType,
    e: SimEntity | null = null,
    st: StepState | null = null,
    p: PersonState | null = null,
    c: RosterClient | null = null,
    l: LinkState | null = null,
  ) => {
    const ev = pool.pop();
    if (ev) {
      ev.t = t;
      ev.type = type;
      ev.e = e;
      ev.st = st;
      ev.p = p;
      ev.c = c;
      ev.l = l;
      events.push(ev);
    } else {
      events.push({ t, type, e, st, p, c, l });
    }
  };

  const hpw = model.hoursPerWeek;
  /** A person's load is above their capacity, so they may work overtime (only with a cap above 0). */
  const overloaded = (p: PersonState) => overtimeCap > 0 && p.load > p.person.capacity;
  /** Add a person's load since `lastT` to the measured-window integrals. */
  const advance = (p: PersonState, t: number) => {
    const a = Math.max(p.lastT, 0);
    const b = Math.min(t, H);
    p.lastT = t;
    if (!(b > a)) return;
    const weeks = (b - a) / hpw;
    p.ongoingHours += p.load * weeks;
    const has = p.roleHas;
    for (let r = 0; r < has.length; r++) {
      if (has[r]) {
        p.roleOngoingHours[r]! += p.roleLoad[r]! * weeks;
        p.roleOngoingHas[r] = 1;
      }
    }
    p.clientWeeks += p.clients * weeks;
    if (overloaded(p)) {
      p.overWeeks += weeks;
      p.overOngoing += p.load * weeks;
    }
  };
  /** Pooled model: every person's share of `active` clients' ongoing hours, by role and capacity. */
  const setPooledLoads = (t: number) => {
    for (const p of people) {
      advance(p, t);
      p.roleLoad.fill(0);
      p.roleHas.fill(0);
      let hours = 0;
      for (const rid of p.person.roles) {
        const role = model.roles[rid];
        const cap = roleCapacity[rid];
        if (!role || !cap) continue;
        const h = (active * (role.ongoing || 0) * (p.person.capacity / p.person.roles.length)) / cap;
        hours += h;
        const r = roleIndex.get(rid)!;
        p.roleLoad[r]! += h;
        p.roleHas[r] = 1;
      }
      p.load = hours;
      p.fracDirty = true;
    }
  };
  /** Roster: a person's load from their active clients' contributions (summed afresh, so churn leaves no residue). */
  const setRosterLoad = (p: PersonState, t: number) => {
    advance(p, t);
    const roleLoad = p.roleLoad;
    const roleHas = p.roleHas;
    roleLoad.fill(0);
    roleHas.fill(0);
    let hours = 0;
    for (const parts of p.contrib.values()) {
      for (let i = 0; i < parts.length; i += 2) {
        const r = parts[i]!;
        const h = parts[i + 1]!;
        hours += h;
        roleLoad[r]! += h;
        roleHas[r] = 1;
      }
    }
    p.load = hours;
    p.fracDirty = true;
  };
  /**
   * Roster: a client added last to a person's contributions. The sums run in the contributions' order, so adding its
   * parts to the totals gives exactly what `setRosterLoad` would sum afresh, without going over every other client.
   */
  const addRosterLoad = (p: PersonState, parts: number[], t: number) => {
    advance(p, t);
    const roleLoad = p.roleLoad;
    let hours = p.load;
    for (let i = 0; i < parts.length; i += 2) {
      const r = parts[i]!;
      const h = parts[i + 1]!;
      hours += h;
      roleLoad[r]! += h;
      p.roleHas[r] = 1;
    }
    p.load = hours;
    p.fracDirty = true;
  };
  /**
   * Share of a working week this person has for pipeline work, recomputed
   * when their ongoing load changes. Load beyond capacity is first met by
   * overtime, extending capacity by up to the cap; beyond that the share is
   * clamped at the floor (docs/PRD.md §6.3.4). With no cap: capacity − load.
   */
  const availFrac = (p: PersonState) => {
    if (p.fracDirty) {
      const c = p.person.capacity;
      const capacity = overloaded(p) ? c + c * overtimeCap : c;
      p.frac = Math.max(floor, (capacity - p.load) / hpw);
      p.fracDirty = false;
    }
    return p.frac;
  };

  // The roster: each client's load goes to its assignee per role, or the role's pool.
  const personById = new Map(people.map((p) => [p.id, p]));
  const pools = roster ? rolePools(model, peopleModel) : {};
  const rosterClients: RosterClient[] = [];
  /** Roster clients, churned or not, for the per-client results. */
  const realClients: RosterClient[] = [];
  const allTouch: Touchpoints = { onTime: 0, late: 0, missed: 0 };
  /** Round-robin position per role, for clients won during the run. */
  const nextAssignee: Record<string, number> = {};
  let wonClients = 0;
  let churned = 0;
  // Churn drivers (churn-drivers.ts): who the churn is blamed on. Slot 0 is normal churn, then each driver in order.
  const drivers = resolveChurnDrivers(model);
  const nSlots = drivers.length + 1;
  const slotOf = (id: string) => drivers.findIndex((d) => d.id === id) + 1;
  const SLATE = slotOf("late");
  const SRESP = slotOf("resp");
  const SONB = slotOf("onb");
  const SREWORK = slotOf("rework");
  const SLOAD = slotOf("load");
  const SHAND = slotOf("handoff");
  const SRESULTS = slotOf("results");
  const STENURE = slotOf("tenure");
  const SPRICE = slotOf("price");
  const SMARKET = slotOf("market");
  const dw = new Float64Array(nSlots);
  const don = new Uint8Array(nSlots);
  drivers.forEach((d, i) => {
    dw[i + 1] = d.weight;
    don[i + 1] = d.enabled ? 1 : 0;
  });
  /** Measured value of the driver's cause, per slot, when the run has something to read. */
  const causeClients = new Float64Array(nSlots);
  const causeMrr = new Float64Array(nSlots);
  const pressSum = new Float64Array(nSlots);
  let pressN = 0;
  const causeByService = new Map<string, Float64Array>();
  /** This tick's pressure for the client in hand, per slot. */
  const ev = new Float64Array(nSlots);
  let respSum = 0;
  let respN = 0;
  let visitsAll = 0;
  let reworksAll = 0;
  let onbSum = 0;
  let onbN = 0;
  /** Normal first delivery for the onboarding driver, in hours (its entered target is in working days). */
  const onbNormalHours = (drivers[SONB - 1]!.value ?? 10) * (model.hoursPerWeek / 5);
  /** The market's churn factor, weighted by its driver (1 with no market or the driver off). Bit-for-bit the plain factor at weight 1. */
  const churnMarket = (t: number): number => {
    if (!market || !don[SMARKET]) return 1;
    const f = mkt(t).churn;
    return dw[SMARKET] === 1 ? f : 1 + dw[SMARKET]! * (f - 1);
  };
  /** Whether people's busy shares (`PersonState.util`) have been read at a weekly tick; and the busiest of the last tick. */
  let utilRead = false;
  /** Teams by their services and assignees, and the weekly tick's number (to read each team once a tick). */
  const teamOf = new Map<string, Team>();
  const NO_TEAM: Team = { people: [], util: 0, away: false, stamp: -1 };
  let tickNo = 0;
  let teamMark = 0;
  /** The switched-on drivers that add to a client's pressure (everything but the market), in slot order. */
  const addSlots: number[] = [];
  for (let s = 1; s < nSlots; s++) if (s !== SMARKET && don[s]) addSlots.push(s);
  /** Slots whose pressure can be above 0: all but the three that need servicing tasks when the model has none. */
  const liveSlots: number[] = [];
  for (let s = 1; s < nSlots; s++) if (servicing || (s !== SRESP && s !== SONB && s !== SREWORK)) liveSlots.push(s);
  let busiest = 0;
  let busiestPerson: string | null = null;
  const awayAt = (p: PersonState, t: number) => {
    if (p.leave) for (const [a, b] of p.leave) if (t >= a && t < b) return true;
    return false;
  };
  const serviceIndex = new Map(services.map((sv, i) => [sv.id, i]));
  /** Roles that work each servicing process's steps, in id order. */
  const processRoles = new Map<string, string[]>();
  for (const [pid, proc] of Object.entries(processes)) {
    const ids = new Set(proc.steps);
    processRoles.set(pid, [...new Set(model.steps.filter((s) => ids.has(s.id) && s.role).map((s) => s.role!))].sort());
  }
  /** The team that looks after a client (see `Team`). */
  const teamFor = (
    client: { services: string[]; assignments: Record<string, string> },
    rc: { assigned: PersonState[]; carriers: [PersonState, string, number][] },
  ): Team => {
    // Who looks after it (for the churn drivers): its carriers and assignees, and the people of the roles that work its servicing
    // processes. Clients with the same services and assignees have the same team, so it is worked out once for them.
    // (With nobody assigned in the model, the team is the roles' pools and the client's services alone say which.)
    let teamKey = client.services.length === 1 ? client.services[0]! : client.services.join(",");
    if (rc.assigned.length > 0) {
      // (Assignees in the order they were given: another order only means another cache entry.)
      for (const rid in client.assignments) teamKey += `|${rid}=${client.assignments[rid]}`;
    }
    let shared = teamOf.get(teamKey);
    if (!shared) {
      // Each person once, in the order met (a mark on the person says they are in already).
      const mark = ++teamMark;
      const people: PersonState[] = [];
      const add = (p: PersonState) => {
        if (p.teamMark !== mark) {
          p.teamMark = mark;
          people.push(p);
        }
      };
      for (const p of rc.assigned) add(p);
      for (let i = 0; i < rc.carriers.length; i++) add(rc.carriers[i]![0]);
      for (const sid of client.services) {
        const svc = serviceIndex.get(sid);
        if (svc === undefined) continue;
        for (const link of linksBySvc[svc]!) {
          for (const rid of processRoles.get(link.process) ?? []) {
            for (const c of pools[rid] ?? []) {
              const p = personById.get(c.person);
              if (p) add(p);
            }
          }
        }
      }
      shared = { people, util: 0, away: false, stamp: -1 };
      teamOf.set(teamKey, shared);
    }
    return shared;
  };
  /** Client shapes by their services and assignees (see `ClientShape`). */
  const shapes = new Map<string, ClientShape>();
  const shapeFor = (client: { services: string[]; assignments: Record<string, string> }): ClientShape => {
    let key = client.services.length === 1 ? client.services[0]! : client.services.join("\u0000");
    for (const rid in client.assignments) key += `\u0001${rid}\u0002${client.assignments[rid]}`;
    let shape = shapes.get(key);
    if (shape) return shape;
    const carriers: [PersonState, string, number][] = [];
    const loads = clientRoleLoads(model, client);
    for (const rid in loads) {
      for (const c of carriersFor(pools, peopleModel, rid, client.assignments[rid])) {
        carriers.push([personById.get(c.person)!, rid, loads[rid]! * c.share]);
      }
    }
    const assigned: PersonState[] = [];
    for (const pid of new Set(Object.values(client.assignments))) {
      const p = personById.get(pid);
      if (p) assigned.push(p);
    }
    const assignees = new Map<string, PersonState>();
    if (servicing) {
      for (const [rid, pid] of Object.entries(client.assignments)) {
        const p = personById.get(pid);
        if (p) assignees.set(rid, p);
      }
    }
    const touched: PersonState[] = [];
    const parts: number[][] = [];
    for (const [p, rid, hours] of carriers) {
      let i = touched.indexOf(p);
      if (i < 0) {
        i = touched.push(p) - 1;
        parts.push([]);
      }
      parts[i]!.push(roleIndex.get(rid)!, hours);
    }
    shape = {
      churnBase: clientChurnMonthly(model, client),
      sensitivity: clientChurnSensitivity(model, client),
      carriers,
      assigned,
      assignees,
      svcKey: client.services[0] ?? "",
      serviced: client.services.some((sid) => (linksBySvc[serviceIndex.get(sid) ?? -1]?.length ?? 0) > 0),
      team: NO_TEAM,
      touched,
      parts,
    };
    shape.team = teamFor(client, shape);
    shapes.set(key, shape);
    return shape;
  };
  const addClient = (
    key: string,
    client: { services: string[]; assignments: Record<string, string>; health?: number; mrr?: number },
    t: number,
    isRoster: boolean,
    weeklyBill: number,
  ) => {
    const shape = shapeFor(client);
    const rc: RosterClient = {
      key,
      roster: isRoster,
      churnBase: shape.churnBase,
      sensitivity: shape.sensitivity,
      rng: streams.get(isRoster ? labels.join("churn", "client", key) : labels.join("churn", key)),
      carriers: shape.carriers,
      assigned: shape.assigned,
      assignees: shape.assignees,
      active: true,
      health: client.health !== undefined && Number.isFinite(client.health) ? clampHealth(client.health) : rules.initial,
      touch: { onTime: 0, late: 0, missed: 0 },
      trajectory: null,
      churned: false,
      weeklyBill,
      since: t,
      open: [],
      openHead: 0,
      svcKey: shape.svcKey,
      team: shape.team,
      adhocN: 0,
      adhocBad: 0,
      visits: 0,
      reworks: 0,
      firstDone: -1,
      extraA: 0,
      lastB: 1,
      causeRow: null,
      serviced: shape.serviced,
      shape,
    };
    if (isRoster) {
      rc.trajectory = [rc.health];
      realClients.push(rc);
    }
    if (servicing) {
      for (const sid of client.services) {
        const svc = serviceIndex.get(sid);
        if (svc === undefined) continue;
        for (const link of linksBySvc[svc]!) {
          const interval = recurrenceInterval(link.recurrence, hpw);
          const l: LinkState = {
            link,
            entry: targetFor(processes[link.process]!.entry),
            svc,
            interval,
            gap: interval ?? poissonMeanGap(link.recurrence, hpw),
            rng: streams.get(labels.join("servicing", key, sid, link.process)),
          };
          // The first task falls at a random point in the first interval, so clients' tasks don't all land at once.
          scheduleTask(rc, l, t + (interval !== null ? l.rng() * interval : expo(l.rng, l.gap)));
        }
      }
    }
    // Each carrier's parts (shared with alike clients, never changed): a new client goes last in their contributions.
    const { touched, parts } = shape;
    for (let i = 0; i < touched.length; i++) touched[i]!.contrib.set(rc, parts[i]!);
    for (const p of rc.assigned) {
      advance(p, t);
      p.clients++;
    }
    for (let i = 0; i < touched.length; i++) addRosterLoad(touched[i]!, parts[i]!, t);
    rosterClients.push(rc);
    active = rosterClients.length;
  };
  /** Bill a client's weeks active since it was last billed, within the measured window. */
  const bill = (rc: RosterClient, t: number) => {
    const from = Math.max(rc.since, 0);
    const to = Math.min(t, H);
    if (to > from) billed += (rc.weeklyBill * (to - from)) / hpw;
    rc.since = t;
  };
  const removeClient = (rc: RosterClient, t: number) => {
    rc.active = false;
    bill(rc, t);
    for (const p of rc.assigned) {
      advance(p, t);
      p.clients--;
    }
    for (const p of rc.shape.touched) {
      p.contrib.delete(rc);
      setRosterLoad(p, t);
    }
  };
  /** A retainer won during the run: a synthetic client, assigned per role by round-robin among the role's members. */
  const addWonClient = (svc: ServiceState, t: number) => {
    const services = svc.id !== null ? [svc.id] : [];
    const assignments: Record<string, string> = {};
    // Roles with client load, then (with servicing) the roles its servicing processes need.
    const roles = Object.keys(clientRoleLoads(model, { services }));
    for (const link of linksBySvc[serviceIndex.get(svc.id)!] ?? []) {
      for (const rid of processRoles.get(link.process) ?? []) if (!roles.includes(rid)) roles.push(rid);
    }
    for (const rid of roles) {
      const pool = pools[rid] ?? [];
      if (!pool.length) continue;
      const i = nextAssignee[rid] ?? 0;
      assignments[rid] = pool[i % pool.length]!.person;
      nextAssignee[rid] = i + 1;
    }
    const weeklyBill = svc.s.pricingModel === "retainer" ? (svc.s.price * (market ? mkt(t).price : 1)) / WEEKS_PER_MONTH : 0;
    addClient(`won:${++wonClients}`, { services, assignments }, t, false, weeklyBill);
  };
  /** The run of alike clients being added up (see `churnTick`): its pressure, chance of leaving and how many there are. */
  let runK = 0;
  let runMarketPart = 0;
  let runMrr = 0;
  let runRow: Float64Array | null = null;
  let runExtra = 0;
  let runCount = 0;
  let runWeekly = 0;
  let runClient: RosterClient | null = null;
  /** Add the run's clients to the blame accounting: `runCount` times what one of them adds (the pressure in `ev` is theirs). */
  const flushRun = () => {
    const n = runCount;
    if (n === 0) return;
    const row = runRow!;
    const k = runK * n;
    causeClients[0]! += k;
    causeMrr[0]! += k * runMrr;
    row[0]! += k;
    pressN += n;
    // Slots that can't be anything but 0 add nothing, so they are left out.
    for (let i = 0; i < liveSlots.length; i++) pressSum[liveSlots[i]!]! += ev[liveSlots[i]!]! * n;
    // Only the drivers switched on take a share (the market's is the stretch it puts on the whole).
    for (let i = 0; i < addSlots.length; i++) {
      const s = addSlots[i]!;
      const part = dw[s]! * ev[s]!;
      if (part > 0) {
        causeClients[s]! += k * part;
        causeMrr[s]! += k * part * runMrr;
        row[s]! += k * part;
      }
    }
    if (runMarketPart > 0) {
      causeClients[SMARKET]! += k * runMarketPart;
      causeMrr[SMARKET]! += k * runMarketPart * runMrr;
      row[SMARKET]! += k * runMarketPart;
    }
    runCount = 0;
  };
  /** One client's week of churn drivers: its pressures, its chance of leaving (returned) and who that is blamed on. Kept apart from `churnTick` so the hot closures stay small. */
  const driveClient = (rc: RosterClient, t: number, multiplier: number, handoffRate: number, tenureExtra: number): number => {
    // The pressure each driver puts on this client: 0 when nothing is wrong, 1 doubles its churn at weight 1.
    ev[SLATE] = rc.sensitivity * ((100 - rc.health) / 100);
    // Without servicing processes there are no tasks, so these three stay 0 and aren't looked at.
    if (servicing) ev[SRESP] = rc.adhocN > 0 ? responsePressure(rc.adhocBad / rc.adhocN) : 0;
    let early = 0;
    let delay = 0;
    if (!rc.roster) {
      const age = t - rc.since;
      if (age <= EARLY_TENURE_WEEKS * hpw) early = 1;
      delay = (rc.firstDone >= 0 ? rc.firstDone : t) - rc.since;
    }
    if (servicing) ev[SONB] = early && rc.serviced ? onboardingPressure(delay, onbNormalHours) : 0;
    ev[STENURE] = early ? tenureExtra : 0;
    if (servicing) ev[SREWORK] = rc.visits > 0 ? reworkPressure(rc.reworks / rc.visits) : 0;
    const team = rc.team;
    if (team.stamp !== tickNo) {
      team.stamp = tickNo;
      team.util = 0;
      team.away = false;
      for (const p of team.people) {
        const u = p.util;
        if (u > team.util) team.util = u;
        if (!team.away && awayAt(p, t)) team.away = true;
      }
    }
    ev[SLOAD] = loadPressure(team.util);
    ev[SHAND] = handoffRate + (team.away ? AWAY_PRESSURE : 0);
    // The chance of leaving: base × (1 + the drivers' pressure at their weights) × the market.
    let a = 1;
    let extra = 0;
    for (let i = 0; i < addSlots.length; i++) {
      const s = addSlots[i]!;
      const term = dw[s]! * ev[s]!;
      a += term;
      if (s !== SLATE) extra += term;
    }
    // Not clamped: a monthly rate above 1 means certain churn at the first tick.
    const weekly = (rc.churnBase * a * multiplier) / WEEKS_PER_MONTH;
    rc.extraA = extra;
    rc.lastB = multiplier;
    // Who this week's chance of leaving is blamed on is added up by `flushRun`, once for each run of clients that are alike.
    const marketPart = don[SMARKET] && multiplier > 1 ? a * (multiplier - 1) : 0;
    const hazard = weekly < 1 ? (weekly > 0 ? weekly : 0) : 1;
    runK = hazard / (a + marketPart);
    runMarketPart = marketPart;
    runMrr = rc.weeklyBill * WEEKS_PER_MONTH;
    let row: Float64Array | null | undefined = rc.causeRow;
    if (!row) {
      row = causeByService.get(rc.svcKey);
      if (!row) causeByService.set(rc.svcKey, (row = new Float64Array(nSlots)));
      rc.causeRow = row;
    }
    runRow = row;
    runExtra = extra;
    runCount = 1;
    runWeekly = weekly;
    return weekly;
  };
  /**
   * Weekly churn tick: pooled clients decay; roster clients each churn with
   * their weekly probability, which rises as their health falls (docs/PRD.md
   * §6.3.5). Roster clients' health is recorded first, for the trajectory.
   */
  const churnTick = (t: number) => {
    if (!roster) {
      active = Math.max(0, active - active * ((model.churnMonthly * churnMarket(t)) / WEEKS_PER_MONTH));
      setPooledLoads(t);
      return;
    }
    // Tasks whose deadline passed before this tick count as missed first (one at the tick itself comes after it).
    if (servicing) for (const rc of rosterClients) settleMisses(rc, t, false);
    const staying: RosterClient[] = [];
    // The market's churn factor this week, and the weighted multiplier it gives the whole chance of leaving.
    const marketF = market ? mkt(t).churn : 1;
    const multiplier = churnMarket(t);
    // How busy each person has been so far (for the team-overload driver): read, not advanced, so the run's sums are untouched.
    const weeksSoFar = t / hpw;
    tickNo++;
    busiest = 0;
    busiestPerson = null;
    for (const p of people) {
      const pending = (p.load * Math.max(0, Math.min(t, H) - Math.max(p.lastT, 0))) / hpw;
      // A job in progress is booked in full when it starts (`startService`): leave out the part not yet done, as the reset at time 0 does.
      const cur = p.cur;
      const unfinished = p.busy && cur && cur.end > t && cur.end > cur.start ? (cur.handsOn * (cur.end - t)) / (cur.end - cur.start) : 0;
      const capacity = p.person.capacity * weeksSoFar;
      const u = capacity > 0 ? Math.max(0, p.busyHours + p.svcHours + p.ongoingHours + pending - unfinished) / capacity : 0;
      p.util = u;
      utilRead = true;
      if (u > busiest) {
        busiest = u;
        busiestPerson = p.id;
      }
    }
    // Constant pressures this week: entered numbers, and a planned price rise in the weeks after it takes effect.
    ev[SRESULTS] = resultsPressure(drivers[SRESULTS - 1]!.value ?? 8);
    const priceFrom = (drivers[SPRICE - 1]!.month - 1) * (52 / 12) * hpw;
    ev[SPRICE] = t >= priceFrom && t < priceFrom + PRICE_WEIGHT_WEEKS * hpw ? pricePressure(drivers[SPRICE - 1]!.value ?? 0) : 0;
    const handoffRate = Math.min(1, drivers[SHAND - 1]!.value ?? 0);
    const tenureExtra = Math.max(0, (drivers[STENURE - 1]!.value ?? 1) - 1);
    for (let s = SMARKET + 1; s < nSlots; s++) ev[s] = (drivers[s - 1]!.value ?? 0) / 100;
    ev[SMARKET] = marketF - 1;
    for (const rc of rosterClients) {
      rc.trajectory?.push(rc.health);
      // Without servicing, counted clients of one service with the same health, team and fee are alike: worked out once, added up n times.
      // (Clients that differ, and every client of a model with servicing, are a run of one, added exactly as before.)
      const prev = runClient;
      let weekly: number;
      if (
        !servicing &&
        prev !== null &&
        runCount > 0 &&
        rc.roster &&
        prev.roster &&
        rc.health === prev.health &&
        rc.team === prev.team &&
        rc.svcKey === prev.svcKey &&
        rc.churnBase === prev.churnBase &&
        rc.sensitivity === prev.sensitivity &&
        rc.weeklyBill === prev.weeklyBill
      ) {
        runCount++;
        weekly = runWeekly;
        rc.extraA = runExtra;
        rc.lastB = multiplier;
        rc.causeRow = runRow;
      } else {
        flushRun();
        weekly = driveClient(rc, t, multiplier, handoffRate, tenureExtra);
        runClient = rc;
      }
      if (rc.rng() < weekly) {
        removeClient(rc, t);
        rc.churned = true;
        churned++;
      } else {
        staying.push(rc);
      }
    }
    flushRun();
    runClient = null;
    rosterClients.length = 0;
    rosterClients.push(...staying);
    active = staying.length;
  };
  if (roster) {
    for (const cid of Object.keys(model.clients!)) {
      const client = model.clients![cid]!;
      addClient(cid, client, -W, true, (Number(client.mrr) || 0) / WEEKS_PER_MONTH);
    }
  } else {
    setPooledLoads(-W);
  }
  const onLeave = (p: PersonState, t: number) => {
    if (!p.leave) return false;
    for (const [a, b] of p.leave) if (t >= a && t < b) return true;
    return false;
  };

  /** Start of the measured window's second half, for queue growth. */
  const half = H / 2;
  /** Add the queue area since the last change, and the part of it in the second half. */
  const addArea = (st: StepStat, t: number) => {
    st.qArea += st.qLen * (t - st.qLast);
    if (t > half) st.qAreaLate += st.qLen * (t - Math.max(st.qLast, half));
  };
  const setQ = (st: StepStat, t: number, delta: number) => {
    addArea(st, t);
    st.qLast = t;
    st.qLen += delta;
    if (st.qLen > st.qMax) st.qMax = st.qLen;
  };

  function enter(e: SimEntity, sid: string, t: number) {
    enterTarget(e, targetFor(sid), t);
  }

  function enterTarget(e: SimEntity, target: Target, t: number) {
    const st = target.st;
    if (st) {
      st.stat.arrivals++;
      queueAt(e, st, t, t);
      return;
    }
    const end = target.end;
    if (!end) throw new Error(`Edge to unknown step '${target.id}'`);
    if (e.task) {
      // A servicing task ends at its process's end, whatever the end's outcome: it books nothing.
      e.done = t;
      finishTask(e.task, t, e.t0);
      return;
    }
    if (!end.handoff) e.done = t;
    reachEnd(e, end.outcome, t);
    if (end.handoff) enter(e, end.handoff, t);
  }

  /** Schedule a client's next servicing task, if it falls within the run. */
  function scheduleTask(c: RosterClient, l: LinkState, t: number) {
    if (t <= H) schedule(t, "task", null, null, null, c, l);
  }

  /** A client's servicing task is due: it enters its process, and the next one is scheduled. Churned clients generate none. */
  function createTask(c: RosterClient, l: LinkState, t: number) {
    if (!c.active) return;
    scheduleTask(c, l, t + (l.interval ?? expo(l.rng, l.gap)));
    const sla = l.link.sla;
    const task: Task = { client: c, due: t + sla, deadline: t + 2 * sla, state: "open", adhoc: l.interval === null };
    const e: SimEntity = { id: eid++, t0: t, trace: NO_TRACE, seg: null, svc: l.svc, task, lp: null, lv: null };
    if (keepTrace) {
      e.trace = [];
      e.servicing = { process: l.link.process, client: c.key };
      entities.push(e);
    }
    // A deadline after the horizon can't be missed within the run.
    if (task.deadline <= H) {
      const open = c.open;
      let i = open.length;
      while (i > c.openHead && open[i - 1]!.deadline > task.deadline) i--;
      if (i === open.length) open.push(task);
      else open.splice(i, 0, task);
    }
    enterTarget(e, l.entry, t);
  }

  /**
   * Mark a client's open tasks missed whose deadline has come by `t`
   * (`inclusive`) or before it, oldest deadline first, each at its deadline:
   * exactly what an event at each deadline would do, but only when the
   * client's health is next read (a completion, a weekly tick, the horizon).
   */
  function settleMisses(c: RosterClient, t: number, inclusive: boolean) {
    const open = c.open;
    let n = c.openHead;
    while (n < open.length) {
      const task = open[n]!;
      if (inclusive ? task.deadline > t : task.deadline >= t) break;
      n++;
      if (task.state === "open") {
        task.state = "missed";
        touchpoint(c, "missed", task.deadline, task.adhoc);
      }
    }
    // Drop the settled ones once they are all settled, or are most of the list.
    if (n === open.length) {
      open.length = 0;
      n = 0;
    } else if (n >= 32 && 2 * n >= open.length) {
      open.splice(0, n);
      n = 0;
    }
    c.openHead = n;
  }

  /** A task reached its process's end: on time or late, unless it was already missed. */
  function finishTask(task: Task, t: number, t0: number) {
    const c = task.client;
    // Any of the client's deadlines up to now pass first, this task's included.
    settleMisses(c, t, true);
    const open = task.state === "open";
    task.state = "done";
    if (open) touchpoint(c, t <= task.due ? "onTime" : "late", t, task.adhoc);
    // The churn drivers' measures: how long an ad-hoc request took, and how long a client won in the run waited for its first delivery.
    if (t >= 0 && task.adhoc) {
      respSum += t - t0;
      respN++;
    }
    if (c.firstDone < 0 && c.active) {
      c.firstDone = t;
      if (t >= 0 && !c.roster) {
        onbSum += t - c.since;
        onbN++;
      }
    }
  }

  /**
   * A touchpoint moves the client's health (docs/PRD.md §6.3.5): on time
   * +recover (up to 100), late −late penalty, missed −missed penalty (down to
   * 0). Only in the measured window, and only while the client is active.
   */
  function touchpoint(c: RosterClient, kind: keyof Touchpoints, t: number, adhoc: boolean) {
    if (t < 0 || !c.active) return;
    if (adhoc) {
      c.adhocN++;
      if (kind !== "onTime") c.adhocBad++;
    }
    c.touch[kind]++;
    allTouch[kind]++;
    const delta = kind === "onTime" ? rules.recover : kind === "late" ? -rules.latePenalty : -rules.missedPenalty;
    c.health = clampHealth(c.health + delta);
  }

  /**
   * Record an outcome. A win sticks and is booked once, at the first `won`
   * end, priced by the entity's service (docs/PRD.md §6.4 revenue rules): a
   * won entity handed on to a downstream process books nothing more, and
   * isn't counted as lost or done if it ends there.
   */
  function reachEnd(e: SimEntity, outcome: Outcome, t: number) {
    if (e.outcome === "won" || e.outcome === outcome) return;
    e.outcome = outcome;
    // The warm-up runs at the starting client count; its outcomes are discarded.
    if (t < 0) return;
    const sv = services[e.svc]!;
    if (outcome === "won") {
      won++;
      sv.counts.won++;
      sv.wonUnits += market ? mkt(t).price : 1;
      cycle.push(t - e.t0);
      // A one-off job doesn't become an ongoing client.
      if (sv.s.pricingModel !== "one_off") {
        if (roster) {
          addWonClient(sv, t);
        } else {
          active += 1;
          setPooledLoads(t);
        }
      }
      // With a roster, the new client bills week by week until it churns (see `bill`).
      if (sv.s.pricingModel === "retainer" && !roster) {
        billed += ((sv.s.price * (market ? mkt(t).price : 1)) / WEEKS_PER_MONTH) * weeksBilled(t, sv.s.churnMonthly * churnMarket(t));
      } else if (sv.s.pricingModel === "one_off") {
        billed += sv.s.price * (market ? mkt(t).price : 1);
      }
    } else if (outcome === "lost") {
      lost++;
      sv.counts.lost++;
    } else {
      done++;
      cycle.push(t - e.t0);
    }
  }

  /**
   * Expected weeks a client won at `t` is billed before the horizon: its
   * survival steps down at each weekly churn tick by the same factor the
   * engine applies to active clients.
   */
  function weeksBilled(t: number, churnMonthly: number): number {
    const hpw = model.hoursPerWeek;
    const first = (Math.floor(t / hpw) + 1) * hpw;
    if (first >= H) return (H - t) / hpw;
    // Ticks at `first`, a week later, ..., `last`: the n - 1 whole weeks
    // between them bill keep^1..keep^(n-1), the stub after `last` keep^n.
    const last = Math.ceil(H / hpw - 1) * hpw;
    const n = Math.round((last - first) / hpw) + 1;
    const keep = Math.max(0, 1 - churnMonthly / WEEKS_PER_MONTH);
    const keepN = powInt(keep, n);
    const whole = keep === 1 ? n - 1 : (keep - keepN) / (1 - keep);
    return (first - t) / hpw + whole + (keepN * (H - last)) / hpw;
  }

  /** Put an entity at a step (queued since `tQ`); the longest-idle eligible free person takes it. */
  function queueAt(e: SimEntity, st: StepState, tQ: number, t: number) {
    // Without a trace, an entity's one segment is reused from visit to visit.
    let seg = e.seg;
    if (keepTrace || !seg) {
      seg = { step: st.s.id, person: null, tQ, tS: null, tE: null, tL: null };
      if (keepTrace) e.trace.push(seg);
      e.seg = seg;
    } else {
      seg.step = st.s.id;
      seg.person = null;
      seg.tQ = tQ;
      seg.tS = null;
      seg.tE = null;
      seg.tL = null;
    }
    const lps = st.loops;
    if (lps.length) {
      // An item reaching any step of a loop's region is inside it, wherever it joined (and whenever: warm-up entrants count when they leave).
      let f = e.lp;
      if (!f) {
        f = e.lp = new Uint8Array(nLoops);
        e.lv = new Float64Array(2 * nLoops);
      }
      for (let i = 0; i < lps.length; i++) f[lps[i]!.idx]! |= LP_INSIDE;
    }
    if (!st.staffed) {
      startService(e, st, null, t);
      return;
    }
    setQ(st.stat, t, 1);
    // A servicing task whose client has an assigned person for the step's
    // role, who can do the step, queues for them only (docs/PRD.md §6.3.3).
    const assignee = st.assigned && e.task && !st.s.person && st.s.role ? e.task.client.assignees.get(st.s.role) : undefined;
    if (assignee && assignee.steps.includes(st)) {
      const assigned = st.assigned!;
      let k = assigned.people.indexOf(assignee);
      if (k < 0) {
        k = assigned.people.push(assignee) - 1;
        assigned.lists.push(new Fifo());
      }
      assigned.lists[k]!.push(e);
      assigned.waiting++;
      // While they are on leave, it falls back to the role's pool.
      if (!onLeave(assignee, t)) {
        takeNext(assignee, t);
        return;
      }
    } else {
      st.queue.push(e);
    }
    let pick: PersonState | null = null;
    for (const p of st.people) {
      if (!p.busy && !onLeave(p, t) && (!pick || p.freeSince < pick.freeSince)) pick = p;
    }
    if (pick) takeNext(pick, t);
  }

  /**
   * A free person takes the oldest waiting item across the steps they can do
   * (FIFO across steps): shared queues, tasks assigned to them, and tasks
   * assigned to someone who is on leave.
   */
  function takeNext(p: PersonState, t: number) {
    if (p.busy || onLeave(p, t)) return;
    let best: SimEntity | null = null;
    let bestTQ = 0;
    let bestStep: StepState | null = null;
    let bestList: Fifo | null = null;
    const steps = p.steps;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i]!;
      const c = st.queue.peek();
      if (c && (!best || c.seg!.tQ < bestTQ)) {
        best = c;
        bestTQ = c.seg!.tQ;
        bestStep = st;
        bestList = st.queue;
      }
      const assigned = st.assigned;
      if (!assigned || !assigned.waiting) continue;
      for (let k = 0; k < assigned.people.length; k++) {
        const list = assigned.lists[k]!;
        const a = list.peek();
        if (!a) continue;
        const q = assigned.people[k]!;
        if (q !== p && !onLeave(q, t)) continue;
        if (!best || a.seg!.tQ < bestTQ) {
          best = a;
          bestTQ = a.seg!.tQ;
          bestStep = st;
          bestList = list;
        }
      }
    }
    if (!best || !bestStep || !bestList) return;
    bestList.shift();
    if (bestList !== bestStep.queue) bestStep.assigned!.waiting--;
    const stat = bestStep.stat;
    setQ(stat, t, -1);
    stat.waitSum += t - best.seg!.tQ;
    stat.waitN++;
    startService(best, bestStep, p, t);
  }

  function startService(e: SimEntity, st: StepState, p: PersonState | null, t: number) {
    e.seg!.tS = t;
    e.seg!.person = p?.id ?? null;
    let dur = 0;
    if (p) {
      p.busy = true;
      const frac = availFrac(p);
      const handsOn = st.work();
      dur = handsOn / frac;
      st.stat.handsOnSum += handsOn;
      st.stat.handsOnN++;
      st.stat.stretchSum += dur - handsOn;
      if (st.loops.length && e.lp && t >= 0) {
        const L = repeatLoop(st.loops, e.lp);
        if (L) {
          const role = st.s.role ?? p.person.roles[0] ?? "unassigned";
          L.roleHours.set(role, (L.roleHours.get(role) ?? 0) + handsOn);
          reworkRoles.set(role, (reworkRoles.get(role) ?? 0) + handsOn);
        }
      }
      const svc = e.task !== undefined;
      if (svc) p.svcHours += handsOn;
      else p.busyHours += handsOn;
      const over = overloaded(p);
      if (over) p.overPipeline += handsOn;
      const acc = st.acc;
      if (acc) {
        if (svc) acc.svc += handsOn;
        else acc.busy += handsOn;
      }
      const cur = p.cur;
      if (cur) {
        cur.start = t;
        cur.end = t + dur;
        cur.handsOn = handsOn;
        cur.acc = acc;
        cur.over = over;
        cur.svc = svc;
      } else {
        p.cur = { start: t, end: t + dur, handsOn, acc, over, svc };
      }
    }
    schedule(t + dur, "end", e, st, p);
  }

  function endService(e: SimEntity, st: StepState, p: PersonState | null, t: number) {
    e.seg!.tE = t;
    if (p) {
      p.busy = false;
      p.freeSince = t;
      p.completed++;
    }
    let w = st.wait ? st.wait() : 0;
    // "Time to decide": the market stretches or shortens external waits before the sale, not onboarding, delivery or servicing.
    if (market && w > 0 && st.beforeSale && !st.assigned) w *= mkt(t).cycle;
    st.stat.fixedWaitSum += w;
    st.stat.fixedWaitN++;
    // With no wait and nothing else pending at `t`, its leave event would be
    // the very next one handled (whatever `takeNext` schedules comes after
    // it), so it's handled here instead, in exactly that order.
    if (w === 0 && events.minTime() > t) {
      if (p) takeNext(p, t);
      leave(e, st, t);
      return;
    }
    schedule(t + w, "leave", e, st);
    if (p) takeNext(p, t);
  }

  function leave(e: SimEntity, st: StepState, t: number) {
    e.seg!.tL = t;
    const s = st.s;
    st.stat.departures++;
    if (s.sla !== undefined && t - e.seg!.tQ > s.sla) st.stat.slaBreaches++;
    const redo = Boolean(s.rework && st.rework() < s.rework);
    const lps = st.loops;
    const lp = lps.length ? e.lp : null;
    if (lp) {
      // Time at a step on a repeat pass is what the loop adds to the item's cycle time (in the innermost loop it is on).
      const L = repeatLoop(lps, lp);
      if (L) {
        e.lv![2 * L.idx + 1]! += t - e.seg!.tQ;
        if (t >= 0) reworkElapsed += t - Math.max(0, e.seg!.tQ);
      }
    }
    if (e.task && t >= 0) {
      e.task.client.visits++;
      visitsAll++;
      if (redo) {
        e.task.client.reworks++;
        reworksAll++;
      }
    }
    if (redo) {
      st.stat.reworks++;
      st.stat.arrivals++;
      if (lp) {
        for (let i = 0; i < lps.length; i++) {
          const L = lps[i]!;
          if (L.redo && L.def.from === s.id) goRound(e, L);
        }
      }
      queueAt(e, st, t, t);
      return;
    }
    let u = st.route();
    let next = s.next;
    let targets = st.targets;
    if (st.routes) {
      const r = st.routes[e.svc]!;
      next = r.next;
      targets = r.targets;
      u *= r.total;
    }
    let acc = 0;
    let k = next.length - 1;
    const conv = market ? mkt(t).conv : 1;
    const winEdges = st.routes ? st.routes[e.svc]!.winEdges : st.winEdges;
    if (conv !== 1 && winEdges) {
      k = pickWithSigning(next, winEdges, u, conv);
    } else {
      for (let i = 0; i < next.length; i++) {
        acc += next[i]!.p;
        if (u < acc) {
          k = i;
          break;
        }
      }
    }
    const target = targets[k]!;
    if (lp) {
      for (let i = 0; i < lps.length; i++) {
        const L = lps[i]!;
        if (!L.redo && L.def.from === s.id && L.def.to === target.id) goRound(e, L);
        else if (L.redo || !L.body.has(target.id)) leaveLoop(e, L, t);
      }
    }
    // A visit sent straight to a lost end is work lost at this step (rule 12).
    if (target.end && target.end.outcome === "lost" && !e.task && e.outcome !== "won" && t >= 0) st.stat.lostHere++;
    enterTarget(e, target, t);
  }

  /** The innermost loop the item is on a repeat pass of, among a step's loops (sorted innermost first). */
  function repeatLoop(lps: LoopRun[], lp: Uint8Array): LoopRun | null {
    for (let i = 0; i < lps.length; i++) if (lp[lps[i]!.idx]! & LP_WENT) return lps[i]!;
    return null;
  }

  /** An item goes round a loop once more: it is on a repeat pass until it leaves the loop. */
  function goRound(e: SimEntity, L: LoopRun) {
    e.lp![L.idx]! |= LP_WENT;
    e.lv![2 * L.idx]!++;
  }

  /**
   * An item leaves a loop's region: its stay is settled, if that happens in the
   * measured window (so the share is of items that finished in it, whenever
   * they came in), and the loop forgets it, so a later stay counts afresh.
   */
  function leaveLoop(e: SimEntity, L: LoopRun, t: number) {
    const f = e.lp!;
    const v = e.lv!;
    if (!(f[L.idx]! & LP_INSIDE)) return;
    if (t >= 0) {
      L.entered++;
      if (f[L.idx]! & LP_WENT) {
        L.went++;
        L.rounds += v[2 * L.idx]!;
        L.extraElapsed += v[2 * L.idx + 1]!;
      }
    }
    f[L.idx] = 0;
    v[2 * L.idx] = 0;
    v[2 * L.idx + 1] = 0;
  }

  /**
   * End of the warm-up: discard everything measured so far. Work in progress
   * carries over; hands-on time of a service in progress is split pro rata.
   */
  function startMeasuring() {
    won = 0;
    lost = 0;
    done = 0;
    billed = 0;
    for (const sv of services) {
      sv.counts = { arrivals: 0, won: 0, lost: 0 };
      sv.wonUnits = 0;
    }
    cycle.length = 0;
    // Nothing is won or churns during the warm-up, so the clients are as they started.
    churned = 0;
    for (const { stat } of stepList) {
      Object.assign(stat, {
        arrivals: 0,
        qArea: 0,
        qLast: 0,
        qMax: stat.qLen,
        waitSum: 0,
        waitN: 0,
        reworks: 0,
        qAreaLate: 0,
        departures: 0,
        slaBreaches: 0,
        lostHere: 0,
        stretchSum: 0,
        handsOnSum: 0,
        handsOnN: 0,
        fixedWaitSum: 0,
        fixedWaitN: 0,
      });
    }
    for (const L of loopRuns) {
      L.entered = 0;
      L.went = 0;
      L.rounds = 0;
      L.extraElapsed = 0;
      L.roleHours.clear();
    }
    reworkRoles.clear();
    reworkElapsed = 0;
    for (const rid in roleAcc) {
      roleAcc[rid]!.busy = 0;
      roleAcc[rid]!.svc = 0;
    }
    for (const p of people) {
      p.busyHours = 0;
      p.svcHours = 0;
      p.completed = 0;
      p.overPipeline = 0;
      const c = p.cur;
      if (!p.busy || !c || c.end <= 0 || c.end <= c.start) continue;
      const share = (c.handsOn * c.end) / (c.end - c.start);
      if (c.svc) p.svcHours += share;
      else p.busyHours += share;
      if (c.over) p.overPipeline += share;
      if (c.acc) {
        if (c.svc) c.acc.svc += share;
        else c.acc.busy += share;
      }
    }
    entities = entities.filter((e) => e.done === undefined);
  }

  /**
   * Starting WIP: each item queued at its step with an age drawn uniformly
   * over the step's expected wait (its mean wait, or its work time for steps
   * with none). Oldest first, so they are served before anything newer.
   */
  function seedWip() {
    const mix = streams.get("mix:wip");
    const items: { st: StepState; tQ: number }[] = [];
    for (const st of stepList) {
      // Servicing steps' work comes from clients' tasks, not from the pipeline's WIP.
      if (servicingSteps.has(st.s.id)) continue;
      const rng = streams.get(`wip:${st.s.id}`);
      const span = st.s.wait > 0 ? st.s.wait : st.s.work;
      for (let i = 0; i < wipCount(st.s); i++) items.push({ st, tQ: 0 - rng() * span });
    }
    items.sort((a, b) => a.tQ - b.tQ);
    for (const { st, tQ } of items) {
      const e: SimEntity = { id: eid++, t0: tQ, trace: [], seg: null, svc: drawService(mix), lp: null, lv: null };
      entities.push(e);
      queueAt(e, st, tQ, 0);
    }
  }

  // Arrivals: Poisson process over the horizon. The warm-up's arrivals come
  // from their own stream, drawn backwards from t = 0, so the measured
  // window's arrivals are the same whatever the warm-up length. Only the next
  // arrival sits in the event queue, which keeps the heap small. The rate
  // follows the calendar when the model has seasonality or growth (demand.ts).
  if (W > 0) schedule(0, "measure");
  const arrivalTimes = drawArrivals(model, H, W, streams.get("arrivals"), streams.get("arrivals:warmup"));
  // Each arrival's service comes from the mix, on its own streams (warm-up and
  // measured window apart, as for the arrival times).
  const mixWarmup = streams.get("mix:warmup");
  const mix = streams.get("mix");
  let nextArrival = 0;
  const scheduleArrival = () => {
    if (nextArrival < arrivalTimes.length) schedule(arrivalTimes[nextArrival++]!, "arrive");
  };
  scheduleArrival();
  // Weekly churn ticks.
  for (let w = 1; w <= model.horizonWeeks; w++) schedule(w * model.hoursPerWeek, "week");
  // People coming back from leave pick up waiting work.
  for (const p of people) for (const [, end] of p.leave ?? []) if (end < H) schedule(end, "back", null, null, p);
  // With servicing, people going on leave hand their assigned tasks to the role's pool.
  if (servicing) for (const p of people) for (const [a] of p.leave ?? []) if (a > -W && a < H) schedule(a, "away", null, null, p);
  if (start.kind === "wip") seedWip();
  // Optional weekly samples (the absence test, absence.ts): queue lengths and completions at each weekly tick.
  const weekly: WeeklySamples | null = sampleWeekly ? { queue: {}, completed: [], won: [] } : null;
  if (weekly) for (const st of stepList) weekly.queue[st.s.id] = [];

  for (let ev = events.pop(); ev; ev = events.pop()) {
    if (ev.t > H) break;
    if (ev.type === "arrive") {
      scheduleArrival();
      const sv = drawService(ev.t < 0 ? mixWarmup : mix);
      const e: SimEntity = { id: eid++, t0: ev.t, trace: keepTrace ? [] : NO_TRACE, seg: null, svc: sv, lp: null, lv: null };
      if (keepTrace) entities.push(e);
      if (ev.t >= 0) services[sv]!.counts.arrivals++;
      enterTarget(e, entryTargets[sv]!, ev.t);
    } else if (ev.type === "end") {
      endService(ev.e!, ev.st!, ev.p, ev.t);
    } else if (ev.type === "leave") {
      leave(ev.e!, ev.st!, ev.t);
    } else if (ev.type === "back") {
      takeNext(ev.p!, ev.t);
    } else if (ev.type === "measure") {
      startMeasuring();
    } else if (ev.type === "task") {
      createTask(ev.c!, ev.l!, ev.t);
    } else if (ev.type === "away") {
      // Anyone idle who shares a servicing step with them can now take their queued tasks.
      const peers = new Set<PersonState>();
      const away = ev.p!;
      for (const st of away.steps) {
        const k = st.assigned ? st.assigned.people.indexOf(away) : -1;
        if (k >= 0 && st.assigned!.lists[k]!.size) for (const q of st.people) if (q !== away) peers.add(q);
      }
      for (const q of peers) takeNext(q, ev.t);
    } else {
      churnTick(ev.t);
      if (weekly) {
        for (const st of stepList) weekly.queue[st.s.id]!.push(st.stat.qLen);
        weekly.completed.push(won + done + allTouch.onTime + allTouch.late);
        weekly.won.push(won);
      }
    }
    // Handled: recycle it (nothing keeps a reference to an event after it runs).
    pool.push(ev);
  }
  for (const p of people) advance(p, H);
  // Clients still active bill to the horizon.
  for (const rc of rosterClients) bill(rc, H);
  // Deadlines up to the horizon, after its weekly tick.
  if (servicing) for (const rc of rosterClients) settleMisses(rc, H, true);

  const stepOut: Record<string, StepResult> = {};
  for (const s of model.steps) {
    const st = stepStates.get(s.id)!.stat;
    addArea(st, H);
    const halfWeeks = model.horizonWeeks / 2;
    stepOut[s.id] = {
      arrivals: st.arrivals,
      avgQueue: st.qArea / H,
      maxQueue: st.qMax,
      avgWait: st.waitN ? st.waitSum / st.waitN : 0,
      reworks: st.reworks,
      wip: st.qLen,
      queueGrowth: halfWeeks > 0 ? ((st.qAreaLate - (st.qArea - st.qAreaLate)) / half) / halfWeeks : 0,
      departures: st.departures,
      slaBreaches: st.slaBreaches,
      lostHere: st.lostHere,
      avgHandsOn: st.handsOnN ? st.handsOnSum / st.handsOnN : 0,
      avgStretch: st.handsOnN ? st.stretchSum / st.handsOnN : 0,
      handsOnVisits: st.handsOnN,
      avgFixedWait: st.fixedWaitN ? st.fixedWaitSum / st.fixedWaitN : 0,
      fixedWaitVisits: st.fixedWaitN,
    };
  }
  // Ongoing load is reported from the live client count, integrated over the
  // measured window: the same load that set everyone's availability
  // (docs/PRD.md §6.8 item 2). Overtime: of the hours worked while overloaded
  // (ongoing plus pipeline hands-on), those beyond capacity, up to the cap.
  const weeks = model.horizonWeeks;
  const peopleOut: Record<string, PersonResult> = {};
  const roleOngoing: Record<string, number> = {};
  const roleOvertime: Record<string, number> = {};
  for (const rid in model.roles) {
    roleOngoing[rid] = 0;
    roleOvertime[rid] = 0;
  }
  let overtimeHours = 0;
  let overtimeCost = 0;
  for (const p of people) {
    const c = p.person.capacity;
    const cap = c * weeks;
    const ong = p.ongoingHours;
    const ot =
      overtimeCap > 0 ? Math.min(Math.max(0, p.overOngoing + p.overPipeline - c * p.overWeeks), overtimeCap * c * p.overWeeks) : 0;
    peopleOut[p.id] = {
      pipeline: cap ? p.busyHours / cap : 0,
      ongoing: cap ? ong / cap : 0,
      servicing: cap ? p.svcHours / cap : 0,
      util: cap ? (p.busyHours + p.svcHours + ong) / (cap + ot) : 0,
      pipelineHours: p.busyHours / weeks,
      ongoingHours: ong / weeks,
      servicingHours: p.svcHours / weeks,
      overtime: cap ? ot / cap : 0,
      overtimeHours: ot / weeks,
      completed: p.completed,
      ...(roster ? { clients: p.clientWeeks / weeks } : {}),
    };
    for (let r = 0; r < roleIds.length; r++) if (p.roleOngoingHas[r]) roleOngoing[roleIds[r]!]! += p.roleOngoingHours[r]!;
    const ownRoles = p.person.roles.filter((rid) => rid in roleOvertime);
    for (const rid of ownRoles) roleOvertime[rid]! += ot / p.person.roles.length;
    if (ot > 0) {
      overtimeHours += ot;
      const rate =
        p.person.cost ?? (ownRoles.length ? ownRoles.reduce((sum, rid) => sum + model.roles[rid]!.cost, 0) / ownRoles.length : 0);
      overtimeCost += ot * rate;
    }
  }
  const roleOut: Record<string, RoleResult> = {};
  for (const rid in model.roles) {
    const cap = (roleCapacity[rid] ?? 0) * weeks;
    const ong = roleOngoing[rid]!;
    const ot = roleOvertime[rid]!;
    const busy = roleAcc[rid]!.busy;
    const svcHours = roleAcc[rid]!.svc;
    roleOut[rid] = {
      pipeline: cap ? busy / cap : 0,
      ongoing: cap ? ong / cap : 0,
      servicing: cap ? svcHours / cap : 0,
      util: cap ? (busy + svcHours + ong) / (cap + ot) : 0,
      pipelineHours: busy / weeks,
      ongoingHours: ong / weeks,
      servicingHours: svcHours / weeks,
      overtime: cap ? ot / cap : 0,
      overtimeHours: ot / weeks,
    };
  }
  // Clients (docs/PRD.md §6.4 "Per client"): the roster's one by one; at risk counts every active client.
  let clientsOut: Record<string, ClientReplication> | undefined;
  let atRisk = 0;
  if (roster) {
    clientsOut = {};
    for (const rc of realClients) {
      const health = rc.trajectory!;
      while (health.length < weeks + 1) health.push(rc.health);
      clientsOut[rc.key] = {
        health,
        touchpoints: rc.touch,
        churned: rc.churned,
        // Its chance at the horizon: base × (1 + the drivers' pressure at the last tick, late work at the final health) × the market.
        churnMonthly: Math.min(
          1,
          Math.max(
            0,
            rc.churnBase * (1 + (don[SLATE] ? dw[SLATE]! * (rc.sensitivity * ((100 - clampHealth(rc.health)) / 100)) : 0) + rc.extraA) * rc.lastB,
          ),
        ),
      };
    }
    for (const rc of rosterClients) if (rc.health < AT_RISK_HEALTH) atRisk++;
  }
  /** The churn drivers' accounting for this replication: who the churn is blamed on, and what each cause measured. */
  function churnOut(): ChurnReplication {
    const touched = allTouch.onTime + allTouch.late + allTouch.missed;
    const values: (number | null)[] = new Array<number | null>(nSlots).fill(null);
    const valuePerson: (string | null)[] = new Array<string | null>(nSlots).fill(null);
    values[SLATE] = touched > 0 ? (allTouch.late + allTouch.missed) / touched : null;
    values[SRESP] = respN > 0 ? respSum / respN : null;
    values[SONB] = onbN > 0 ? onbSum / onbN / (model.hoursPerWeek / 5) : null;
    values[SREWORK] = visitsAll > 0 ? reworksAll / visitsAll : null;
    if (utilRead) {
      values[SLOAD] = busiest;
      valuePerson[SLOAD] = busiestPerson;
    }
    for (const s of [SHAND, SRESULTS, STENURE, SPRICE]) values[s] = drivers[s - 1]!.value;
    values[SMARKET] = 1 + (pressN > 0 ? pressSum[SMARKET]! / pressN : 0);
    for (let s = SMARKET + 1; s < nSlots; s++) values[s] = drivers[s - 1]!.value;
    return {
      clients: Array.from(causeClients),
      mrr: Array.from(causeMrr),
      pressure: Array.from(pressSum),
      pressureN: pressN,
      byService: Object.fromEntries([...causeByService].map(([k, v]) => [k, Array.from(v)])),
      values,
      valuePerson,
    };
  }
  const loopsOut: Record<string, LoopReplication> = {};
  for (const L of loopRuns) {
    loopsOut[L.def.id] = {
      entered: L.entered,
      went: L.went,
      rounds: L.rounds,
      roleHours: Object.fromEntries(L.roleHours),
      extraElapsed: L.extraElapsed,
    };
  }
  // Revenue from the per-service counts (docs/PRD.md §13).
  let newMrr = 0;
  let ltvAdded = 0;
  let lostRevenue = 0;
  const serviceOut: Record<string, ServiceCounts> = {};
  for (const sv of services) {
    const { won: w, lost: l } = sv.counts;
    const units = market ? sv.wonUnits : w;
    if (sv.s.pricingModel === "retainer") newMrr += units * sv.s.price;
    ltvAdded += units * sv.value;
    lostRevenue += l * sv.value;
    if (sv.id !== null) serviceOut[sv.id] = sv.counts;
  }
  const toTrace = ({ seg: _seg, svc, task: _task, lp: _lp, lv: _lv, ...entity }: SimEntity): TraceEntity => {
    const id = services[svc]!.id;
    return id !== null ? { ...entity, service: id } : entity;
  };
  return {
    won,
    lost,
    done,
    newMrr,
    billed,
    ltvAdded,
    lostRevenue,
    services: serviceOut,
    overtimeHours,
    overtimeCost,
    ...(roster ? { clientsChurned: churned, clientsAtRisk: atRisk, touchpoints: allTouch, clients: clientsOut!, churn: churnOut() } : {}),
    cycle,
    steps: stepOut,
    roles: roleOut,
    people: peopleOut,
    loops: loopsOut,
    rework: { roleHours: Object.fromEntries(reworkRoles), extraElapsed: reworkElapsed, items: won + lost + done },
    entities: keepTrace ? entities.map(toTrace) : null,
    ...(weekly ? { weekly } : {}),
    H,
    warmupHours: W,
    activeEnd: active,
  };
}

/** x^n for a whole n ≥ 0 by repeated squaring (plain multiplication, so identical in every JS engine). */
function powInt(x: number, n: number): number {
  let result = 1;
  for (let b = x, k = n; k > 0; k >>= 1, b *= b) if (k & 1) result *= b;
  return result;
}

/** Value at percentile `p` (0–1) using the prototype's nearest-rank rule. */
export function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))]!;
}

/** Mean and 10th–90th percentile band of a set of values (as `pct` gives them, from one sort). */
export function stat(values: number[]): Stat {
  const n = values.length;
  if (!n) return { mean: 0, p10: 0, p90: 0 };
  const a = values.slice().sort((x, y) => x - y);
  return {
    mean: values.reduce((a, b) => a + b, 0) / n,
    p10: a[Math.min(n - 1, Math.floor(0.1 * n))]!,
    p90: a[Math.min(n - 1, Math.floor(0.9 * n))]!,
  };
}

/** Pipeline labour cost of one replication. */
function labourOf(model: EngineModel, r: ReplicationResult): number {
  let total = 0;
  for (const rid in model.roles) total += r.roles[rid]!.pipelineHours * model.horizonWeeks * model.roles[rid]!.cost;
  return total;
}

/** Items queued at the pipeline's steps at the horizon (servicing tasks aren't the pipeline's WIP). */
function pipelineWip(r: ReplicationResult, servicingSteps: Set<string>): number {
  let wip = 0;
  for (const [id, st] of Object.entries(r.steps)) if (!servicingSteps.has(id)) wip += st.wip;
  return wip;
}

function kpis(model: EngineModel, runs: ReplicationResult[], cycle: number[]): Kpis {
  const labour = runs.map((r) => labourOf(model, r));
  const svcSteps = servicingStepIds(model);
  const roles: Kpis["roles"] = {};
  for (const rid in model.roles) {
    roles[rid] = {
      util: stat(runs.map((r) => r.roles[rid]!.util)),
      pipeline: stat(runs.map((r) => r.roles[rid]!.pipeline)),
      ongoing: stat(runs.map((r) => r.roles[rid]!.ongoing)),
      servicing: stat(runs.map((r) => r.roles[rid]!.servicing)),
      overtime: stat(runs.map((r) => r.roles[rid]!.overtime)),
    };
  }
  const people: Kpis["people"] = {};
  for (const pid in runs[0]?.people ?? {}) {
    people[pid] = {
      util: stat(runs.map((r) => r.people[pid]!.util)),
      pipeline: stat(runs.map((r) => r.people[pid]!.pipeline)),
      ongoing: stat(runs.map((r) => r.people[pid]!.ongoing)),
      servicing: stat(runs.map((r) => r.people[pid]!.servicing)),
      overtime: stat(runs.map((r) => r.people[pid]!.overtime)),
    };
  }
  const services: Kpis["services"] = {};
  for (const sid in runs[0]?.services ?? {}) {
    services[sid] = {
      arrivals: stat(runs.map((r) => r.services[sid]!.arrivals)),
      won: stat(runs.map((r) => r.services[sid]!.won)),
      lost: stat(runs.map((r) => r.services[sid]!.lost)),
    };
  }
  return {
    won: stat(runs.map((r) => r.won)),
    lost: stat(runs.map((r) => r.lost)),
    done: stat(runs.map((r) => r.done)),
    labour: stat(labour),
    costPerWin: stat(runs.flatMap((r, i) => (r.won ? [labour[i]! / r.won] : []))),
    mrrAdded: stat(runs.map((r) => r.newMrr)),
    billed: stat(runs.map((r) => r.billed)),
    ltvAdded: stat(runs.map((r) => r.ltvAdded)),
    lostRevenue: stat(runs.map((r) => r.lostRevenue)),
    wipEnd: stat(runs.map((r) => pipelineWip(r, svcSteps))),
    overtimeHours: stat(runs.map((r) => r.overtimeHours)),
    overtimeCost: stat(runs.map((r) => r.overtimeCost)),
    cycle: {
      mean: cycle.length ? cycle.reduce((a, b) => a + b, 0) / cycle.length : 0,
      p50: pct(cycle, 0.5),
      p90: pct(cycle, 0.9),
    },
    roles,
    people,
    services,
    ...(model.clients
      ? {
          clientsChurned: stat(runs.map((r) => r.clientsChurned ?? 0)),
          clientsAtRisk: stat(runs.map((r) => r.clientsAtRisk ?? 0)),
          touchpoints: {
            onTime: stat(runs.map((r) => r.touchpoints?.onTime ?? 0)),
            late: stat(runs.map((r) => r.touchpoints?.late ?? 0)),
            missed: stat(runs.map((r) => r.touchpoints?.missed ?? 0)),
          },
        }
      : {}),
  };
}

/** Each roster client across replications (docs/PRD.md §6.4 "Per client"). */
function clientResults(model: EngineModel, runs: ReplicationResult[]): Record<string, ClientResult> {
  const out: Record<string, ClientResult> = {};
  const n = runs.length;
  for (const cid of Object.keys(runs[0]?.clients ?? {})) {
    const reps = runs.map((r) => r.clients![cid]!);
    const weeks = reps[0]!.health.length;
    const trajectory: number[] = [];
    for (let w = 0; w < weeks; w++) trajectory.push(reps.reduce((a, c) => a + c.health[w]!, 0) / n);
    const final = reps.map((c) => c.health[weeks - 1]!);
    const mean = (f: (c: ClientReplication) => number) => reps.reduce((a, c) => a + f(c), 0) / n;
    out[cid] = {
      name: model.clients?.[cid]?.name ?? cid,
      health: stat(final),
      trajectory,
      touchpoints: { onTime: mean((c) => c.touchpoints.onTime), late: mean((c) => c.touchpoints.late), missed: mean((c) => c.touchpoints.missed) },
      churnMonthly: stat(reps.map((c) => c.churnMonthly)),
      churned: mean((c) => (c.churned ? 1 : 0)),
      atRisk: mean((c) => (c.health[weeks - 1]! < AT_RISK_HEALTH ? 1 : 0)),
    };
  }
  return out;
}

const MONTH_WEEKS = 52 / 12;

/** The mean of per-run means weighted by the counts behind them (0 when there are none). */
function weighted(
  runs: ReplicationResult[],
  value: (r: ReplicationResult) => number | undefined,
  count: (r: ReplicationResult) => number | undefined,
): number {
  let sum = 0;
  let n = 0;
  for (const r of runs) {
    const c = count(r) ?? 0;
    sum += (value(r) ?? 0) * c;
    n += c;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * A ratio across replications: the mean is the sum of numerators over the sum of
 * denominators (so runs with nothing to divide by add nothing, not a zero), the
 * band is of the runs that have a denominator.
 */
function ratioStat(nums: number[], dens: number[]): Stat {
  const sumN = nums.reduce((a, b) => a + b, 0);
  const sumD = dens.reduce((a, b) => a + b, 0);
  const mean = sumD > 0 ? sumN / sumD : 0;
  const ratios = nums.flatMap((n, i) => (dens[i]! > 0 ? [n / dens[i]!] : []));
  const band = stat(ratios);
  return { mean, p10: band.p10, p90: band.p90 };
}

/** Each rework loop across replications (loops.ts): the share that go round, how often, and what the repeat passes cost. */
function loopResults(model: EngineModel, runs: ReplicationResult[]): LoopResult[] {
  const weeks = model.horizonWeeks;
  const out: LoopResult[] = [];
  for (const def of loopsOf(model)) {
    const reps = runs.map((r) => r.loops![def.id]!);
    const roles = new Set<string>();
    for (const r of reps) for (const rid of Object.keys(r.roleHours)) roles.add(rid);
    const perMonth = (hours: number) => (weeks > 0 ? (hours / weeks) * MONTH_WEEKS : 0);
    const extraHandsOnHoursPerMonth: Record<string, Stat> = {};
    for (const rid of [...roles].sort()) extraHandsOnHoursPerMonth[rid] = stat(reps.map((r) => perMonth(r.roleHours[rid] ?? 0)));
    out.push({
      id: def.id,
      kind: def.kind,
      steps: def.steps,
      from: def.from,
      to: def.to,
      share: ratioStat(reps.map((r) => r.went), reps.map((r) => r.entered)),
      meanRounds: ratioStat(reps.map((r) => r.rounds), reps.map((r) => r.went)),
      extraHandsOnHoursPerMonth,
      extraHandsOnHoursPerMonthTotal: stat(reps.map((r) => perMonth(Object.values(r.roleHours).reduce((a, b) => a + b, 0)))),
      extraCycleHours: ratioStat(reps.map((r) => r.extraElapsed), reps.map((r) => r.entered)),
      extraCycleHoursPerLooper: ratioStat(reps.map((r) => r.extraElapsed), reps.map((r) => r.went)),
    });
  }
  return out;
}

/** All repeat passes together (each counted once, in the innermost loop it is on), so the loops' figures add up to these. */
function reworkTotals(model: EngineModel, runs: ReplicationResult[]): ReworkTotal {
  const weeks = model.horizonWeeks;
  const perMonth = (hours: number) => (weeks > 0 ? (hours / weeks) * MONTH_WEEKS : 0);
  const roles = new Set<string>();
  for (const r of runs) for (const rid of Object.keys(r.rework!.roleHours)) roles.add(rid);
  const byRole: Record<string, Stat> = {};
  for (const rid of [...roles].sort()) byRole[rid] = stat(runs.map((r) => perMonth(r.rework!.roleHours[rid] ?? 0)));
  return {
    extraHandsOnHoursPerMonth: byRole,
    extraHandsOnHoursPerMonthTotal: stat(runs.map((r) => perMonth(Object.values(r.rework!.roleHours).reduce((a, b) => a + b, 0)))),
    extraCycleHoursPerItem: ratioStat(runs.map((r) => r.rework!.extraElapsed), runs.map((r) => r.rework!.items)),
  };
}

/** Per step: hands-on versus waiting, and whether only one person can do it. */
function stepFactsOf(model: EngineModel, steps: Record<string, StepResult>): Record<string, StepFacts> {
  const people = resolvePeople(model);
  const H = model.horizonWeeks * model.hoursPerWeek;
  const named = Boolean(model.people && Object.keys(model.people).length);
  // Someone away for the whole run can't do anything in it.
  const awayAllRun = (p: EnginePerson) => (p.leave ?? []).some(([a, b]) => a <= 0 && b >= H);
  const ids = Object.keys(people).filter((id) => people[id]!.capacity > 0 && !awayAllRun(people[id]!));
  const out: Record<string, StepFacts> = {};
  for (const s of model.steps) {
    const r = steps[s.id]!;
    const handsOn = r.avgHandsOn ?? 0;
    const stretch = r.avgStretch ?? 0;
    const fixed = r.avgFixedWait ?? 0;
    const total = handsOn + stretch + r.avgWait + fixed;
    const staffed = Boolean(s.role || s.person);
    // A role with a head-count of 0 and no named people is staffed by nobody (the engine itself would invent one person).
    const emptyRole = !named && s.role !== null && !s.person && (model.roles[s.role]?.count ?? 0) < 1;
    const who = staffed && !emptyRole ? ids.filter((id) => eligible(id, people[id]!, s)) : [];
    out[s.id] = {
      handsOnHours: handsOn,
      stretchHours: stretch,
      queueWaitHours: r.avgWait,
      fixedWaitHours: fixed,
      handsOnShare: total > 0 ? handsOn / total : 0,
      keyPerson: who.length === 1 ? { personId: who[0]!, personName: people[who[0]!]!.name } : null,
      nobodyCanDo: staffed && who.length === 0,
    };
  }
  return out;
}

/** A share of a step's visits (0 when there were none). */
const visitShare = (n: number, visits: number) => (visits > 0 ? Math.min(1, n / visits) : 0);

export function simulate(model: EngineModel, reps = 30, seed = 1): SimulationResult {
  model = withClientGroups(flattenModel(model));
  const runs: ReplicationResult[] = [];
  let trace: TraceEntity[] | null = null;
  const start = initialState(model);
  for (let i = 0; i < reps; i++) {
    const r = runOnce(model, seed + i * SEED_STRIDE, i === 0, start);
    if (i === 0) trace = r.entities;
    runs.push(r);
  }
  const n = runs.length;
  const avg = (f: (r: ReplicationResult) => number) => runs.reduce((a, r) => a + f(r), 0) / n;
  const cycle = runs.flatMap((r) => r.cycle);

  const steps: Record<string, StepResult> = {};
  for (const s of model.steps) {
    steps[s.id] = {
      arrivals: avg((r) => r.steps[s.id]!.arrivals),
      avgQueue: avg((r) => r.steps[s.id]!.avgQueue),
      maxQueue: avg((r) => r.steps[s.id]!.maxQueue),
      avgWait: avg((r) => r.steps[s.id]!.avgWait),
      reworks: avg((r) => r.steps[s.id]!.reworks),
      wip: avg((r) => r.steps[s.id]!.wip),
      queueGrowth: avg((r) => r.steps[s.id]!.queueGrowth),
      departures: avg((r) => r.steps[s.id]!.departures),
      slaBreaches: avg((r) => r.steps[s.id]!.slaBreaches),
      lostHere: avg((r) => r.steps[s.id]!.lostHere ?? 0),
      // Per-visit means, weighted by the visits behind each run's mean (a run with none says nothing).
      avgHandsOn: weighted(runs, (r) => r.steps[s.id]!.avgHandsOn, (r) => r.steps[s.id]!.handsOnVisits),
      avgStretch: weighted(runs, (r) => r.steps[s.id]!.avgStretch, (r) => r.steps[s.id]!.handsOnVisits),
      handsOnVisits: avg((r) => r.steps[s.id]!.handsOnVisits ?? 0),
      avgFixedWait: weighted(runs, (r) => r.steps[s.id]!.avgFixedWait, (r) => r.steps[s.id]!.fixedWaitVisits),
      fixedWaitVisits: avg((r) => r.steps[s.id]!.fixedWaitVisits ?? 0),
      p90: {
        avgWait: pct(runs.map((r) => r.steps[s.id]!.avgWait), 0.9),
        reworkShare: pct(runs.map((r) => visitShare(r.steps[s.id]!.reworks, r.steps[s.id]!.departures)), 0.9),
        slaBreachShare: pct(runs.map((r) => visitShare(r.steps[s.id]!.slaBreaches, r.steps[s.id]!.departures)), 0.9),
        lostShare: pct(runs.map((r) => visitShare(r.steps[s.id]!.lostHere ?? 0, r.steps[s.id]!.departures)), 0.9),
      },
    };
  }
  const roles: Record<string, RoleResult> = {};
  for (const rid in model.roles) {
    roles[rid] = {
      pipeline: avg((r) => r.roles[rid]!.pipeline),
      ongoing: avg((r) => r.roles[rid]!.ongoing),
      servicing: avg((r) => r.roles[rid]!.servicing),
      util: avg((r) => r.roles[rid]!.util),
      pipelineHours: avg((r) => r.roles[rid]!.pipelineHours),
      ongoingHours: avg((r) => r.roles[rid]!.ongoingHours),
      servicingHours: avg((r) => r.roles[rid]!.servicingHours),
      overtime: avg((r) => r.roles[rid]!.overtime),
      overtimeHours: avg((r) => r.roles[rid]!.overtimeHours),
    };
  }
  const resolvedPeople = resolvePeople(model);
  const people: Record<string, PersonResult> = {};
  for (const pid in resolvedPeople) {
    people[pid] = {
      pipeline: avg((r) => r.people[pid]!.pipeline),
      ongoing: avg((r) => r.people[pid]!.ongoing),
      servicing: avg((r) => r.people[pid]!.servicing),
      util: avg((r) => r.people[pid]!.util),
      pipelineHours: avg((r) => r.people[pid]!.pipelineHours),
      ongoingHours: avg((r) => r.people[pid]!.ongoingHours),
      servicingHours: avg((r) => r.people[pid]!.servicingHours),
      overtime: avg((r) => r.people[pid]!.overtime),
      overtimeHours: avg((r) => r.people[pid]!.overtimeHours),
      completed: avg((r) => r.people[pid]!.completed),
      ...(model.clients ? { clients: avg((r) => r.people[pid]!.clients ?? 0) } : {}),
    };
  }
  const wonArr = runs.map((r) => r.won);
  const won = avg((r) => r.won);
  const lost = avg((r) => r.lost);
  const H = model.horizonWeeks * model.hoursPerWeek;
  let labour = 0;
  for (const rid in model.roles) labour += roles[rid]!.pipelineHours * model.horizonWeeks * model.roles[rid]!.cost;

  // Bottleneck: role with highest utilisation; step with the largest average queue.
  let bnRole: string | null = null;
  for (const rid in roles) if (!bnRole || roles[rid]!.util > roles[bnRole]!.util) bnRole = rid;
  let bnPerson: string | null = null;
  for (const pid in people) if (!bnPerson || people[pid]!.util > people[bnPerson]!.util) bnPerson = pid;
  let bnStep: string | null = null;
  for (const s of model.steps) {
    if (s.role && (!bnStep || steps[s.id]!.avgQueue > steps[bnStep]!.avgQueue)) bnStep = s.id;
  }

  const kpi = kpis(model, runs, cycle);
  const svcSteps = servicingStepIds(model);
  const samples: ReplicationSamples = {
    won: wonArr,
    lost: runs.map((r) => r.lost),
    mrrAdded: runs.map((r) => r.newMrr),
    billed: runs.map((r) => r.billed),
    labour: runs.map((r) => labourOf(model, r)),
    wipEnd: runs.map((r) => pipelineWip(r, svcSteps)),
    cycleMean: runs.map((r) => (r.cycle.length ? r.cycle.reduce((a, b) => a + b, 0) / r.cycle.length : 0)),
  };
  return {
    engineVersion: ENGINE_VERSION,
    kpi,
    samples,
    seed,
    won,
    wonLow: pct(wonArr, 0.1),
    wonHigh: pct(wonArr, 0.9),
    lost,
    cycleP50: pct(cycle, 0.5),
    cycleP90: pct(cycle, 0.9),
    steps,
    roles,
    people,
    resolvedPeople,
    labour,
    costPerWin: won ? labour / won : 0,
    mrrAdded: kpi.mrrAdded.mean,
    bnRole,
    bnStep,
    bnPerson,
    trace,
    loops: loopResults(model, runs),
    rework: reworkTotals(model, runs),
    stepFacts: stepFactsOf(model, steps),
    H,
    reps,
    wipEnd: model.steps.reduce((a, s) => a + (svcSteps.has(s.id) ? 0 : steps[s.id]!.wip), 0),
    initialState: start,
    ...(model.clients ? { clients: clientResults(model, runs) } : {}),
    ...(runs[0]?.churn ? { churnCauses: summariseChurn(model, resolveChurnDrivers(model), runs.map((r) => r.churn!)) } : {}),
  };
}

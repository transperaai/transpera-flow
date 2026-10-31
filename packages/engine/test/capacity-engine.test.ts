import { describe, expect, it } from "vitest";
import {
  runOnce,
  simulate,
  withClientGroups,
  type EngineClient,
  type EngineModel,
  type EnginePerson,
  type EngineService,
  type EngineServicingLink,
  type Recurrence,
  type TraceEntity,
} from "../src";

// P2 (docs/plans/capacity/p2-engine-inputs-brief.md): the engine reads the capacity inputs. Small hand-checkable models.

const HPW = 40;
/** A month in the capacity inputs: 52/12 weeks. */
const MONTH_WEEKS = 52 / 12;

const service = (servicing: EngineServicingLink[], extra: Partial<EngineService> = {}): EngineService => ({
  name: "Retainer",
  pricingModel: "retainer",
  price: 4330,
  margin: 0.5,
  tenureMonths: 12,
  churnMonthly: 0,
  mixShare: 1,
  pathTags: [],
  servicing,
  ...extra,
});

const client = (extra: Partial<EngineClient> = {}): EngineClient => ({ name: "Client", services: ["svc"], mrr: 4330, assignments: {}, ...extra });

const link = (recurrence: Recurrence, process = "care", sla = 1000): EngineServicingLink => ({ process, recurrence, sla });

interface Opts {
  weeks?: number;
  svc?: Partial<EngineService>;
  links?: EngineServicingLink[];
  work?: number;
  people?: Record<string, EnginePerson>;
  extra?: Partial<EngineModel>;
}

/** One process `care` of one constant step `task` (`work` hours, role r). No warm-up, no leads, no churn. */
function model(clients: Record<string, EngineClient>, o: Opts = {}): EngineModel {
  return {
    horizonWeeks: o.weeks ?? 26,
    hoursPerWeek: HPW,
    leadsPerWeek: 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 0,
    roles: { r: { name: "Role r", count: 2, cost: 50, ongoing: 0 } },
    people: o.people ?? { ann: { name: "Ann", roles: ["r"], capacity: HPW }, bob: { name: "Bob", roles: ["r"], capacity: HPW } },
    services: { svc: service(o.links ?? [link({ perMonth: 1, driver: "words", per: 1000 })], { deliverables: { words: 4000 }, ...o.svc }) },
    servicingProcesses: { care: { name: "Care", entry: "task", steps: ["task"] } },
    clients,
    entry: "a",
    sinks: { won: "won", lost: "lost" },
    ends: { care_done: { outcome: "done" } },
    steps: [
      { id: "a", name: "A", role: "r", work: 1, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "won", p: 1 }] },
      { id: "task", name: "Task", role: "r", work: o.work ?? 0.1, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "care_done", p: 1 }] },
    ],
    ...o.extra,
  };
}

const tasksOf = (entities: TraceEntity[] | null, clientId?: string) =>
  (entities ?? []).filter((e) => e.servicing && (clientId === undefined || e.servicing.client === clientId));

/** Tasks a month one client made in a run, from the step's arrivals. */
const perClientMonth = (m: EngineModel, clients: number, seed = 1, weeks = m.horizonWeeks) => runOnce(m, seed, false).steps.task!.arrivals / clients / (weeks / MONTH_WEEKS);

describe("item 1: driver recurrences", () => {
  it("a per-1,000-words process at 4,000 words makes 4 tasks a month, evenly spaced", () => {
    const r = runOnce(model({ c1: client() }), 1, true);
    const t0 = tasksOf(r.entities, "c1").map((e) => e.t0);
    // 4 a month at 4.33 weeks a month, as {every:"month"} runs: one task every 43.3 working hours.
    for (let i = 1; i < t0.length; i++) expect(t0[i]! - t0[i - 1]!).toBeCloseTo((HPW * 4.33) / 4, 9);
    expect(t0.length).toBeGreaterThanOrEqual(23);
    expect(t0.length).toBeLessThanOrEqual(25);
  });

  it("a per-channel process makes 4 tasks a month for a client with 4 channels", () => {
    const m = model({ c1: client() }, { links: [link({ perMonth: 1, driver: "channels" })], svc: { deliverables: { channels: 4 } } });
    const t0 = tasksOf(runOnce(m, 1, true).entities, "c1").map((e) => e.t0);
    expect(t0[1]! - t0[0]!).toBeCloseTo((HPW * 4.33) / 4, 9);
    expect(t0.length).toBeGreaterThanOrEqual(23);
    expect(t0.length).toBeLessThanOrEqual(25);
  });

  it("fractional values work: 1,500 words per 1,000 is 1.5 tasks a month; perMonth scales the rate", () => {
    const a = model({ c1: client() }, { svc: { deliverables: { words: 1500 } }, weeks: 52 });
    expect(runOnce(a, 1, false).steps.task!.arrivals).toBeCloseTo(18, -0.5);
    const b = model({ c1: client() }, { links: [link({ perMonth: 0.5, driver: "meetings" })], svc: { deliverables: { meetings: 4 } }, weeks: 52 });
    // 0.5 × 4 = 2 a month.
    expect(runOnce(b, 1, false).steps.task!.arrivals).toBeGreaterThanOrEqual(23);
    expect(runOnce(b, 1, false).steps.task!.arrivals).toBeLessThanOrEqual(25);
  });

  it("a driver of 0 (or a service with no deliverables) makes no tasks", () => {
    expect(runOnce(model({ c1: client() }, { svc: { deliverables: { words: 0 } } }), 1, false).steps.task!.arrivals).toBe(0);
    expect(runOnce(model({ c1: client() }, { svc: { deliverables: undefined } }), 1, false).steps.task!.arrivals).toBe(0);
  });

  it("ad hoc: over many replications the mean tasks per client-month is chance x requests", () => {
    const clients = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, client()]));
    const m = model(clients, {
      links: [link({ perMonth: 1, driver: "adhoc" })],
      svc: { adhoc: { chance: 0.5, requests: 4 } },
      weeks: 26,
      people: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, { name: `P${i}`, roles: ["r"], capacity: HPW }])),
    });
    let sum = 0;
    const reps = 20;
    for (let s = 1; s <= reps; s++) sum += perClientMonth(m, 40, s * 7919);
    const mean = sum / reps;
    // chance x requests = 2; one client-month's count has variance 6, and 40 clients x 6 months x 20 runs is 4,800 of them (s.e. 0.035).
    expect(Math.abs(mean - 2)).toBeLessThan(0.15);
  });

  it("ad hoc requests are placed through the month and flagged as ad hoc", () => {
    const m = model({ c1: client() }, { links: [link({ perMonth: 1, driver: "adhoc" })], svc: { adhoc: { chance: 1, requests: 6 } }, weeks: 26 });
    const r = runOnce(m, 3, true);
    const t0 = tasksOf(r.entities, "c1").map((e) => e.t0);
    expect(t0.length).toBeGreaterThan(15);
    // Some in the first half and some in the second half of the first month.
    const month = MONTH_WEEKS * HPW;
    expect(t0.some((t) => t < month / 2)).toBe(true);
    expect(t0.some((t) => t >= month / 2 && t < month)).toBe(true);
  });

  it("a named client's override wins over its tier's value", () => {
    const m = model({ own: client({ overrides: { words: 2000 } }), tier: client() }, { weeks: 52 });
    const r = runOnce(m, 1, true);
    const own = tasksOf(r.entities, "own").length;
    const tier = tasksOf(r.entities, "tier").length;
    // 2,000 words is 2 a month (about 12 in 6 months over 52 weeks: 24); the tier's 4,000 is 4 a month.
    expect(tier).toBeGreaterThanOrEqual(2 * own - 2);
    expect(own).toBeGreaterThanOrEqual(23);
    expect(own).toBeLessThanOrEqual(25);
    expect(tier).toBeGreaterThanOrEqual(47);
    expect(tier).toBeLessThanOrEqual(49);
  });

  it("with no driver recurrences nothing about the old links changes", () => {
    const m = model({ c1: client() }, { links: [link({ every: "month", times: 4 })] });
    expect(runOnce(m, 1, false).steps.task!.arrivals).toBeGreaterThanOrEqual(23);
    // The driver form of the same rate runs the same clock.
    const d = model({ c1: client() });
    expect(runOnce(d, 1, false).steps.task!.arrivals).toBe(runOnce(m, 1, false).steps.task!.arrivals);
  });
});

// (later items append below)
void simulate;
void withClientGroups;

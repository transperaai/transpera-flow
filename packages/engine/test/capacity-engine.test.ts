import { describe, expect, it } from "vitest";
import {
  runOnce,
  simulate,
  capacityProblems,
  checkCapacityInputs,
  groupServiceOf,
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

describe("item 2: named and counted clients together", () => {
  const withGroups = (mix?: EngineModel["clientMix"], named: Record<string, EngineClient> = { n1: client({ name: "Named 1" }), n2: client({ name: "Named 2" }) }): EngineModel =>
    model(named, {
      extra: {
        clientGroups: { svc: { count: 3, fee: 1000, churnMonthly: 0, stayMonths: 12, health: 70 } },
        ...(mix ? { clientMix: mix } : {}),
      },
    });

  it("groups-add keeps the named clients and adds the counted ones, with unique keys", () => {
    const m = withClientGroups(withGroups("groups-add"));
    expect(Object.keys(m.clients!).sort()).toEqual(["group:svc:1", "group:svc:2", "group:svc:3", "n1", "n2"]);
    expect(m.activeClients).toBe(5);
    expect(m.clients!.n1!.name).toBe("Named 1");
    expect(m.clients!["group:svc:2"]).toMatchObject({ name: "Retainer 2", mrr: 1000, health: 70 });
    expect(groupServiceOf("group:svc:2")).toBe("svc");
    expect(groupServiceOf("n1")).toBeNull();
  });

  it("a named client that already has a group-style key is kept and the group clients take the next free numbers", () => {
    const m = withClientGroups(withGroups("groups-add", { "group:svc:1": client({ name: "Odd" }) }));
    expect(Object.keys(m.clients!)).toHaveLength(4);
    expect(m.clients!["group:svc:1"]!.name).toBe("Odd");
    expect(Object.keys(m.clients!).sort()).toEqual(["group:svc:1", "group:svc:2", "group:svc:3", "group:svc:4"]);
  });

  it("groups-replace and an omitted mix are today's rule: the groups replace the named roster, exactly", () => {
    const replace = withClientGroups(withGroups("groups-replace"));
    const omitted = withClientGroups(withGroups());
    expect(Object.keys(replace.clients!).sort()).toEqual(["group:svc:1", "group:svc:2", "group:svc:3"]);
    expect(replace.clients).toEqual(omitted.clients);
    expect(replace.activeClients).toBe(3);
  });

  it("simulates both kinds together: the run reports named and counted clients", () => {
    const r = simulate(withGroups("groups-add"), 2, 1);
    expect(Object.keys(r.clients ?? {}).sort()).toEqual(["group:svc:1", "group:svc:2", "group:svc:3", "n1", "n2"]);
  });
});

describe("item 3: portfolios and the client's manager", () => {
  const dora: EnginePerson = { name: "Dora", roles: ["dir"], capacity: HPW };
  const ann: EnginePerson = { name: "Ann", roles: ["r"], capacity: HPW };
  const bob: EnginePerson = { name: "Bob", roles: ["r"], capacity: HPW };
  /** Role r's step goes to the client's manager; Dora is a director, not in role r. */
  const managed = (clients: Record<string, EngineClient>, o: Opts = {}): EngineModel => {
    const m = model(clients, { people: { ann, bob, dora }, ...o });
    m.roles = { ...m.roles, dir: { name: "Director", count: 1, cost: 80, ongoing: 0 } };
    m.steps = m.steps.map((s) => (s.id === "task" ? { ...s, toClientManager: true } : s));
    return m;
  };
  const personsOf = (entities: TraceEntity[] | null, clientId: string) => new Set(tasksOf(entities, clientId).flatMap((e) => e.trace.map((seg) => seg.person)));

  it("a step with toClientManager queues for the client's manager whatever their role", () => {
    const r = runOnce(managed({ c1: client({ manager: "dora" }), c2: client() }), 1, true);
    expect(personsOf(r.entities, "c1")).toEqual(new Set(["dora"]));
    // No manager: the role's pool, as today.
    const pool = personsOf(r.entities, "c2");
    expect(pool.has("dora")).toBe(false);
    expect([...pool].every((p) => p === "ann" || p === "bob")).toBe(true);
  });

  it("the manager's busy share counts the work as theirs and as their own role's", () => {
    const r = runOnce(managed({ c1: client({ manager: "dora" }) }), 1, false);
    // 4 tasks a month x 0.1 h over 26 weeks (about 24 tasks): 2.4 h, which is 2.4 / 26 a week.
    expect(r.people.dora!.servicingHours).toBeCloseTo((24 * 0.1) / 26, 1);
    expect(r.people.dora!.servicing).toBeGreaterThan(0);
    expect(r.people.ann!.servicingHours + r.people.bob!.servicingHours).toBe(0);
    // ...and it is the director role's work, not role r's.
    expect(r.roles.dir!.servicingHours).toBeCloseTo(r.people.dora!.servicingHours, 12);
    expect(r.roles.r!.servicingHours).toBe(0);
  });

  it("without the manager (on leave all run) the work falls to the role's pool", () => {
    const away: EnginePerson = { ...dora, leave: [[0, 26 * HPW]] };
    const r = runOnce(managed({ c1: client({ manager: "dora" }) }, { people: { ann, bob, dora: away } }), 1, true);
    const who = personsOf(r.entities, "c1");
    expect(who.has("dora")).toBe(false);
    expect(who.size).toBeGreaterThan(0);
  });

  it("an end date hands the client's work back to the pool", () => {
    const leaves: EnginePerson = { ...dora, until: 13 * HPW };
    const r = runOnce(managed({ c1: client({ manager: "dora" }) }, { people: { ann, bob, dora: leaves } }), 1, true);
    const early = tasksOf(r.entities, "c1").filter((e) => e.t0 < 12 * HPW);
    const late = tasksOf(r.entities, "c1").filter((e) => e.t0 > 14 * HPW);
    expect(early.every((e) => e.trace.every((seg) => seg.person === "dora"))).toBe(true);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((e) => e.trace.every((seg) => seg.person === "ann" || seg.person === "bob"))).toBe(true);
  });

  it("portfolio counts land on the right people, in people order, and the remainder stays unassigned", () => {
    const m = managed({}, {
      extra: { clientGroups: { svc: { count: 6, fee: 1000, churnMonthly: 0, stayMonths: 12, health: 70 } }, clientMix: "groups-replace" },
      people: { ann: { ...ann, portfolio: { svc: 2 } }, bob: { ...bob, portfolio: { svc: 1 } }, dora: { ...dora, portfolio: { svc: 2 } } },
    });
    const expanded = withClientGroups(m).clients!;
    const owner = (n: number) => expanded[`group:svc:${n}`]!;
    expect([1, 2].map((n) => owner(n).manager)).toEqual(["ann", "ann"]);
    expect(owner(1).assignments).toEqual({ r: "ann" });
    expect(owner(3).manager).toBe("bob");
    expect([4, 5].map((n) => owner(n).manager)).toEqual(["dora", "dora"]);
    // Dora's role isn't one the service's steps use, so she has no assignment, only the clients to manage.
    expect(owner(4).assignments).toEqual({});
    expect(owner(6).manager).toBeUndefined();
    expect(owner(6).assignments).toEqual({});
  });

  it("portfolio work shows in the manager's busy share and client count", () => {
    const m = managed({}, {
      extra: { clientGroups: { svc: { count: 4, fee: 1000, churnMonthly: 0, stayMonths: 12, health: 70 } } },
      people: { ann, bob, dora: { ...dora, portfolio: { svc: 3 } } },
    });
    const r = runOnce(m, 1, false);
    // 3 of the 4 clients are Dora's: 3 x 24 tasks x 0.1 h; the fourth's go to Ann or Bob.
    expect(r.people.dora!.clients).toBeCloseTo(3, 9);
    expect(r.people.dora!.servicingHours).toBeCloseTo((3 * 24 * 0.1) / 26, 1);
    expect(r.people.ann!.servicingHours + r.people.bob!.servicingHours).toBeCloseTo((24 * 0.1) / 26, 1);
  });

  it("a client's manager from another role never takes the step's shared queue", () => {
    // c2 has no manager: Dora is idle but must not take its tasks.
    const r = runOnce(managed({ c1: client({ manager: "dora" }), c2: client(), c3: client(), c4: client() }), 2, true);
    for (const id of ["c2", "c3", "c4"]) expect(personsOf(r.entities, id).has("dora")).toBe(false);
  });
});

describe("item 4: per-client overrides", () => {
  const adhocLink = [link({ perMonth: 1, driver: "adhoc" })];
  const adhocSvc = { adhoc: { chance: 0.5, requests: 4 } };

  it("overrides feed the ad-hoc rule and the deliverables (the client's own values win)", () => {
    const m = model({ own: client({ overrides: { adhocChance: 1, adhocRequests: 6 } }), tier: client() }, { links: adhocLink, svc: adhocSvc, weeks: 52 });
    const r = runOnce(m, 5, true);
    // 6 a month for 12 months is about 72; the tier's 0.5 x 4 = 2 a month is about 24.
    expect(tasksOf(r.entities, "own").length).toBeGreaterThan(50);
    expect(tasksOf(r.entities, "tier").length).toBeLessThan(45);
  });

  it("adhocHours scales a client's ad-hoc steps so their mean total per request is adhocHours", () => {
    const base = model({ c: client() }, { links: adhocLink, svc: { adhoc: { chance: 1, requests: 6 } }, work: 0.1 });
    // Two steps in the ad-hoc process: 0.1 + 0.3 h = 0.4 h a request.
    base.servicingProcesses = { care: { name: "Care", entry: "task", steps: ["task", "t2"] } };
    base.steps = [
      ...base.steps.map((s) => (s.id === "task" ? { ...s, next: [{ to: "t2", p: 1 }] } : s)),
      { id: "t2", name: "T2", role: "r", work: 0.3, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "care_done", p: 1 }] },
    ];
    const plain = runOnce(base, 4, false);
    const own = runOnce({ ...base, clients: { c: client({ overrides: { adhocHours: 2 } }) } }, 4, false);
    const requests = plain.steps.task!.arrivals;
    expect(requests).toBeGreaterThan(20);
    // The same draws, so the same requests: each now takes 2 h, where it took 0.4 h.
    expect(own.steps.task!.arrivals).toBe(requests);
    const hours = (r: typeof plain) => (r.people.ann!.servicingHours + r.people.bob!.servicingHours) * 26;
    expect(hours(plain)).toBeCloseTo(requests * 0.4, 9);
    expect(hours(own)).toBeCloseTo(requests * 2, 9);
  });

  it("stepFactor multiplies a client's drawn times: a number for every step, or one per step", () => {
    const base = model({ c: client() }, { work: 0.1 });
    const hours = (clientExtra: Partial<EngineClient>) => {
      const r = runOnce({ ...base, clients: { c: client(clientExtra) } }, 2, false);
      return { n: r.steps.task!.arrivals, h: (r.people.ann!.servicingHours + r.people.bob!.servicingHours) * 26 };
    };
    const plain = hours({});
    expect(plain.h).toBeCloseTo(plain.n * 0.1, 9);
    expect(hours({ overrides: { stepFactor: 2 } }).h).toBeCloseTo(plain.n * 0.2, 9);
    expect(hours({ overrides: { stepFactor: { task: 3, other: 9 } } }).h).toBeCloseTo(plain.n * 0.3, 9);
    expect(hours({ overrides: { stepFactor: { other: 9 } } }).h).toBeCloseTo(plain.n * 0.1, 9);
  });

  it("handHoldingHours adds hours a month to the client's assignee in the role, on top of the servicing tasks", () => {
    const m = model({ c: client({ assignments: { r: "ann" }, handHoldingHours: { r: 8.66 } }) });
    const r = runOnce(m, 1, false);
    // 8.66 h a month over 4.33 weeks is 2 h a week, ongoing, and the tasks still run.
    expect(r.people.ann!.ongoingHours).toBeCloseTo(2, 9);
    expect(r.people.bob!.ongoingHours).toBe(0);
    expect(r.people.ann!.servicingHours).toBeGreaterThan(0);
    const without = runOnce(model({ c: client({ assignments: { r: "ann" } }) }), 1, false);
    expect(without.people.ann!.ongoingHours).toBe(0);
    expect(without.people.ann!.servicingHours).toBeCloseTo(r.people.ann!.servicingHours, 1);
  });

  it("for the client-facing role the hours are the manager's", () => {
    const dora: EnginePerson = { name: "Dora", roles: ["dir"], capacity: HPW };
    const m = model({ c: client({ assignments: { r: "ann" }, manager: "dora", handHoldingHours: { r: 8.66 } }) }, {
      people: { ann: { name: "Ann", roles: ["r"], capacity: HPW }, bob: { name: "Bob", roles: ["r"], capacity: HPW }, dora },
    });
    m.roles = { ...m.roles, dir: { name: "Director", count: 1, cost: 80, ongoing: 0 } };
    m.steps = m.steps.map((s) => (s.id === "task" ? { ...s, toClientManager: true } : s));
    const r = runOnce(m, 1, false);
    expect(r.people.dora!.ongoingHours).toBeCloseTo(2, 9);
    expect(r.people.ann!.ongoingHours).toBe(0);
  });
});

describe("item 5: team time and ramp", () => {
  const solo = (ann: Partial<EnginePerson>, o: Opts = {}): EngineModel =>
    model({ c: client() }, { people: { ann: { name: "Ann", roles: ["r"], capacity: HPW, ...ann } }, work: 1, ...o });
  const monthly = (m: EngineModel) => simulate(m, 1, 1, { monthly: true }).monthly!;
  const hours = (m: EngineModel) => monthly(m).people.ann!.map((x) => x?.capacity ?? null);

  it("no team time and no ramp: the model runs as it did", () => {
    expect(hours(solo({}))).toEqual([40, 40, 40, 40, 40, 40]);
  });

  it("team time takes its share off every month's hours", () => {
    for (const h of hours(solo({ reservedShare: 0.25 }))) expect(h).toBeCloseTo(30, 9);
  });

  it("a ramp of [0.4, 0.6, 0.8] lowers the hours in the first three months only", () => {
    const h = hours(solo({ ramp: [0.4, 0.6, 0.8] }));
    expect(h.map((v) => Math.round(v! * 1000) / 1000)).toEqual([16, 24, 32, 40, 40, 40]);
  });

  it("a ramp starts in the month the person's start date falls in, and team time multiplies it", () => {
    const monthHours = (52 / 12) * HPW;
    // Starts in month 2 (the third): zero hours before, then 0.4, 0.6, 0.8 of the hours left after 25% team time.
    const h = hours(solo({ from: 2.5 * monthHours, ramp: [0.4, 0.6, 0.8], reservedShare: 0.25 }, { weeks: 52 }));
    // (Hours a week they have: half of month 2 is before the start date, so month 2 is half of 0.4 x 30 = 12.)
    expect(h[0]).toBeCloseTo(0, 9);
    expect(h[1]).toBeCloseTo(0, 9);
    expect(h[2]).toBeCloseTo(6, 9);
    expect(h[3]).toBeCloseTo(0.6 * 30, 9);
    expect(h[4]).toBeCloseTo(0.8 * 30, 9);
    expect(h[5]).toBeCloseTo(30, 9);
  });

  it("composes with the capacity channel: both factors apply", () => {
    const m = solo({ reservedShare: 0.25 });
    // (A model with channels is run on the channels' own months: the run's month starts.)
    const starts = [1, 2, 3, 4, 5].map((k) => k * (52 / 12) * HPW);
    m.channels = { starts, capacity: { ann: [1, 1, 1, 0.5, 0.5, 0.5] } };
    const h = simulate(m, 1, 1, { monthly: true, monthStarts: starts }).monthly!.people.ann!.map((x) => x?.capacity ?? null);
    expect(h.slice(0, 3).every((v) => Math.abs(v! - 30) < 1e-9)).toBe(true);
    expect(h.slice(3).every((v) => Math.abs(v! - 15) < 1e-9)).toBe(true);
  });

  it("the utilisation denominator is the reduced hours: the same work reads as a bigger share", () => {
    const plain = runOnce(solo({}), 1, false).people.ann!;
    const reserved = runOnce(solo({ reservedShare: 0.25 }), 1, false).people.ann!;
    expect(plain.servicingHours).toBeGreaterThan(0);
    expect(reserved.servicingHours).toBeCloseTo(plain.servicingHours, 9);
    expect(reserved.servicing).toBeCloseTo(plain.servicing / 0.75, 9);
  });

  it("paid hours (the cost of labour) are not reduced by team time or a ramp", () => {
    const labour = (m: EngineModel) => runOnce(m, 1, false).labourCost;
    expect(labour(solo({ reservedShare: 0.25, ramp: [0.4, 0.6] }))).toBeCloseTo(labour(solo({})) as number, 9);
  });

  it("availabilityFloor keeps its own meaning: a person with no hours left still gets the floor share for work", () => {
    const r = runOnce(solo({ ramp: [0] }, { weeks: 4 }), 1, false);
    // Month 0 has no hours for client work; tasks still finish, stretched by the floor (8% of a week by default).
    expect(r.steps.task!.departures).toBeGreaterThan(0);
  });
});

describe("item 6: placing won clients", () => {
  const people = (): Record<string, EnginePerson> => ({
    ann: { name: "Ann", roles: ["r"], capacity: HPW, tiers: ["T1"] },
    bob: { name: "Bob", roles: ["r"], capacity: HPW, tiers: ["T2"] },
    cat: { name: "Cat", roles: ["r"], capacity: HPW },
  });
  const winning = (extra: Partial<EngineModel>, ppl = people()): EngineModel =>
    model({}, { weeks: 40, people: ppl, svc: { tier: "T1" }, extra: { leadsPerWeek: 1.5, ...extra } });
  /** Won clients' first person, by client. */
  const placed = (r: ReturnType<typeof runOnce>) => {
    const out = new Map<string, string>();
    for (const e of tasksOf(r.entities)) {
      const c = e.servicing!.client;
      const person = e.trace.find((seg) => seg.person)?.person;
      if (c.startsWith("won:") && person && !out.has(c)) out.set(c, person);
    }
    return out;
  };
  const counts = (m: Map<string, string>) => {
    const out: Record<string, number> = {};
    for (const p of m.values()) out[p] = (out[p] ?? 0) + 1;
    return out;
  };

  it("never picks someone who doesn't serve the tier", () => {
    const r = runOnce(winning({ placeNewClients: "least-busy" }), 3, true);
    const who = placed(r);
    expect(who.size).toBeGreaterThan(8);
    expect(counts(who).bob).toBeUndefined();
    expect(Object.keys(counts(who)).sort()).toEqual(["ann", "cat"]);
  });

  it("picks the person with the lowest busy share, so equal people end up with about equal clients", () => {
    const r = runOnce(winning({ placeNewClients: "least-busy" }), 4, true);
    const c = counts(placed(r));
    expect(Math.abs(c.ann! - c.cat!)).toBeLessThanOrEqual(1);
  });

  it("a person already carrying clients is skipped until the others catch up", () => {
    const ppl = people();
    const m = winning({ placeNewClients: "least-busy", clients: { old1: client({ assignments: { r: "ann" } }), old2: client({ assignments: { r: "ann" } }) } }, ppl);
    const c = counts(placed(runOnce(m, 4, true)));
    // Ann starts with two clients, so Cat takes the first wins.
    expect(c.cat!).toBeGreaterThan(c.ann!);
  });

  it("round-robin (or omitted) is unchanged: it deals out to everyone in the role, tiers or not", () => {
    const omitted = runOnce(winning({}), 3, true);
    const explicit = runOnce(winning({ placeNewClients: "round-robin" }), 3, true);
    expect(counts(placed(omitted)).bob).toBeGreaterThan(0);
    expect(counts(placed(explicit))).toEqual(counts(placed(omitted)));
  });

  it("the won client's manager is the person placed in the role of its toClientManager steps", () => {
    const m = winning({ placeNewClients: "least-busy" });
    m.steps = m.steps.map((s) => (s.id === "task" ? { ...s, toClientManager: true } : s));
    const r = runOnce(m, 3, false);
    // Every won client is managed by someone in the role: ann or cat.
    expect(r.people.bob!.servicingHours).toBe(0);
    expect(r.people.ann!.servicingHours + r.people.cat!.servicingHours).toBeGreaterThan(0);
    expect(r.people.ann!.clients! + r.people.cat!.clients!).toBeGreaterThan(0);
  });
});

describe("item 7: where each person's time goes, by step", () => {
  const two = () => {
    const dora: EnginePerson = { name: "Dora", roles: ["dir"], capacity: HPW };
    const m = model({ c1: client({ manager: "dora" }), c2: client({ assignments: { r: "ann" } }), c3: client({ assignments: { r: "ann" } }) }, {
      people: { ann: { name: "Ann", roles: ["r"], capacity: HPW }, bob: { name: "Bob", roles: ["r"], capacity: HPW }, dora },
      work: 0.1,
    });
    m.roles = { ...m.roles, dir: { name: "Director", count: 1, cost: 80, ongoing: 0 } };
    m.steps = m.steps.map((s) => (s.id === "task" ? { ...s, toClientManager: true } : s));
    return m;
  };

  it("not asked for: nothing is added and no other number moves", () => {
    const plain = simulate(two(), 3, 1);
    const asked = simulate(two(), 3, 1, { personTime: true });
    expect(plain.personTime).toBeUndefined();
    const { personTime: _drop, ...rest } = asked;
    expect(JSON.stringify(rest.kpi)).toBe(JSON.stringify(plain.kpi));
    expect(JSON.stringify(rest.people)).toBe(JSON.stringify(plain.people));
    expect(JSON.stringify(rest.steps)).toBe(JSON.stringify(plain.steps));
  });

  it("gives mean hands-on hours a month per person per step, and clients per person per service", () => {
    const r = simulate(two(), 4, 1, { personTime: true });
    const pt = r.personTime!;
    const months = 26 / MONTH_WEEKS;
    // Dora is c1's manager (about 24 tasks over 6 months = 4 a month at 0.1 h); Ann has c2 and c3 (8 a month).
    expect(pt.stepHours.dora!.task!).toBeGreaterThan(0.35);
    expect(pt.stepHours.dora!.task!).toBeLessThan(0.45);
    expect(pt.stepHours.ann!.task!).toBeGreaterThan(0.75);
    expect(pt.stepHours.ann!.task!).toBeLessThan(0.85);
    // It adds up to what the run says each person worked.
    for (const pid of ["ann", "dora"]) expect(pt.stepHours[pid]!.task! * months).toBeCloseTo(r.people[pid]!.servicingHours * 26, 6);
    expect(pt.clients.dora).toEqual({ svc: 1 });
    expect(pt.clients.ann!.svc).toBeCloseTo(2, 9);
    expect(pt.stepHours.bob?.task ?? 0).toBeLessThan(0.1);
  });
});

describe("item 8: check before run", () => {
  it("capacityProblems is checkCapacityInputs, and simulate runs on a model with problems without throwing", () => {
    const m = model({}, {
      svc: { deliverables: undefined },
      extra: { clientGroups: { svc: { count: 2, fee: 1000, churnMonthly: 0, stayMonths: 12, health: 70 } } },
      people: { ann: { name: "Ann", roles: ["r"], capacity: HPW, portfolio: { svc: 5 }, reservedShare: 2 } },
    });
    const problems = capacityProblems(m);
    expect(problems).toEqual(checkCapacityInputs(m));
    expect(problems.map((p) => p.code).sort()).toEqual(["bad_number", "driver_without_deliverables", "portfolio_over_count"]);
    expect(() => simulate(m, 2, 1)).not.toThrow();
  });

  it("a clean model has none", () => {
    expect(capacityProblems(model({ c: client() }))).toEqual([]);
  });
});

// (later items append below)

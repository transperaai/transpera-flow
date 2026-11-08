import { describe, expect, it } from "vitest";
import {
  runOnce,
  simulate,
  type EngineClient,
  type EngineModel,
  type EngineService,
  type TraceEntity,
} from "../src";

// Hourly billing (engine 1.11.0): a client won during the run on an hourly service bills the hands-on hours worked for
// it after the sale (onboarding steps, servicing tasks, ongoing client work) at the service's rate. A client already
// there bills the fee entered for it. Hand-checked on small models; the expected hours are read off the trace.

const HPW = 40;
const RATE = 100;

const service = (extra: Partial<EngineService> = {}): EngineService => ({
  name: "Hourly",
  pricingModel: "hourly",
  price: RATE,
  margin: 0.5,
  tenureMonths: 12,
  churnMonthly: 0,
  mixShare: 1,
  pathTags: [],
  servicing: [{ process: "care", recurrence: { every: "week", times: 1 }, sla: 400 }],
  ...extra,
});

/**
 * 10 items start as work in progress at `pre` (3 h, role r, before the sale), wait 50 h at `decide`, win at about
 * t = 53 to 65 and hand over to `onboard` (2 h, role r, after the sale). Won clients get a weekly servicing task of
 * `taskWork` hours. Constant times, no warm-up, no new leads: nothing is random but who wins the race for a person.
 */
function model(o: { weeks?: number; people?: string[]; taskWork?: number; svc?: Partial<EngineService>; clients?: Record<string, EngineClient> } = {}): EngineModel {
  const people = Object.fromEntries((o.people ?? ["ann", "bob"]).map((id) => [id, { name: id, roles: ["r"], capacity: HPW }]));
  return {
    horizonWeeks: o.weeks ?? 12,
    hoursPerWeek: HPW,
    leadsPerWeek: 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 1000,
    warmupWeeks: 0,
    roles: { r: { name: "R", count: 2, cost: 50, ongoing: 0 } },
    people,
    services: { svc: service(o.svc) },
    servicingProcesses: { care: { name: "Care", entry: "task", steps: ["task"] } },
    clients: o.clients ?? {},
    entry: "pre",
    sinks: { won: "won", lost: "lost" },
    ends: { won: { outcome: "won", handoff: "onboard" }, finished: { outcome: "done" }, care_done: { outcome: "done" } },
    steps: [
      { id: "pre", name: "Pre-sale", role: "r", work: 3, wait: 0, rework: 0, workDist: { kind: "constant" }, currentWip: 10, next: [{ to: "decide", p: 1 }] },
      { id: "decide", name: "Decide", role: null, work: 0, wait: 50, waitDist: { kind: "constant" }, rework: 0, next: [{ to: "won", p: 1 }] },
      { id: "onboard", name: "Onboard", role: "r", work: 2, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "finished", p: 1 }] },
      { id: "task", name: "Task", role: "r", work: o.taskWork ?? 0.5, wait: 0, rework: 0, workDist: { kind: "constant" }, next: [{ to: "care_done", p: 1 }] },
    ],
  };
}

/** Hands-on hours inside [0, H] of the post-sale steps of the trace: onboarding, and tasks that start before `churnAt`. */
function billable(entities: TraceEntity[], H: number, churnAt = Infinity): { onboard: number; tasks: number } {
  let onboard = 0;
  let tasks = 0;
  for (const e of entities) {
    for (const s of e.trace) {
      if (s.person === null || s.tS === null) continue;
      const end = s.tE ?? H;
      const inside = Math.max(0, Math.min(end, H) - Math.max(s.tS, 0));
      if (e.servicing) {
        if (s.tS < churnAt) tasks += inside;
      } else if (s.step === "onboard") {
        onboard += inside;
      }
    }
  }
  return { onboard, tasks };
}

describe("hourly billing for clients won in the run", () => {
  it("bills the onboarding and servicing hours worked for a won client at the rate, and not the selling time", () => {
    const m = model();
    const r = runOnce(m, 1, true);
    expect(r.won).toBe(10);
    const H = m.horizonWeeks * HPW;
    const { onboard, tasks } = billable(r.entities!, H);
    expect(onboard).toBe(20);
    expect(tasks).toBeGreaterThan(0);
    // The pre-sale step took 30 hours, and none of them bills.
    expect(r.steps.pre!.avgHandsOn! * r.steps.pre!.handsOnVisits!).toBe(30);
    expect(r.hourly.svc!.hours).toBeCloseTo(onboard + tasks, 9);
    expect(r.hourly.svc!.revenue).toBeCloseTo((onboard + tasks) * RATE, 6);
    expect(r.revenue.hourly).toBeCloseTo((onboard + tasks) * RATE, 6);
    expect(r.revenue.fromNew).toBeCloseTo(r.revenue.hourly, 9);
    expect(r.revenue.recurring).toBe(0);
    expect(r.billed).toBe(0);
  });

  it("month by month adds up to the run", () => {
    const res = simulate(model(), 3, 1, { monthly: true });
    const mo = res.monthly!;
    expect(mo.revenue.hourly.reduce((a, s) => a + s.mean, 0)).toBeCloseTo(res.kpi.revenueHourly.mean, 6);
    expect(mo.revenue.fromNew.reduce((a, s) => a + s.mean, 0)).toBeCloseTo(res.kpi.revenueHourly.mean, 6);
    expect(mo.revenue.recurring.every((s) => s.mean === 0)).toBe(true);
  });

  it("does not bill tasks of a client that has churned", () => {
    // One person, 20-hour weekly tasks (a queue), and certain churn at the first tick after the wins (t = 80).
    const m = model({ people: ["ann"], taskWork: 20, svc: { churnMonthly: 5 }, weeks: 30 });
    const r = runOnce(m, 1, true);
    expect(r.clientsChurned).toBe(10);
    const H = m.horizonWeeks * HPW;
    const { onboard, tasks } = billable(r.entities!, H, 80);
    const all = billable(r.entities!, H);
    expect(all.tasks).toBeGreaterThan(tasks);
    expect(tasks).toBeGreaterThan(0);
    expect(r.hourly.svc!.hours).toBeCloseTo(onboard + tasks, 9);
  });

  it("a client already there bills its entered fee and no hours, whatever its service's pricing", () => {
    const named: EngineClient = { name: "Existing", services: ["svc"], mrr: 4330, assignments: {} };
    const r = runOnce(model({ clients: { c1: named }, weeks: 10 }), 1, false);
    // Its weekly servicing tasks are worked, but its fee is the bill.
    expect(r.people.ann!.servicingHours + r.people.bob!.servicingHours).toBeGreaterThan(0);
    expect(r.revenue.recurring).toBeGreaterThan(0);
    expect(r.revenue.recurring).toBeCloseTo(r.billed, 6);
    const won = r.hourly.svc!;
    // Only the ten won clients' hours: the existing client's tasks are not among them.
    const solo = runOnce(model({ weeks: 10 }), 1, false);
    expect(won.hours).toBeGreaterThanOrEqual(solo.hourly.svc!.hours - 1e-6);
    const fee = (4330 / 4.33) * 10;
    expect(r.revenue.recurring).toBeCloseTo(fee, 6);
  });

  it("clients already there as a counted group bill their fee and no hours either, while the clients won in the run bill hours", () => {
    const m: EngineModel = { ...model({ weeks: 10 }), clients: undefined, clientGroups: { svc: { count: 4, fee: 4330, churnMonthly: 0, stayMonths: 12, health: 80 } } };
    const r = runOnce(m, 1, true);
    // 4 clients × 4330 a month for 10 weeks, billed as the fee entered (no churn).
    expect(r.revenue.recurring).toBeCloseTo(4 * (4330 / 4.33) * 10, 6);
    expect(r.revenue.recurring).toBeCloseTo(r.billed, 6);
    // Their weekly tasks are worked but not billed: the hours are the won clients' alone (onboarding and their own tasks).
    const H = m.horizonWeeks * HPW;
    const groupTasks = r.entities!.filter((e) => e.servicing && !e.servicing.client.startsWith("won:"));
    const wonOnly = r.entities!.filter((e) => !e.servicing || e.servicing.client.startsWith("won:"));
    expect(groupTasks.length).toBeGreaterThan(0);
    const { onboard, tasks } = billable(wonOnly, H);
    expect(r.hourly.svc!.hours).toBeCloseTo(onboard + tasks, 9);
    expect(billable(groupTasks, H).tasks).toBeGreaterThan(0);
  });

  it("hours nobody of the role was there to work are not billed (a role with nobody has no one to do them)", () => {
    // Ongoing client hours for a won client sit in its shape's `uncovered` when nobody of the role is on the team.
    const m: EngineModel = { ...model({ svc: { servicing: [], fallbackOngoing: { r: 8.66 } } }), roles: { r: { name: "R", count: 2, cost: 50, ongoing: 0 }, q: { name: "Q", count: 1, cost: 50, ongoing: 0 } } };
    const withQ = simulate({ ...m, svc: undefined } as EngineModel, 1, 1);
    expect(withQ.kpi.revenueHourly.mean).toBeGreaterThan(0);
    const noOne: EngineModel = { ...m, services: { svc: { ...m.services!.svc!, fallbackOngoing: { q: 8.66 } } } };
    const r = runOnce(noOne, 1, false);
    // Q has no people, so its 2 hours a week are worked by nobody; only the onboarding hours bill.
    expect(r.hourly.svc!.hours).toBeCloseTo(20, 9);
  });

  it("bills ongoing client hours of a won hourly client while it is active", () => {
    // Fallback load 8.66 hours a month = 2 hours a week per client (LOAD_WEEKS_PER_MONTH 4.33), no servicing.
    const m = model({ svc: { servicing: [], fallbackOngoing: { r: 8.66 } } });
    const r = runOnce(m, 1, true);
    const H = m.horizonWeeks * HPW;
    // Onboarding is 2 hands-on hours a win (stretched in elapsed time by the ongoing load, but billed as worked).
    const onboard = 10 * 2;
    // Win times are in the trace as the end of `decide`.
    const wins = r.entities!.map((e) => e.trace.find((s) => s.step === "decide")!.tL!);
    const ongoing = wins.reduce((a, t) => a + (2 * (H - t)) / HPW, 0);
    expect(r.hourly.svc!.hours).toBeCloseTo(onboard + ongoing, 6);
  });

  it("repeat passes (rework) at an hourly step bill too: they are hours worked", () => {
    const m = model();
    m.steps = m.steps.map((s) => (s.id === "onboard" ? { ...s, rework: 0.5 } : s));
    const r = runOnce(m, 3, true);
    const visits = r.steps.onboard!.handsOnVisits!;
    expect(visits).toBeGreaterThan(10);
    const { onboard } = billable(r.entities!, m.horizonWeeks * HPW);
    expect(onboard).toBe(visits * 2);
  });

  it("is the same with a month-by-month run and without", () => {
    const m = model();
    expect(simulate(m, 3, 1, { monthly: true }).kpi.revenue).toEqual(simulate(m, 3, 1).kpi.revenue);
  });
});

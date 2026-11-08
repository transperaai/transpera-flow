import { describe, expect, it } from "vitest";
import { simulate, type EngineClient, type EngineModel, type EngineService, type EngineStep, type TimeSplit } from "../src";

// Where the time goes (engine 1.14.0), checked by hand on tiny deterministic models: one or two people, constant times, no leads, months
// starting at hours 0, 200 and 400 of a 13-week run (5, 5 and 3 weeks of 40 hours). Every expected number is worked out from the inputs.

const HPW = 40;
const MONTHS = { monthly: true, monthStarts: [200, 400] } as const;
const st = (id: string, next: EngineStep["next"], x: Partial<EngineStep> = {}): EngineStep => ({ id, name: id, role: "r", work: 2, wait: 0, rework: 0, workDist: { kind: "constant" }, next, ...x });
const svc: Record<string, EngineService> = { ret: { name: "ret", pricingModel: "retainer", price: 1000, margin: 0, tenureMonths: 1000, churnMonthly: 0, mixShare: 1, pathTags: [] } };
const client: EngineClient = { name: "Acme", services: ["ret"], mrr: 1000, assignments: { r: "ann" } };

/** Ann alone (40 h a week, role r): 5 items waiting at s1 (2 h, Winning work), then s2 (3 h, the client's job), then won. */
function tiny(x: Partial<EngineModel> = {}): EngineModel {
  return {
    horizonWeeks: 13,
    hoursPerWeek: HPW,
    leadsPerWeek: 0,
    activeClients: 0,
    churnMonthly: 0,
    retainer: 0,
    warmupWeeks: 0,
    roles: { r: { name: "R", count: 1, cost: 50, ongoing: 0 } },
    people: { ann: { name: "Ann", roles: ["r"], capacity: HPW } },
    entry: "s1",
    sinks: { won: "won", lost: "lost" },
    steps: [st("s1", [{ to: "s2", p: 1 }], { purpose: "winning", currentWip: 5 }), st("s2", [{ to: "won", p: 1 }], { purpose: "client_job", work: 3 })],
    ...x,
  };
}
/** No items: only client hours (one retainer client, `ongoing` hours a week for role r, assigned to Ann). */
const upkeep = (ongoing: number, x: Partial<EngineModel> = {}) =>
  tiny({ roles: { r: { name: "R", count: 1, cost: 50, ongoing } }, services: svc, clients: { c: client }, steps: tiny().steps.map((s) => ({ ...s, currentWip: 0 })), ...x });

const means = (s: { mean: number }[]) => s.map((v) => v.mean);
const close = (got: number[], want: number[]) => {
  expect(got.length).toBe(want.length);
  got.forEach((g, i) => expect(g, `month ${i}`).toBeCloseTo(want[i]!, 9));
};
const time = (m: EngineModel, reps = 2) => simulate(m, reps, 1, MONTHS).monthly!.time;
/** purposes + rework + client hours + idle, per month (means). */
const whole = (t: TimeSplit) => t.hours.map((_, m) => Object.values(t.purpose).reduce((a, s) => a + s[m]!.mean, 0) + t.rework[m]!.mean + t.ongoing[m]!.mean + t.idle[m]!.mean);

describe("hand-checked: first-pass hours by purpose", () => {
  it("books each step's hands-on hours to its purpose in the month it is worked; the rest is idle", () => {
    const t = time(tiny());
    for (const s of [t.team, t.roles.r!, t.people.ann!]) {
      close(means(s.purpose.winning!), [10, 0, 0]); // 5 × 2 h
      close(means(s.purpose.client_job!), [15, 0, 0]); // 5 × 3 h
      close(means(s.rework), [0, 0, 0]);
      close(means(s.ongoing), [0, 0, 0]);
      close(means(s.hours), [200, 200, 120]);
      close(means(s.idle), [175, 200, 120]);
      close(whole(s), [200, 200, 120]);
    }
    expect(t.people.ann!.uncovered).toBeNull();
  });

  it("books the time after the per-person factor (Ann 1.5x slower)", () => {
    const t = time(tiny({ people: { ann: { name: "Ann", roles: ["r"], capacity: HPW, capacityFactor: { default: 1.5 } } } }));
    close(means(t.team.purpose.winning!), [15, 0, 0]);
    close(means(t.team.purpose.client_job!), [22.5, 0, 0]);
    close(means(t.team.idle), [162.5, 200, 120]);
  });
});

describe("hand-checked: client upkeep, leave, overtime, hires and leavers", () => {
  it("client hours that are not steps are their own series", () => {
    const t = time(upkeep(4));
    close(means(t.team.ongoing), [20, 20, 12]); // 4 h a week
    close(means(t.team.idle), [180, 180, 108]);
    close(means(t.team.uncovered!), [0, 0, 0]);
  });

  it("leave takes hours off the 100%; client hours nobody else of the role was there to take are uncovered, for the role and the team", () => {
    // Ann away [200, 300): 2.5 of month 1's 5 weeks. Her 4 h a week of client hours in those weeks (10 h) has nobody to go to.
    const t = time(upkeep(4, { people: { ann: { name: "Ann", roles: ["r"], capacity: HPW, leave: [[200, 300]] } } }));
    for (const s of [t.team, t.roles.r!, t.people.ann!]) {
      close(means(s.hours), [200, 100, 120]);
      close(means(s.ongoing), [20, 10, 12]);
      close(means(s.idle), [180, 90, 108]);
      close(whole(s), [200, 100, 120]);
    }
    close(means(t.team.uncovered!), [0, 10, 0]);
    close(means(t.roles.r!.uncovered!), [0, 10, 0]);
  });

  it("with a colleague in the role, the client hours of someone on leave are the colleague's, and nothing is uncovered", () => {
    const t = time(upkeep(4, { people: { ann: { name: "Ann", roles: ["r"], capacity: HPW, leave: [[200, 300]] }, bob: { name: "Bob", roles: ["r"], capacity: 20 } } }));
    close(means(t.people.bob!.ongoing), [0, 10, 0]);
    close(means(t.people.bob!.hours), [100, 100, 60]);
    close(means(t.team.ongoing), [20, 20, 12]);
    close(means(t.team.uncovered!), [0, 0, 0]);
    close(means(t.roles.r!.ongoing), [20, 20, 12]);
  });

  it("overtime is part of the 100%: hours available plus overtime worked, nobody idle", () => {
    // 50 h a week of client hours on a 40-hour week, overtime capped at 25%: 10 h a week of overtime, the rest is over the hours.
    const t = time(upkeep(50, { overtimeCap: 0.25 }));
    close(means(t.team.hours), [250, 250, 150]);
    close(means(t.team.ongoing), [250, 250, 150]);
    close(means(t.team.idle), [0, 0, 0]);
  });

  it("a mid-month leaver and a mid-month hire count only the hours they are there", () => {
    // Ann leaves at hour 300, Bob (20 h a week) starts then.
    const t = time(tiny({ people: { ann: { name: "Ann", roles: ["r"], capacity: HPW, until: 300 }, bob: { name: "Bob", roles: ["r"], capacity: 20, from: 300 } } }));
    close(means(t.people.ann!.hours), [200, 100, 0]);
    close(means(t.people.bob!.hours), [0, 50, 60]);
    close(means(t.team.hours), [200, 150, 60]);
    close(means(t.team.idle), [175, 150, 60]);
  });
});

describe("hand-checked: rework", () => {
  // 20 items at s1 redone half the time: first passes are exactly 20 × 2 h; every further pass at s1 is rework.
  const m = tiny({ steps: [st("s1", [{ to: "s2", p: 1 }], { purpose: "fixing", currentWip: 20, rework: 0.5 }), st("s2", [{ to: "won", p: 1 }], { purpose: "client_job", work: 3 })] });

  it("first passes keep their purpose and every repeat pass is rework, in one replication exactly", () => {
    const r = simulate(m, 1, 1, MONTHS);
    const t = r.monthly!.time.team;
    close(means(t.purpose.fixing!), [40, 0, 0]);
    close(means(t.purpose.client_job!), [60, 0, 0]);
    // Every pass at s1 is a departure; the ones beyond the 20 first passes are the repeats.
    close(means(t.rework), [2 * (r.steps.s1!.departures - 20), 0, 0]);
    expect(t.rework[0]!.mean).toBeGreaterThan(0);
    // withRework is the key's hours plus the rework.
    close(means(t.withRework.fixing!), [40 + t.rework[0]!.mean, 0, 0]);
  });

  it("over replications, withRework is the range of the sum (not the two ranges added)", () => {
    const t = time(m, 30).team;
    const sum = t.withRework.fixing![0]!;
    expect(sum.mean).toBeCloseTo(t.purpose.fixing![0]!.mean + t.rework[0]!.mean, 9);
    // The first passes don't vary, so the sum's range is the rework's shifted by 40 h.
    expect(sum.p10).toBeCloseTo(40 + t.rework[0]!.p10, 9);
    expect(sum.p90).toBeCloseTo(40 + t.rework[0]!.p90, 9);
  });
});

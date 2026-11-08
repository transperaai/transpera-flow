import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { northbeamRoleIds, sandboxLever, type SandboxChange } from "@transpera-flow/db";
import { applyPatches, headcount } from "@transpera-flow/engine";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { forecastModel } from "@/lib/forecast/forecast";
import { describeChange } from "@/lib/sandbox/describe";
import { patchOf } from "@transpera-flow/db";
import { partMonthNote, timelineMonths } from "@/lib/forecast/timeline";
import { calendarMonthStarts, monthBounds, channelsOf, scenarioModel } from "@transpera-flow/db/sandbox";
import { explainFull } from "@/lib/sandbox/explain";
import { othersTotal, shareToWeight, weightToShare } from "@/lib/sandbox/traffic";
import { todayValue, trafficToday } from "@/lib/sandbox/today";

// Polish from the Sandbox click-through (see the commits on branch sandbox-polish): pure logic, a case group per item. The page's own
// behaviour is in sandbox-browser.test.ts.

const bundle = demoForecastBundle();
const model = forecastModel(bundle, 12, DEMO_FORECAST_START).model!;
const SEO = "80000000-0000-4000-8000-000000000001";
const PPC_SERVICE = "80000000-0000-4000-8000-000000000002";
const lever = (id: string) => sandboxLever(id)!;

describe("1. today's value in the change dialog", () => {
  it("reads each lever's value from the live model the runs use", () => {
    expect(todayValue(lever("A1"), null, model, "GBP")).toBe(`about ${Math.round(model.leadsPerWeek * (52 / 12))} opportunities a month`);
    expect(todayValue(lever("A1"), null, model, "GBP")).toBe("about 30 opportunities a month");
    expect(todayValue(lever("B2"), SEO, model, "GBP")).toBe("£3,500 a month");
    expect(todayValue(lever("B2"), PPC_SERVICE, model, "GBP")).toBe("£4,200 a month");
    expect(todayValue(lever("B1"), null, model, "GBP")).toBe("29 clients");
    expect(todayValue(lever("B3"), null, model, "GBP")).toMatch(/^\d+(\.\d)?% a month$/);
    expect(todayValue(lever("D5"), northbeamRoleIds.ppc, model, "GBP")).toBe("3 people");
    expect(todayValue(lever("D1"), northbeamRoleIds.strat, model, "GBP")).toBe("1 person");
    expect(todayValue(lever("E1"), model.steps[0]!.id, model, "GBP")).toMatch(/^[\d.]+ hours of hands-on time$/);
  });

  it("names the role or step a selector picks", () => {
    expect(todayValue(lever("D5"), "@busiest", model, "GBP")).toMatch(/^\d+ (person|people) \(.+\)$/);
    expect(todayValue(lever("E1"), "@heaviest", model, "GBP")).toMatch(/hands-on time \(.+\)$/);
  });

  it("matches what the runner starts from: setting the lever to today's value changes nothing", () => {
    const same = applyPatches(model, [{ path: `roles.${northbeamRoleIds.ppc}.headcount`, op: "set", value: 3 }]);
    expect(Object.keys(same.model.people!)).toEqual(Object.keys(model.people!));
    expect(headcount(model, northbeamRoleIds.ppc)).toBe(3);
    expect(todayValue(lever("A1"), null, applyPatches(model, [{ path: "demand.leads_per_week", op: "multiply", value: 2 }]).model, "GBP")).toBe("about 61 opportunities a month");
  });

  it("never shows a person's pay, and says nothing for a lever that stores one", () => {
    const person = Object.keys(model.people!)[0]!;
    const paid = { ...model, people: { ...model.people!, [person]: { ...model.people![person]!, cost: 123456 } } };
    for (const l of ["A1", "B1", "B2", "B3", "C2", "D1", "D2", "D4", "D5", "E1", "E2", "E3"]) {
      const text = todayValue(lever(l), l === "D2" || l === "D4" ? person : l === "D1" || l === "D5" ? northbeamRoleIds.ppc : l.startsWith("E") ? model.steps[0]!.id : l === "B2" ? SEO : null, paid, "GBP") ?? "";
      expect(text, l).not.toContain("123");
    }
    expect(todayValue({ ...lever("D4"), pay: "individual" }, person, model, "GBP")).toBeNull();
    expect(todayValue(lever("D4"), person, model, "GBP")).toMatch(/^[\d.]+ FTE$/);
  });

  it("has nothing to say for a leave, a solution or a missing target", () => {
    expect(todayValue(lever("D3"), Object.keys(model.people!)[0]!, model, "GBP")).toBeNull();
    expect(todayValue(lever("E6"), "x", model, "GBP")).toBeNull();
    expect(todayValue(lever("D5"), "gone", model, "GBP")).toBeNull();
  });
});

describe("1b. today's value for the phase 3 levers", () => {
  const driver = (m: typeof model, patch: Record<string, unknown>) => ({ ...m, churnDrivers: [{ id: "late", weight: 1, enabled: true, ...patch }] }) as typeof model;

  it("reads a fee range, a driver's chance and effect, a price, hours available and the hiring delay", () => {
    expect(todayValue(lever("A5"), SEO, model, "GBP")).toBe("£3,500 a month, no range");
    const ranged = { ...model, services: { ...model.services!, [SEO]: { ...model.services![SEO]!, priceRange: { low: 3000, high: 6000 } } } };
    expect(todayValue(lever("A5"), SEO, ranged, "GBP")).toBe("£3,000 – £3,500 – £6,000 a month");
    expect(todayValue(lever("B5"), SEO, model, "GBP")).toBe("£3,500 a month");
    expect(todayValue(lever("D6"), northbeamRoleIds.ppc, model, "GBP")).toMatch(/^[\d.]+ FTE across 3 people$/);
    expect(todayValue(lever("D6"), null, model, "GBP")).toMatch(/^[\d.]+ FTE across \d+ people$/);
    expect(todayValue(lever("D9"), null, model, "GBP")).toBe("none: new hires start on their date");
    expect(todayValue(lever("D9"), null, model, "GBP", { hireDelayMonths: 2 })).toBe("2 months");
    expect(todayValue(lever("A3"), null, model, "GBP", { conversion: 0.284 })).toBe("about 28% of finished opportunities sign");
    expect(todayValue(lever("A3"), null, model, "GBP")).toBeNull();
    expect(todayValue(lever("B4"), "late", driver(model, {}), "GBP", { causes: [{ id: "late", chance: 0.042 } as never] })).toBe("Late or missed servicing work: counted by its weight (1), measured chance 4.2% a month");
    expect(todayValue(lever("B4"), "late", driver(model, { chance: 0.1, effect: 0.5, effectMonths: 2 }), "GBP")).toBe("Late or missed servicing work: 10% chance a month, raises churn 50% for 2 months");
    expect(todayValue(lever("B4"), "late", driver(model, { enabled: false }), "GBP")).toBe("Late or missed servicing work: switched off");
    expect(todayValue(lever("B4"), "nonsense", model, "GBP")).toBeNull();
  });

  it("names a role's rate (C1) and no one's pay", () => {
    const paid = { ...model, people: Object.fromEntries(Object.entries(model.people!).map(([id, p]) => [id, { ...p, cost: 98765 }])) };
    for (const l of ["A3", "A5", "B4", "B5", "D6", "D9"]) expect(todayValue(lever(l), l === "A5" || l === "B5" ? SEO : l === "D6" ? northbeamRoleIds.ppc : l === "B4" ? "late" : null, paid, "GBP", { conversion: 0.3 }) ?? "", l).not.toContain("987");
    expect(todayValue(lever("C1"), northbeamRoleIds.ppc, model, "GBP")).toMatch(/an hour$/);
  });
});

describe("2. traffic by type as percentages", () => {
  const mix = Object.fromEntries(Object.entries(model.services!).map(([id, s]) => [id, s.mixShare]));

  it("shows the current split", () => {
    expect(trafficToday(model)).toBe("SEO retainer 55%, PPC management 45%");
    expect(todayValue(lever("A6"), SEO, model, "GBP")).toBe("SEO retainer 55%, PPC management 45%");
    expect(trafficToday({ services: { a: model.services![SEO]! } })).toBeNull();
  });

  it("round-trips a percentage to a weight and back", () => {
    for (const others of [0.45, 1, 7.3, 250]) {
      for (const percent of [0, 1, 12.5, 33.3, 40, 55, 80, 99]) {
        const weight = shareToWeight(percent / 100, others)!;
        expect(weight, `${percent}% of ${others}`).not.toBeNull();
        expect(Math.round(weightToShare(weight, others) * 1000) / 10).toBeCloseTo(percent, 0);
        expect(weightToShare(weight, others)).toBeCloseTo(percent / 100, 4);
      }
    }
    expect(shareToWeight(0.4, 0.45)).toBe(0.3);
    expect(shareToWeight(1, 0.45)).toBeNull();
    expect(shareToWeight(0.4, 0)).toBeNull();
    expect(shareToWeight(0, 0)).toBe(0);
    expect(othersTotal(mix, SEO)).toBe(0.45);
  });

  it("makes the engine give the type that share, the others keeping their proportions to one another", () => {
    const three = { ...model.services!, extra: { ...model.services![PPC_SERVICE]!, name: "Extra", mixShare: 0.2 } };
    const m3 = { ...model, services: three };
    const mix3 = Object.fromEntries(Object.entries(three).map(([id, s]) => [id, s.mixShare]));
    const weight = shareToWeight(0.4, othersTotal(mix3, SEO))!;
    const after = applyPatches(m3, [{ path: `services.${SEO}.mix_share`, op: "set", value: weight }]).model.services!;
    const total = Object.values(after).reduce((a, s) => a + s.mixShare, 0);
    expect(after[SEO]!.mixShare / total).toBeCloseTo(0.4, 6);
    // The other two still split the rest 45 : 20.
    expect(after[PPC_SERVICE]!.mixShare / after.extra!.mixShare).toBeCloseTo(0.45 / 0.2, 6);
  });

  it("works when timed: the mix channel holds the weight for the share asked, from its month, and nothing before", () => {
    const live = scenarioModel(bundle, 12, DEMO_FORECAST_START);
    const m = live.model!;
    const bounds = monthBounds(live.monthStarts!, m.horizonWeeks * m.hoursPerWeek);
    const weight = shareToWeight(0.7, othersTotal(mix, SEO))!;
    const change: SandboxChange = { id: randomUUID(), lever: "A6", target: SEO, op: "set", value: weight, from: "2027-03" };
    const { channels, problems } = channelsOf(m, [change], { bundle, bounds, startDate: DEMO_FORECAST_START, hoursPerWeek: m.hoursPerWeek, d4Unhandled: new Set() });
    expect(problems).toEqual([]);
    const seo = channels!.mix![SEO]!;
    const other = m.services![PPC_SERVICE]!.mixShare;
    const first = seo.findIndex((w) => w === weight);
    expect(first).toBeGreaterThan(0);
    expect(seo.slice(0, first).every((w) => w === m.services![SEO]!.mixShare)).toBe(true);
    expect(seo[seo.length - 1]! / (seo[seo.length - 1]! + other)).toBeCloseTo(0.7, 6);
    // The change list words it as a share for a timed change too.
    expect(describeChange(change, { bundle, solutions: [], changes: [change], mix })).toContain("70%");
  });

  it("reads a saved set change as '→ 40%' in the change list, and a weight of another kind as before", () => {
    const set: SandboxChange = { id: randomUUID(), lever: "A6", target: SEO, op: "set", value: 0.3 };
    const ctx = { bundle, solutions: [], changes: [set], mix };
    expect(describeChange(set, ctx)).toBe("Traffic by type, SEO retainer → 40%");
    expect(patchOf(set)).toEqual({ path: `services.${SEO}.mix_share`, op: "set", value: 0.3 });
    expect(describeChange({ ...set, op: "multiply", value: 1.5 }, ctx)).toBe("Traffic by type, SEO retainer ×1.5");
    // Without the model's weights the bundle's active services are the others.
    expect(describeChange(set, { bundle, solutions: [], changes: [set] })).toMatch(/→ \d+(\.\d)?%$/);
  });

  it("offers only 'Set to' for a new change", () => {
    expect(Object.keys(lever("A6").range)).toEqual(["set"]);
  });
});

describe("3. explaining a result that looks worse because someone is full", () => {
  const stat = (mean: number) => ({ mean, p10: mean, p90: mean });
  const busy = (...means: (number | null)[]) => means.map((m) => (m === null ? null : { ...stat(m), capacity: 40, work: 40 * m }));
  const run = (o: { strat: (number | null)[]; dan?: (number | null)[]; lost: number[]; won: number[] }) => ({
    roles: { strat: busy(...o.strat), sales: busy(0.5, 0.5, 0.5, 0.5) },
    people: { dan: busy(...(o.dan ?? [0.5, 0.5, 0.5, 0.5])) },
    clientsLost: o.lost.map(stat),
    sales: { opportunities: [], won: o.won.map(stat), lost: [], conversion: [] },
  });
  const live = run({ strat: [0.7, 0.7, 0.7, 0.7], lost: [6, 6, 7, 7], won: [10, 10, 10, 10] });
  const monthNames = ["January 2027", "February 2027", "March 2027", "April 2027"];
  const roles = { strat: { name: "Strategist" }, sales: { name: "Sales" } };
  const input = (scenario: ReturnType<typeof run>, extra: Partial<Parameters<typeof explainFull>[0]> = {}) => ({ live, scenario, monthNames, roles, people: {}, ...extra });

  it("says who is full, from when, and what got worse (38 against 26)", () => {
    const scenario = run({ strat: [0.8, 0.9, 1, 1], lost: [8, 9, 10, 11], won: [10, 10, 9, 8] });
    const [note, ...rest] = explainFull(input(scenario));
    expect(rest).toEqual([]);
    expect(note!.text).toBe("The strategist role is full from March 2027, so new work waits and more clients leave (38 against 26 with no changes) and fewer deals are won (37 against 40 with no changes).");
    expect(note!.hireRoleId).toBe("strat");
    expect(note!.month).toBe(2);
  });

  it("says only what got worse", () => {
    expect(explainFull(input(run({ strat: [1, 1, 1, 1], lost: [6, 6, 7, 7], won: [8, 8, 8, 8] })))[0]!.text).toBe(
      "The strategist role is full from January 2027, so new work waits and fewer deals are won (32 against 40 with no changes).",
    );
    expect(explainFull(input(run({ strat: [1, 1, 1, 1], lost: [9, 9, 9, 9], won: [10, 10, 10, 10] })))[0]!.text).toMatch(/so new work waits and more clients leave \(36 against 26 with no changes\)\.$/);
  });

  it("says nothing when nobody is full, when it is full no sooner than before, or when nothing got worse", () => {
    expect(explainFull(input(run({ strat: [0.8, 0.9, 0.95, 0.9], lost: [9, 9, 9, 9], won: [5, 5, 5, 5] })))).toEqual([]);
    expect(explainFull(input(run({ strat: [1, 1, 1, 1], lost: [5, 5, 6, 6], won: [11, 11, 11, 11] })))).toEqual([]);
    // Full in the live forecast too, from the same month.
    const fullLive = { ...live, roles: { ...live.roles, strat: busy(1, 1, 1, 1) } };
    expect(explainFull({ ...input(run({ strat: [1, 1, 1, 1], lost: [9, 9, 9, 9], won: [5, 5, 5, 5] })), live: fullLive })).toEqual([]);
    // Full sooner than live: counts.
    expect(explainFull({ ...input(run({ strat: [1, 1, 1, 1], lost: [9, 9, 9, 9], won: [5, 5, 5, 5] })), live: { ...live, roles: { ...live.roles, strat: busy(0.9, 1, 1, 1) } } })).toHaveLength(1);
  });

  it("names a person who is full when their role is not named, only if the reader may see them", () => {
    const scenario = run({ strat: [0.8, 0.8, 0.8, 0.8], dan: [0.9, 1, 1, 1], lost: [9, 9, 9, 9], won: [10, 10, 10, 10] });
    const dan = { dan: { name: "Dan Okafor", roles: ["sales"] } };
    expect(explainFull(input(scenario, { people: dan }))[0]).toMatchObject({ text: expect.stringMatching(/^Dan Okafor is full from February 2027, so new work waits and more clients leave/) as unknown as string, hireRoleId: "sales", month: 1 });
    expect(explainFull(input(scenario, { people: {} }))).toEqual([]);
    // The person's role is named already: one sentence.
    const both = run({ strat: [1, 1, 1, 1], dan: [1, 1, 1, 1], lost: [9, 9, 9, 9], won: [10, 10, 10, 10] });
    expect(explainFull(input(both, { people: { dan: { name: "Dan Okafor", roles: ["strat"] } } }))).toHaveLength(1);
  });

  it("keeps acronyms in a role's name and limits the sentences", () => {
    const r = { ...roles, ppc: { name: "PPC specialist" } };
    const scenario = { ...run({ strat: [1, 1, 1, 1], lost: [9, 9, 9, 9], won: [10, 10, 10, 10] }), roles: { strat: busy(1, 1, 1, 1), sales: busy(1, 1, 1, 1), ppc: busy(1, 1, 1, 1) } };
    const notes = explainFull({ ...input(scenario), roles: r, live: { ...live, roles: { strat: busy(0.5), sales: busy(0.5), ppc: busy(0.5) } } });
    expect(notes).toHaveLength(2);
    expect(explainFull({ ...input(scenario), roles: r, limit: 3, live: { ...live, roles: { strat: busy(0.5), sales: busy(0.5), ppc: busy(0.5) } } }).map((n) => n.text.split(" is full")[0])).toEqual(["The strategist role", "The sales role", "The PPC specialist role"]);
  });
});

describe("6. part months are labelled", () => {
  const monthsOf = (start: string, weeks: number) => {
    const starts = calendarMonthStarts(start, weeks, 40);
    const H = weeks * 40;
    return [0, ...starts].map((s, i, all) => ({ start: s, end: all[i + 1] ?? H }));
  };

  it("marks the first column as starting today, and the last as stopping where the run does", () => {
    const m = timelineMonths("2026-10-05", monthsOf("2026-10-05", 26), 40);
    expect(m.map((x) => x.label)).toEqual(["October 2026 (from 5 Oct)", "November 2026", "December 2026", "January 2027", "February 2027", "March 2027 (to 2 Apr)"]);
    expect(m[0]).toMatchObject({ partial: true, span: "from 5 Oct", from: "2026-10-05", to: "2026-10-30", long: "October 2026", short: "Oct 26" });
    expect(m[1]).toMatchObject({ partial: false, span: null, label: "November 2026", from: "2026-11-02", to: "2026-11-30" });
    expect(m[5]).toMatchObject({ partial: true, span: "to 2 Apr", to: "2027-04-02" });
    expect(partMonthNote(m)).toBe("Part months: the first column covers from 5 Oct, the last column covers to 2 Apr; the others are whole months.");
  });

  it("names a first month that joined the next one by what it covers: 'Nov 26 (from 28 Oct)'", () => {
    const m = timelineMonths("2026-10-28", monthsOf("2026-10-28", 13), 40);
    expect(m[0]).toMatchObject({ long: "November 2026", short: "Nov 26", span: "from 28 Oct", label: "November 2026 (from 28 Oct)" });
  });

  it("marks nothing when the run starts on a month's first working day and stops on a last one", () => {
    // Mon 2 Nov 2026 is the first working day of November; 26 weeks later the run ends on Fri 30 Apr 2027, the last of April.
    const m = timelineMonths("2026-11-02", monthsOf("2026-11-02", 26), 40);
    expect(m.map((x) => x.partial)).toEqual([false, false, false, false, false, false]);
    expect(partMonthNote(m)).toBeNull();
    expect(m.map((x) => x.label)).toEqual(m.map((x) => x.long));
  });

  it("says both in one column when the run is a single part month", () => {
    const m = timelineMonths("2026-10-05", monthsOf("2026-10-05", 3), 40);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ span: "from 5 Oct to 23 Oct", label: "October 2026 (from 5 Oct to 23 Oct)" });
  });
});

describe("7. Viewer wording", () => {
  const leah = bundle.people.find((p) => p.name === "Leah Brooks")!;
  const dan = bundle.people.find((p) => p.name === "Dan Okafor")!;
  const leave: SandboxChange = { id: randomUUID(), lever: "D3", target: leah.id, op: "set", value: 2, from: "2027-02-08" };
  /** The bundle as `team_capacity` hands it to a Viewer linked to Dan: his name, "Team member N" for everyone else. */
  const labelled = {
    ...bundle,
    viewer: { seesEveryone: false, ownPersonId: dan.id },
    people: bundle.people.map((p, i) => (p.id === dan.id ? p : { ...p, name: `Team member ${i + 1}`, cost_rate: null })),
  };

  it("names a person in the change list as the rest of the page does (the model's name), not 'A team member'", () => {
    const ctx = { bundle: labelled, solutions: [], changes: [leave] };
    const inModel = forecastModel(labelled, 12, DEMO_FORECAST_START).model!.people![leah.id]!.name;
    expect(inModel).toBe("Team member 4");
    expect(describeChange(leave, ctx)).toBe(`${inModel} on leave for 2 weeks`);
    expect(describeChange({ ...leave, target: dan.id }, ctx)).toBe("Dan Okafor on leave for 2 weeks");
  });

  it("labels a bundle the database did not label by position, so a Viewer never reads a real name or 'A team member'", () => {
    const raw = { ...bundle, viewer: { seesEveryone: false, ownPersonId: dan.id } };
    expect(describeChange(leave, { bundle: raw, solutions: [], changes: [leave] })).toBe("Team member 4 on leave for 2 weeks");
    // Someone who sees everyone reads names.
    expect(describeChange(leave, { bundle, solutions: [], changes: [leave] })).toBe("Leah Brooks on leave for 2 weeks");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { HeaviestSteps, HoursByRole, SupportingHeadline } from "@/components/process-supporting-data";
import { headlineText, hoursStrip, pieSlices, processHeadline, processHours, stripHeadline, type DepartmentMap } from "@/lib/process-page/hours";

// The Supporting data's hours (Q3 item 5), worked out by hand from a run's `personTime.stepHours`.
//
//   steps    s1 Draft   (role Director, split 50 / 30 / 20)      in this process
//            s2 Review  (role Executor, no split)                in this process
//            s4 Plan    (role Director)                          in another process
//            s3 Report  (role Exec2)                             in another process
//   people   Ann (Director), Bob and Cy (Executor), Dee (Exec2)
//   hours    Ann: s1 100, s4 150    Bob: s2 200    Cy: s2 50    Dee: s3 300
//
// This process (s1, s2): 100 + 200 + 50 = 350 h a month. By role: Executor 250 (Bob 200, Cy 50), Director 100 (Ann 100).
// By step: Review 250, Draft 100. Automatable: only Draft has a split, 100 × 0.5 = 50 h of 350 = 14.3%.

const model = {
  roles: { dir: { name: "Director" }, exe: { name: "Executor" }, ex2: { name: "Exec2" } },
  people: { ann: { name: "Ann", roles: ["dir"] }, bob: { name: "Bob", roles: ["exe"] }, cy: { name: "Cy", roles: ["exe"] }, dee: { name: "Dee", roles: ["ex2"] } },
  steps: [
    { id: "s1", name: "Draft", role: "dir", split: { automatable: 0.5, augmentable: 0.3, manual: 0.2 } },
    { id: "s2", name: "Review", role: "exe" },
    { id: "s4", name: "Plan", role: "dir" },
    { id: "s3", name: "Report", role: "ex2" },
  ],
} as unknown as EngineModel;

const run = (stepHours: Record<string, Record<string, number>>) =>
  ({ personTime: { stepHours, clients: {} }, resolvedPeople: { ann: { name: "Ann" }, bob: { name: "Bob" }, cy: { name: "Cy" }, dee: { name: "Dee" } } }) as unknown as SimulationResult;
const result = run({ ann: { s1: 100, s4: 150 }, bob: { s2: 200 }, cy: { s2: 50 }, dee: { s3: 300 } });
const mine = new Set(["s1", "s2"]);

describe("processHours", () => {
  const h = processHours(model, result, mine)!;
  it("totals this process's steps only", () => {
    expect(h.total).toBe(350);
  });
  it("groups by role, largest first, with each role's people", () => {
    expect(h.roles.map((r) => [r.label, r.hours])).toEqual([["Executor", 250], ["Director", 100]]);
    expect(h.roles[0]!.people.map((p) => [p.name, p.hours])).toEqual([["Bob", 200], ["Cy", 50]]);
    expect(h.roles[1]!.people.map((p) => [p.name, p.hours])).toEqual([["Ann", 100]]);
  });
  it("ranks the steps by hours, with their split", () => {
    expect(h.steps.map((s) => [s.label, s.hours])).toEqual([["Review", 250], ["Draft", 100]]);
    expect(h.steps[0]!.split).toBeNull();
    expect(h.steps[1]!.split).toEqual({ automatable: 0.5, augmentable: 0.3, manual: 0.2 });
  });
  it("is null with no run, or a run that was not asked for personTime", () => {
    expect(processHours(model, null, mine)).toBeNull();
    expect(processHours(model, { resolvedPeople: {} } as unknown as SimulationResult, mine)).toBeNull();
  });
  it("counts an hour of a step with no role under the person's first role", () => {
    const noRole = { ...model, steps: model.steps.map((s) => (s.id === "s2" ? { ...s, role: null } : s)) } as unknown as EngineModel;
    expect(processHours(noRole, result, mine)!.roles.map((r) => [r.label, r.hours])).toEqual([["Executor", 250], ["Director", 100]]);
  });
});

describe("the headline", () => {
  const organic: DepartmentMap = { names: { org: "Organic", perf: "Performance" }, ofRole: { dir: "org", exe: "org", ex2: "perf" } };

  it("says the hours, the share of the one department's hours, and the automatable share", () => {
    // Organic's hours in the run: Draft 100 + Review 250 + Plan 150 = 500. 350 / 500 = 70%. Automatable 50 / 350 = 14.3%.
    const h = processHeadline(model, result, mine, organic)!;
    expect(h).toMatchObject({ hours: 350, department: "Organic" });
    expect(h.share).toBeCloseTo(0.7, 9);
    expect(h.automatable).toBeCloseTo(50 / 350, 9);
    expect(headlineText(h)).toBe("This process takes 350 h a month, 70% of Organic's time; about 14% of it is automatable.");
  });

  it("uses the whole business's hours when the work spans departments", () => {
    // Every hour in the run: 100 + 150 + 200 + 50 + 300 = 800. 350 / 800 = 43.75%.
    const spans: DepartmentMap = { names: organic.names, ofRole: { dir: "org", exe: "perf", ex2: "perf" } };
    expect(headlineText(processHeadline(model, result, mine, spans)!)).toBe("This process takes 350 h a month, 44% of the whole business's time; about 14% of it is automatable.");
  });

  it("uses the whole business's hours when no department is known", () => {
    const h = processHeadline(model, result, mine, null)!;
    expect(h.department).toBeNull();
    expect(h.share).toBeCloseTo(350 / 800, 9);
  });

  it("leaves out the automatable clause when no step has a split", () => {
    const bare = { ...model, steps: model.steps.map(({ id, name, role }) => ({ id, name, role })) } as unknown as EngineModel;
    const h = processHeadline(bare, result, mine, organic)!;
    expect(h.automatable).toBeNull();
    expect(headlineText(h)).toBe("This process takes 350 h a month, 70% of Organic's time.");
  });

  it("writes small hours with a decimal, and a tiny share as less than 1%", () => {
    expect(headlineText({ hours: 4.25, share: 0.003, department: null, automatable: null })).toBe("This process takes 4.3 h a month, less than 1% of the whole business's time.");
  });

  it("is null with nothing to show", () => {
    expect(processHeadline(model, null, mine, organic)).toBeNull();
    expect(processHeadline(model, result, new Set(["nope"]), organic)).toBeNull();
  });
});

describe("the panels", () => {
  const hours = processHours(model, result, mine);
  const headline = processHeadline(model, result, mine, null);

  it("render the headline, the total, a donut per role opening to people, and the strip of hours by step", () => {
    const html = renderToStaticMarkup(
      createElement("div", null, [
        createElement(SupportingHeadline, { key: 1, headline, result }),
        createElement(HoursByRole, { key: 2, hours, result }),
        createElement(HeaviestSteps, { key: 3, hours, result }),
      ]),
    );
    expect(html).toContain("This process takes 350 h a month");
    expect(html).toContain("350 h a month");
    expect(html).toContain("Executor");
    expect(html).toContain("Bob");
    expect(html).toContain("<details");
    // A donut with a summary for a screen reader, a slice per role with its numbers on hover, and the legend as text.
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Hours a month by role, 350 h in all: /);
    expect(html).toContain("data-pie-slice");
    expect(html).toMatch(/<title>Executor: \d+ h a month, \d+%<\/title>/);
    expect(html).toContain("Review");
    // Heaviest steps: one strip of the 350 h, Review 250 (71%) and Draft 100 (29%), each segment with its numbers on hover.
    expect(html).toContain("Review takes 71% of the 350 h a month.");
    expect(html).toMatch(/<div role="img" aria-label="The process&#x27;s 350 h a month by step: Review: 250 h a month, 71% of the process; Draft: 100 h a month, 29% of the process\."/);
    expect(html).toContain('title="Review: 250 h a month, 71% of the process"');
    expect(html.match(/data-strip-segment=/g)).toHaveLength(2);
    // The per-step work split is gone from this panel (it is on the step).
    expect(html).not.toContain("data-split-bar");
    expect(html).not.toContain("Show all");
  });

  it("fold the roles past the sixth into Others, largest first, naming them on hover", () => {
    const roles = [120, 80, 60, 40, 25, 15, 6, 4].map((h, i) => ({ id: `r${i}`, label: `Role ${i + 1}`, hours: h, people: [] }));
    const slices = pieSlices(roles);
    expect(slices.map((s) => s.label)).toEqual(["Role 1", "Role 2", "Role 3", "Role 4", "Role 5", "Role 6", "Others"]);
    expect(slices.at(-1)!.hours).toBe(10);
    expect(slices.at(-1)!.members.map((m) => m.label)).toEqual(["Role 7", "Role 8"]);
    expect(slices.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 9);
    // One leftover role keeps its own slice; no hours, no slices.
    expect(pieSlices(roles.slice(0, 7)).map((s) => s.label)).not.toContain("Others");
    expect(pieSlices([])).toEqual([]);
    const html = renderToStaticMarkup(createElement(HoursByRole, { hours: { total: 350, roles, steps: [], cells: [] }, result }));
    expect(html).toContain("<title>Others: 10 h a month, 3% (Role 7 6 h, Role 8 4 h)</title>");
    expect(html).toContain("and 4 more");
  });

  it("name the four heaviest steps on the strip and group the rest as N other steps, listed on hover and when opened", () => {
    const many = { total: 100, roles: [], cells: [], steps: [38, 29, 24, 19, 16, 12, 10, 8].map((h, i) => ({ id: `s${i}`, label: `Step ${i}`, hours: h, split: null })) };
    const strip = hoursStrip(many)!;
    expect(strip.total).toBe(156);
    expect(strip.segments.map((x) => [x.label, x.hours])).toEqual([["Step 0", 38], ["Step 1", 29], ["Step 2", 24], ["Step 3", 19], ["4 other steps", 46]]);
    // 38 + 29 = 67 < 78 (half), + 24 = 91: three steps take 58%.
    expect(strip.lead.steps).toHaveLength(3);
    expect(stripHeadline(strip)).toBe("3 steps take 58% of the 156 h a month.");
    const html = renderToStaticMarkup(createElement(HeaviestSteps, { hours: many, result }));
    expect(html).toContain("3 steps take 58% of the 156 h a month.");
    expect(html).toContain('title="4 other steps: 46 h a month, 29% of the process (Step 4 16 h, Step 5 12 h, Step 6 10 h, Step 7 8 h)"');
    expect(html.match(/data-other-step=/g)).toHaveLength(4);
    expect(html).toContain("How this works");
  });

  it("keep a single leftover step by name, and word one step and a spread-out process plainly", () => {
    const steps = (hs: number[]) => ({ steps: hs.map((h, i) => ({ id: `s${i}`, label: `Step ${i}`, hours: h, split: null })) });
    expect(hoursStrip(steps([5, 4, 3, 2, 1]))!.segments.map((x) => x.label)).toEqual(["Step 0", "Step 1", "Step 2", "Step 3", "Step 4"]);
    expect(stripHeadline(hoursStrip(steps([12]))!)).toBe("One step, Step 0, takes all 12 h a month.");
    expect(stripHeadline(hoursStrip(steps([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]))!)).toBe("The 4 heaviest steps take 40% of the 100 h a month.");
    expect(hoursStrip(steps([]))).toBeNull();
    expect(hoursStrip(null)).toBeNull();
  });

  it("say what is missing instead of an empty chart", () => {
    expect(renderToStaticMarkup(createElement(HoursByRole, { hours: null, result: null }))).toContain("Simulating");
    expect(renderToStaticMarkup(createElement(SupportingHeadline, { headline: null, result }))).toContain("No work reached a step in this run.");
  });
});

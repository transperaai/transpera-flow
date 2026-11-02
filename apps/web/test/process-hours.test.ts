import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { HeaviestSteps, HoursByRole, SupportingHeadline } from "@/components/process-supporting-data";
import { headlineText, processHeadline, processHours, type DepartmentMap } from "@/lib/process-page/hours";

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

  it("render the headline, the total, a bar per role opening to people, and the steps with their split", () => {
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
    expect(html).toContain("Review");
    expect(html).toContain("data-split-bar");
    expect(html).toContain("No work split yet");
    expect(html).not.toContain("Show all");
  });

  it("show at most ten steps, with Show all for the rest", () => {
    const many = { total: 11, roles: [], cells: [], steps: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, label: `Step ${i}`, hours: 12 - i, split: null })) };
    const html = renderToStaticMarkup(createElement(HeaviestSteps, { hours: many, result }));
    expect(html.match(/data-heavy-step/g)).toHaveLength(10);
    expect(html).toContain("Show all 12");
  });

  it("say what is missing instead of an empty chart", () => {
    expect(renderToStaticMarkup(createElement(HoursByRole, { hours: null, result: null }))).toContain("Simulating");
    expect(renderToStaticMarkup(createElement(SupportingHeadline, { headline: null, result }))).toContain("No work reached a step in this run.");
  });
});

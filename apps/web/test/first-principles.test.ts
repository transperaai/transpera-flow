import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, toEngineModel } from "@transpera-flow/db";
import {
  emptyFirstPrinciples,
  firstPrinciplesFlags,
  measuresMetToday,
  normalizeFirstPrinciples,
  simulate,
  successMeasureSource,
  type FirstPrinciples,
} from "@transpera-flow/engine";
import { FirstPrinciplesCard } from "@/components/first-principles/first-principles-card";
import { getDemoFirstPrinciples, setDemoFirstPrinciples } from "@/lib/first-principles/demo-store";
import { demoFirstPrinciples } from "@/lib/first-principles/demo-seed";
import { rerate } from "@/lib/rules/edit";
import { demoBundle } from "@/lib/sources/demo";
import { publishableChanges } from "@/lib/drafts/diff";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// First principles in the app (issue #119, A54): the demo's worked example, the summary card on the process page, and
// success measures feeding the "goals met" rule in the insights.

const bundle = demoBundle();
const model = toEngineModel(bundle);
const result = simulate(model, 10, 1);
const ctx = {
  steps: bundle.steps.map((s) => ({ id: s.id, name: s.name })),
  people: bundle.people.map((p) => ({ id: p.id, name: p.name })),
  roles: bundle.roles.map((r) => ({ name: r.name })),
};

const card = (doc: FirstPrinciples | null, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(FirstPrinciplesCard, { bundle, doc, model, result, href: "/demo/p/x/first-principles", canEdit: true, ...over }));

describe("the demo's worked example", () => {
  const seed = demoFirstPrinciples();

  it("is clean, whole answers", () => {
    expect(normalizeFirstPrinciples(JSON.parse(JSON.stringify(seed)))).toEqual(seed);
  });

  it("points at steps and people the Northbeam sample has", () => {
    const steps = new Set(bundle.steps.map((s) => s.id));
    const people = new Set(bundle.people.map((p) => p.id));
    for (const r of seed.requirements) {
      if (r.step_id) expect(steps.has(r.step_id), r.text).toBe(true);
      if (r.owner_person_id) expect(people.has(r.owner_person_id), r.text).toBe(true);
    }
    for (const d of seed.deletes) {
      expect(steps.has(d.step_id)).toBe(true);
      if (d.agreed_by) expect(people.has(d.agreed_by)).toBe(true);
    }
    for (const i of seed.improvements) if (i.step_id) expect(steps.has(i.step_id)).toBe(true);
  });

  it("shows each rule check on something", () => {
    const flags = firstPrinciplesFlags(seed, ctx);
    const codes = Object.values(flags).flat().map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["owner_team", "order", "truth_no_source", "assumption_no_test", "measure_unmapped", "root_ok"]));
  });

  it("is the pipeline's only: other processes start empty", () => {
    expect(getDemoFirstPrinciples(NORTHBEAM_PROCESS_ID)).toEqual(seed);
    expect(getDemoFirstPrinciples("00000000-0000-4000-8000-00000000abcd")).toEqual(emptyFirstPrinciples());
  });

  it("keeps what the flow saves, the same object until it changes again", () => {
    const id = "00000000-0000-4000-8000-00000000abce";
    const doc = { ...emptyFirstPrinciples(), job: { who: "Founders", progress: "More enquiries", situation: "", done: "Signed" } };
    setDemoFirstPrinciples(id, doc);
    expect(getDemoFirstPrinciples(id).job.progress).toBe("More enquiries");
    expect(getDemoFirstPrinciples(id)).toBe(getDemoFirstPrinciples(id));
  });
});

describe("the summary card", () => {
  const seed = demoFirstPrinciples();

  it("says not started, with a way in, when there is nothing", () => {
    for (const doc of [null, emptyFirstPrinciples()]) {
      const html = card(doc);
      expect(html).toContain("Not started");
      expect(html).toContain("Work through the 7 steps →");
      expect(html).toContain("/demo/p/x/first-principles");
    }
  });

  it("asks a viewer to open it, not to work through it", () => {
    expect(card(null, { canEdit: false })).toContain("Open →");
  });

  it("shows the job, the root cause and the counts", () => {
    const html = card(seed);
    expect(html).toContain("Get more enquiries they can trust without learning marketing themselves");
    expect(html).toContain("There are no written pricing and scoping rules");
    expect(html).toContain("2 requirements · 1 delete candidate");
    expect(html).toContain("Open →");
  });

  it("shows each success measure with the share of runs that meet it today, computed from the run", () => {
    const rows = measuresMetToday(seed, model, result);
    const shares = rows.map((r) => r.metShare);
    // The three the simulation can compute have a share; the free-text one has none.
    expect(shares.slice(0, 3).every((s) => s !== null)).toBe(true);
    expect(shares[3]).toBeNull();
    const html = card(seed);
    for (const r of rows.slice(0, 3)) expect(html).toContain(`${Math.round(r.metShare! * 100)}%`);
    expect(html).toContain("Clients feel looked after from the first call");
    expect(html).toContain("Not checked by simulation");
  });

  it("counts the flags the rule checks raise, and the steps filled in", () => {
    const html = card(seed);
    expect(html).toMatch(/\d of 7 steps/);
    expect(html).toMatch(/\d+ flags? to look at/);
  });

  it("says when the draft has answers that aren't published, and where inherited ones come from", () => {
    expect(card(seed, { draftChanged: true })).toContain("Draft has changes that aren&#x27;t published");
    expect(card(seed, { inheritedFrom: 2 })).toContain("From version 2");
  });

  it("waits for the run before showing a share", () => {
    const html = card(seed, { result: null });
    expect(html).not.toMatch(/\d+%<\/span>/);
  });
});

describe("success measures feed the goals-met rule (rule 11)", () => {
  const won = result.samples.won;
  const mean = won.reduce((a, b) => a + b, 0) / won.length;
  const doc = (target: number): FirstPrinciples => ({
    ...emptyFirstPrinciples(),
    measures: [{ id: "m1", text: "Wins", kpi: "won", comparator: "atLeast", target, horizon: "" }],
  });

  it("raises nothing with no measures (as before this ticket)", () => {
    expect(rerate(model, result, {}, bundle.process.id).filter((i) => i.key.startsWith("success:"))).toEqual([]);
  });

  it("raises a finding for a target few runs reach, and none for one they all reach", () => {
    const high = rerate(model, result, {}, bundle.process.id, null, { successMeasures: successMeasureSource(doc(mean * 50), bundle.process.id) });
    const found = high.filter((i) => i.key === "success:measure:m1");
    expect(found).toHaveLength(1);
    expect(found[0]!.rating).toBe("risk");
    const low = rerate(model, result, {}, bundle.process.id, null, { successMeasures: successMeasureSource(doc(mean * 0.1), bundle.process.id) });
    expect(low.filter((i) => i.key.startsWith("success:"))).toEqual([]);
  });

  it("leaves every other finding as it was", () => {
    const without = rerate(model, result, {}, bundle.process.id).map((i) => i.key);
    const withSource = rerate(model, result, {}, bundle.process.id, null, { successMeasures: successMeasureSource(doc(mean * 50), bundle.process.id) }).map((i) => i.key);
    expect(withSource.filter((k) => !k.startsWith("success:"))).toEqual(without);
  });

  it("does not rate a measure the simulation can't work out, or one with no target", () => {
    const d: FirstPrinciples = {
      ...emptyFirstPrinciples(),
      measures: [
        { id: "a", text: "Looked after", kpi: null, comparator: "atLeast", target: null, horizon: "" },
        { id: "b", text: "Wins", kpi: "won", comparator: "atLeast", target: null, horizon: "" },
      ],
    };
    expect(rerate(model, result, {}, bundle.process.id, null, { successMeasures: successMeasureSource(d, bundle.process.id) }).filter((i) => i.key.startsWith("success:"))).toEqual([]);
  });
});

describe("answers saved only to first principles can be published", () => {
  it("counts a first-principles difference as a change, beside the steps and edges", () => {
    const none = { list: [] };
    expect(publishableChanges(none, true, 0)).toBe(0);
    expect(publishableChanges(none, true, 1)).toBe(1);
    expect(publishableChanges({ list: [{}, {}] as never }, true, 1)).toBe(3);
    // Nothing without a draft.
    expect(publishableChanges(none, false, 1)).toBe(0);
  });

  it("says the draft has changes on the card even when the live version has no answers", () => {
    const html = card(null, { draftChanged: true });
    expect(html).toContain("Not started");
    expect(html).toContain("Draft has changes that aren&#x27;t published");
    expect(card(null)).not.toContain("Draft has changes");
  });

  it("the Editor passes the count to Publish and Discard", () => {
    const view = readFileSync(join(__dirname, "..", "src", "components", "editor", "editor-view.tsx"), "utf8");
    expect(view).toContain("publishableChanges(diff, hasDraft, extraChanges)");
    const page = readFileSync(join(__dirname, "..", "src", "components", "editor", "workspace-editor-page.tsx"), "utf8");
    expect(page).toContain("firstPrinciplesDraftChanged(");
  });
});

describe("goals met reads the same success measures on every page", () => {
  const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
  it("every page that rates a run passes them to the detectors", () => {
    // The rules editor (and its live preview) went with B17; every page left that rates a run still passes them.
    for (const f of ["components/process-page.tsx", "components/process-view.tsx", "components/issues-page.tsx", "components/overview/overview.tsx"]) {
      expect(read(f), f).toContain("useSuccessMeasures(");
    }
    expect(read("components/process-page.tsx")).toContain("successMeasures,");
    expect(read("components/process-view.tsx")).toContain("successMeasures,");
    expect(read("components/issues-page.tsx")).toContain("absence, successMeasures)");
    expect(read("components/overview/overview.tsx")).toContain("{ successMeasures }");
  });
  it("and the workspace pages load the live version's answers for them", () => {
    for (const f of ["app/w/[slug]/issues/page.tsx", "components/overview/workspace-overview.tsx"]) {
      expect(read(f), f).toContain("loadLiveFirstPrinciples(");
    }
    expect(readFileSync(join(__dirname, "..", "..", "..", "packages", "mcp", "src", "analysis-tools.ts"), "utf8")).toContain("successMeasureSource(");
  });
  it("find the same goals-met finding wherever the run is rated", () => {
    const won = result.samples.won;
    const mean = won.reduce((a, b) => a + b, 0) / won.length;
    const doc: FirstPrinciples = { ...emptyFirstPrinciples(), measures: [{ id: "m1", text: "Wins", kpi: "won", comparator: "atLeast", target: mean * 50, horizon: "" }] };
    const source = successMeasureSource(doc, bundle.process.id);
    const a = rerate(model, result, {}, bundle.process.id, null, { successMeasures: source });
    const b = rerate(model, result, {}, bundle.process.id, null, { currency: "AUD", successMeasures: source });
    expect(a.filter((i) => i.key.startsWith("success:")).map((i) => [i.key, i.rating])).toEqual(b.filter((i) => i.key.startsWith("success:")).map((i) => [i.key, i.rating]));
    expect(a.some((i) => i.key === "success:measure:m1")).toBe(true);
  });
});

describe("restoring a version (A40) asks first when the draft has answers of its own", () => {
  it("asks when the draft's first principles differ from live's, and not once the person has agreed", async () => {
    const { mustAskBeforeRestore } = await import("@/lib/history/restore-check");
    expect(mustAskBeforeRestore(false, true, true)).toBe(true);
    expect(mustAskBeforeRestore(true, true, true)).toBe(false);
    expect(mustAskBeforeRestore(false, true, false)).toBe(false);
    expect(mustAskBeforeRestore(false, false, true)).toBe(false);
  });
  it("the restore action checks before it calls restore_version", () => {
    const action = readFileSync(join(__dirname, "..", "src", "app", "w", "[slug]", "p", "[processId]", "history", "actions.ts"), "utf8");
    const check = action.indexOf("mustAskBeforeRestore(replaceDraft");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(action.indexOf('rpc("restore_version"'));
    expect(action).toContain("firstPrinciplesDraftChanged(");
    expect(action).toContain('return { status: "draft_exists" }');
  });
});

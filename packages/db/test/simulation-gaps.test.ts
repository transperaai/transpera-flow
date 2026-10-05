import { describe, expect, it } from "vitest";
import { checkProcessFile } from "../src/process-file";
import { findGaps, gapInputFromBundle, gapInputFromFile, SERVER_DEFAULT_NOTE_PREFIX } from "../src/simulation-gaps";

// "Missing for simulation" (issue #167): one check, run on an uploaded file and on a process's model. One fixture per gap type,
// and each gap clears once the value is filled in.

const clone = (v: unknown) => JSON.parse(JSON.stringify(v));

function file(change: (f: ReturnType<typeof JSON.parse>) => void = () => {}) {
  const f = clone({
    format: "transpera-process/2",
    name: "P",
    steps: [
      { id: "s", name: "Begin", type: "start" },
      { id: "w", name: "Write proposal", type: "step", role: "Writer", hands_on_hours: 2 },
      { id: "p", name: "Wait for payment", type: "wait", wait_hours: 24 },
      { id: "d", name: "Client decides", type: "decision" },
      { id: "y", name: "Yes", type: "end" },
      { id: "n", name: "No", type: "end" },
    ],
    links: [
      { from: "s", to: "w" },
      { from: "w", to: "p" },
      { from: "p", to: "d" },
      { from: "d", to: "y", probability: 0.6 },
      { from: "d", to: "n", probability: 0.4 },
    ],
  });
  change(f);
  const out = checkProcessFile(f);
  expect(out.errors).toEqual([]);
  return out.file!;
}
const gaps = (f: ReturnType<typeof file>, opts: Partial<Parameters<typeof gapInputFromFile>[1]> = {}) =>
  findGaps(gapInputFromFile(f, { hasRole: () => true, volume: "known", ...opts })).map((g) => g.text);

describe("on a file", () => {
  it("a complete process has no gaps", () => {
    expect(gaps(file())).toEqual([]);
  });

  it("a work step with no role", () => {
    expect(gaps(file((f) => delete f.steps[1].role))).toEqual(["Write proposal has no role"]);
  });

  it("a role the company doesn't have and nobody mapped counts as no role, and mapping it clears the gap", () => {
    const f = file();
    expect(gaps(f, { hasRole: () => false })).toEqual(["Write proposal has no role"]);
    expect(gaps(f, { hasRole: (r) => r === "Writer" })).toEqual([]);
  });

  it("a work step with no hands-on time", () => {
    expect(gaps(file((f) => delete f.steps[1].hands_on_hours))).toEqual(["Write proposal has no hands-on time"]);
  });

  it("hands-on time given only by a range or by a quote's number is present; only a reason for assuming it, with no number, is not", () => {
    expect(gaps(file((f) => ((f.steps[1].hands_on_hours = undefined), (f.steps[1].hands_on_range = { min: 1, max: 3 }))))).toEqual([]);
    const quoted = file((f) => {
      f.sources = [{ id: "t", title: "Talk" }];
      delete f.steps[1].hands_on_hours;
      f.steps[1].evidence = { hands_on_hours: [{ source: "t", quote: "Two hours.", value: 2 }] };
    });
    expect(gaps(quoted)).toEqual([]);
    const reasonOnly = file((f) => {
      delete f.steps[1].hands_on_hours;
      f.steps[1].assumed = { hands_on_hours: "A guess." };
    });
    expect(gaps(reasonOnly)).toEqual(["Write proposal has no hands-on time"]);
  });

  it("a wait step with no wait", () => {
    expect(gaps(file((f) => delete f.steps[2].wait_hours))).toEqual(["Wait for payment has no wait time"]);
  });

  it("a work step needs no wait and a wait step needs no role or hands-on time", () => {
    const f = file((x) => delete x.steps[1].wait_hours);
    expect(gaps(f)).toEqual([]);
    expect(gaps(file((x) => (x.steps[2].role = undefined)))).toEqual([]);
  });

  it("a decision with a branch missing odds", () => {
    expect(gaps(file((f) => delete f.links[4].probability))).toEqual(["Client decides: branch odds missing"]);
    expect(gaps(file((f) => (f.links.splice(4, 1), f.steps.pop())))).toEqual([]);
  });

  it("a branch's quote with a number, or a number, is odds; a reason alone is not", () => {
    const f = file((x) => {
      x.sources = [{ id: "t", title: "Talk" }];
      delete x.links[3].probability;
      x.links[3].evidence = [{ source: "t", quote: "Six in ten.", value: 0.6 }];
    });
    expect(gaps(f)).toEqual([]);
    const reason = file((x) => {
      delete x.links[3].probability;
      x.links[3].assumed = "A guess.";
    });
    expect(gaps(reason)).toEqual(["Client decides: branch odds missing"]);
  });

  it("incoming volume: missing for a pipeline, for a servicing process, and says to accept the suggestion when the file carries one", () => {
    const f = file();
    expect(gaps(f, { volume: "missing" })).toEqual(["No incoming volume: add lead volume in Settings or accept the suggestion"]);
    expect(gaps(f, { volume: "missing", volumeSuggested: true })).toEqual(["No incoming volume yet: accept the lead volume suggestion, or add it in Settings"]);
    const servicing = file((x) => (x.kind = "servicing"));
    expect(gaps(servicing, { volume: "missing" })).toEqual(["No recurrence: link this process to a service and set how often it repeats in Settings"]);
    expect(gaps(f, { volume: "unknown" })).toEqual([]);
  });

  it("points each gap at its step or at Settings", () => {
    const f = file((x) => delete x.steps[1].role);
    const all = findGaps(gapInputFromFile(f, { hasRole: () => true, volume: "missing" }));
    expect(all.map((g) => g.fix)).toEqual([{ type: "step", stepId: "w" }, { type: "settings", where: "demand" }]);
  });
});

// A step as the model has it (the fields the check reads).
const row = (id: string, name: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, name, kind, role_id: null, provenance: {}, ...extra });
const defaulted = (kind: string) => ({ source: "estimated", assumption: true, note: `${SERVER_DEFAULT_NOTE_PREFIX} ${kind} step.` });
const model = (steps: ReturnType<typeof row>[], extra: Record<string, unknown> = {}) =>
  gapInputFromBundle({
    steps,
    edges: [
      { from_step_id: "d", to_step_id: "y" },
      { from_step_id: "d", to_step_id: "n" },
    ],
    process: { id: "p1", kind: "pipeline" },
    leadSources: [{ volume_week: 5 }],
    servicingLinks: [],
    ...extra,
  } as never);
const texts = (input: ReturnType<typeof model>) => findGaps(input).map((g) => g.text);

describe("on a process's model", () => {
  const steps = () => [
    row("w", "Write proposal", "task", { provenance: { work_hours: defaulted("task") } }),
    row("p", "Wait for payment", "wait", { provenance: { wait_hours: defaulted("wait") } }),
    row("d", "Client decides", "decision", { provenance: { branch_odds: { source: "estimated", defaulted: true } } }),
    row("y", "Yes", "end"),
    row("n", "No", "end"),
  ];

  it("lists a defaulted value, an unmarked odds, a missing role and missing volume, one per gap type", () => {
    expect(texts(model(steps(), { leadSources: [] }))).toEqual([
      "Write proposal has no role",
      "Write proposal has no hands-on time",
      "Wait for payment has no wait time",
      "Client decides: branch odds missing",
      "No incoming volume: add lead volume in Settings or accept the suggestion",
    ]);
  });

  it("each clears once the value is filled in", () => {
    const s = steps();
    s[0] = row("w", "Write proposal", "task", { role_id: "r1", provenance: { work_hours: { source: "entered" } } });
    s[1] = row("p", "Wait for payment", "wait", { provenance: { wait_hours: { source: "entered" } } });
    s[2] = row("d", "Client decides", "decision", { provenance: {} });
    expect(texts(model(s))).toEqual([]);
  });

  it("an estimate someone confirmed (assumption cleared) is no longer a gap, but one still open is", () => {
    const confirmed = [row("w", "Write proposal", "task", { role_id: "r", provenance: { work_hours: { ...defaulted("task"), assumption: false } } })];
    expect(texts(model(confirmed))).toEqual([]);
    const open = [row("w", "Write proposal", "task", { role_id: "r", provenance: { work_hours: defaulted("task") } })];
    expect(texts(model(open))).toEqual(["Write proposal has no hands-on time"]);
  });

  it("values the file gave (with a note of their own) are not gaps, however they were assumed", () => {
    const given = [row("w", "Write proposal", "task", { role_id: "r", provenance: { work_hours: { source: "estimated", assumption: true, note: "Stated in the uploaded file 'x'; not yet confirmed." } } })];
    expect(texts(model(given))).toEqual([]);
  });

  it("volume: a pipeline needs a lead source with volume; a servicing process needs a link to a service; a bundle without demand says nothing", () => {
    expect(texts(model([], { leadSources: [{ volume_week: 0 }] }))).toEqual(["No incoming volume: add lead volume in Settings or accept the suggestion"]);
    expect(texts(model([], { leadSources: undefined }))).toEqual([]);
    expect(texts(model([], { process: { id: "p1", kind: "servicing" }, servicingLinks: [] }))).toEqual(["No recurrence: link this process to a service and set how often it repeats in Settings"]);
    expect(texts(model([], { process: { id: "p1", kind: "servicing" }, servicingLinks: [{ process_id: "p1" }] }))).toEqual([]);
    expect(texts(model([], { process: { id: "p1", kind: "servicing" }, servicingLinks: [{ process_id: "other" }] }))).toHaveLength(1);
  });

  it("a decision with one way out needs no odds", () => {
    const input = gapInputFromBundle({ steps: [row("d", "Decides", "decision", { provenance: { branch_odds: { defaulted: true } } })], edges: [{ from_step_id: "d", to_step_id: "y" }], process: { id: "p", kind: "pipeline" }, leadSources: [{ volume_week: 1 }] } as never);
    expect(texts(input)).toEqual([]);
  });
});

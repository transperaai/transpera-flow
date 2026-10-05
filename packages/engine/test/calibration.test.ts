import { describe, expect, it } from "vitest";
import {
  calibrate,
  estimatedParameters,
  leadsProvenance,
  northbeamModel,
  provenanceFromRows,
  type CalibrationEdge,
  type CalibrationInput,
  type CalibrationStep,
  type StepLogRow,
} from "../src";

// Calibration from historical data (docs/PRD.md §6.6; issue #41): each proposed
// parameter type is computed from a fixture step log whose answers are known.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5, 9); // Monday 5 January 2026, 09:00

const est = { work: "estimated", wait: "estimated", rework: "estimated", routing: "estimated" } as const;

function step(id: string, kind: CalibrationStep["kind"], extra: Partial<CalibrationStep> = {}): CalibrationStep {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1).replace(/_/g, " "),
    kind,
    workHours: 1,
    workDist: "lognormal",
    workCv: null,
    waitHours: 0,
    waitDist: "lognormal",
    waitCv: null,
    rework: 0,
    sources: est,
    ...extra,
  };
}

const edge = (from: string, to: string, probability: number | null = null): CalibrationEdge => ({ id: `${from}>${to}`, from, to, probability });

/**
 * start → qualify → fit? (decision) → proposal | lost
 *                                     proposal → client decides (wait) → won
 */
const STEPS: CalibrationStep[] = [
  step("start", "start"),
  step("qualify", "task", { workHours: 2 }),
  step("fit", "decision"),
  step("proposal", "task", { workHours: 3, rework: 0.1, sources: { ...est, work: "entered" } }),
  step("client_decides", "wait", { waitHours: 8 }),
  step("won", "end"),
  step("lost", "end"),
];
const EDGES: CalibrationEdge[] = [
  edge("start", "qualify", 1),
  edge("qualify", "fit", 1),
  edge("fit", "proposal", 0.5),
  edge("fit", "lost", 0.5),
  edge("proposal", "client_decides", 1),
  edge("client_decides", "won", 1),
];

/**
 * 40 items, one arriving every 3.5 days (20 weeks). Qualify takes 1, 2 or 3
 * hours in turn (mean 2, sd 0.82). Items 0-29 go on to a proposal (4 hours),
 * the first 6 of them doing it twice in a row; items 30-39 are lost. Clients
 * decide in 2 calendar days. Even items are Website, odd Referral.
 */
function fixtureRows(): StepLogRow[] {
  const rows: StepLogRow[] = [];
  for (let i = 0; i < 40; i++) {
    const item = `D-${String(i).padStart(3, "0")}`;
    const source = i % 2 === 0 ? "Website" : "referral ";
    let t = T0 + i * 3.5 * DAY;
    const q = (i % 3) + 1;
    rows.push({ item, step: "Qualify", started: t, finished: t + q * HOUR, hours: q, source });
    t += DAY;
    if (i >= 30) {
      rows.push({ item, step: "lost", started: t, finished: t, hours: null, source: null });
      continue;
    }
    const passes = i < 6 ? 2 : 1;
    for (let p = 0; p < passes; p++) {
      rows.push({ item, step: "Proposal", started: t, finished: t + 4 * HOUR, hours: 4, source: null });
      t += 4 * HOUR;
    }
    rows.push({ item, step: "Client  decides", started: t, finished: t + 2 * DAY, hours: null, source: null });
    rows.push({ item, step: "Won", started: t + 2 * DAY, finished: t + 2 * DAY, hours: null, source: null });
  }
  return rows;
}

const input = (over: Partial<CalibrationInput> = {}): CalibrationInput => ({
  steps: STEPS,
  edges: EDGES,
  rows: fixtureRows(),
  hoursPerWeek: 40,
  leadSources: [
    { id: "web", name: "Website", volumeWeek: 3, conversion: 0.5, source: "estimated" },
    { id: "ref", name: "Referral", volumeWeek: 1, conversion: 1, source: "entered" },
  ],
  ...over,
});

const find = (r: ReturnType<typeof calibrate>, key: string) => {
  const p = r.proposals.find((x) => x.key === key);
  if (!p) throw new Error(`no proposal ${key}`);
  return p;
};

describe("calibrate", () => {
  const r = calibrate(input());

  it("counts the log", () => {
    expect(r.rows).toBe(fixtureRows().length);
    expect(r.items).toBe(40);
    expect(r.unmatchedSteps).toEqual([]);
    expect(r.window!.weeks).toBeCloseTo((39 * 3.5 + 1) / 7, 6);
  });

  it("measures hands-on time and its spread from the hours column", () => {
    const q = find(r, "work:qualify");
    expect(q.n).toBe(40);
    expect(q.proposed).toBe(1.98); // 14 ones, 13 twos, 13 threes
    const xs = Array.from({ length: 40 }, (_, i) => (i % 3) + 1);
    const mean = xs.reduce((s, x) => s + x, 0) / 40;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / 39);
    expect(q.proposedCv).toBe(Math.round((sd / mean) * 100) / 100);
    expect(q.set).toEqual({ work_hours: 1.98, work_dist: "lognormal", work_params: { cv: q.proposedCv } });
    expect(q.before).toEqual({ work_hours: 2, work_dist: "lognormal", work_params_cv: null });
    expect(q.changed).toBe(true);

    const p = find(r, "work:proposal");
    expect(p.n).toBe(36);
    expect(p.proposed).toBe(4);
    expect(p.proposedCv).toBe(0.05); // no spread at all is floored
    expect(p.currentSource).toBe("entered");
  });

  it("measures a wait step's wait in working hours at the workspace's week", () => {
    const w = find(r, "wait:client_decides");
    expect(w.n).toBe(30);
    expect(w.proposed).toBe(Math.round(((2 / 7) * 40) * 100) / 100); // 11.43
    expect(w.set).toMatchObject({ wait_hours: 11.43, wait_dist: "lognormal" });
  });

  it("measures rework as the same step done again straight away", () => {
    const p = find(r, "rework:proposal");
    expect(p.n).toBe(36);
    expect(p.proposed).toBe(Math.round((6 / 36) * 1000) / 1000);
    expect(p.set).toEqual({ rework_rate: 0.167 });
    expect(find(r, "rework:qualify").proposed).toBe(0);
  });

  it("measures branch odds at a decision nobody logs, from what items did next", () => {
    const f = find(r, "routing:fit");
    expect(f.n).toBe(40);
    expect(f.enough).toBe(true);
    expect(f.branches!.map((b) => [b.to, b.n, b.proposed])).toEqual([
      ["proposal", 30, 0.75],
      ["lost", 10, 0.25],
    ]);
    expect(f.set).toEqual({ probabilities: { "fit>proposal": 0.75, "fit>lost": 0.25 } });
    expect(f.before).toEqual({ probabilities: { "fit>proposal": 0.5, "fit>lost": 0.5 } });
  });

  it("can't count a branch whose end nobody logs, and says how to fix it", () => {
    const rows = fixtureRows().filter((row) => row.step !== "lost");
    const f = find(calibrate(input({ rows })), "routing:fit");
    expect(f.enough).toBe(false);
    expect(f.set).toBeNull();
    expect(f.blocked).toMatch(/Lost/);
  });

  it("measures qualified arrivals a week per lead source, as leads at the source's qualify rate", () => {
    const weeks = r.window!.weeks;
    const web = find(r, "arrivals:web");
    expect(web.n).toBe(20);
    expect(web.proposed).toBe(Math.round((20 / weeks / 0.5) * 100) / 100);
    const ref = find(r, "arrivals:ref");
    expect(ref.n).toBe(20); // "referral " matches Referral
    expect(ref.proposed).toBe(Math.round((20 / weeks) * 100) / 100);
    expect(ref.currentSource).toBe("entered");
  });

  it("takes seasonality out of arrivals", () => {
    // The log runs January to May; with every month at 2× normal, the base rate is half.
    const plain = find(r, "arrivals:ref").proposed!;
    const doubled = find(calibrate(input({ seasonality: Array(12).fill(2) })), "arrivals:ref").proposed!;
    expect(doubled).toBeCloseTo(plain / 2, 1);
  });

  it("proposes no arrivals when the process is not where leads arrive", () => {
    expect(calibrate(input({ leadSources: null })).proposals.some((p) => p.kind === "arrivals")).toBe(false);
  });

  it("flags too small a sample and proposes nothing for it", () => {
    const rows = fixtureRows().filter((row) => !(row.step === "Client  decides" && Number(row.item.slice(2)) >= 5));
    const w = find(calibrate(input({ rows })), "wait:client_decides");
    expect(w.n).toBe(5);
    expect(w.enough).toBe(false);
    expect(w.proposed).toBeNull();
    expect(w.set).toBeNull();
    expect(w.changed).toBe(false);
    expect(w.blocked).toBe("Too few to measure: 5 of the 10 needed.");
  });

  it("lists step names that match no step", () => {
    const rows = [...fixtureRows(), { item: "X", step: "Invoice", started: T0, finished: T0, hours: 1, source: null }];
    expect(calibrate(input({ rows })).unmatchedSteps).toEqual([{ name: "Invoice", rows: 1 }]);
  });

  it("does not count a branch an item could have reached another way", () => {
    // qualify → a (decision) → { b (decision), proposal }; b → { proposal, lost }.
    // An item logged at qualify then proposal could have gone through b or not, so b's odds can't use it.
    const steps = [step("qualify", "task"), step("a", "decision"), step("b", "decision"), step("proposal", "task"), step("lost", "end")];
    const edges = [edge("qualify", "a"), edge("a", "b"), edge("a", "proposal"), edge("b", "proposal"), edge("b", "lost")];
    const rows: StepLogRow[] = [];
    for (let i = 0; i < 12; i++) {
      rows.push({ item: `i${i}`, step: "Qualify", started: T0 + i * DAY, finished: null, hours: null, source: null });
      rows.push({ item: `i${i}`, step: i < 8 ? "Proposal" : "Lost", started: T0 + i * DAY + HOUR, finished: null, hours: null, source: null });
    }
    const res = calibrate({ steps, edges, rows, hoursPerWeek: 40 });
    const b = find(res, "routing:b");
    expect(b.n).toBe(4); // only the lost items are certain to have passed b
    const a = find(res, "routing:a");
    expect(a.n).toBe(4); // proposal is reachable both ways from a, so only lost counts
  });

  it("enters a group at its first step and leaves it by the group's own way out", () => {
    // qualify → G (group: inner) → fit (decision) → { proposal, lost }
    const steps = [
      step("qualify", "task"),
      step("g", "group", { entry: "inner" }),
      step("inner", "task", { parent: "g" }),
      step("fit", "decision"),
      step("proposal", "task"),
      step("lost", "end"),
    ];
    const edges = [edge("qualify", "g"), edge("g", "fit"), edge("fit", "proposal"), edge("fit", "lost")];
    const rows: StepLogRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ item: `i${i}`, step: "Inner", started: T0 + i * DAY, finished: null, hours: null, source: null });
      rows.push({ item: `i${i}`, step: i < 7 ? "Proposal" : "Lost", started: T0 + i * DAY + HOUR, finished: null, hours: null, source: null });
    }
    const fit = find(calibrate({ steps, edges, rows, hoursPerWeek: 40 }), "routing:fit");
    expect(fit.branches!.map((x) => x.proposed)).toEqual([0.7, 0.3]);
  });

  it("is deterministic and does not depend on the log's row order", () => {
    const shuffled = [...fixtureRows()].reverse();
    expect(calibrate(input({ rows: shuffled })).proposals).toEqual(r.proposals);
  });
});

describe("robustness after calibration", () => {
  // Applied values are stored with `{source: "measured", dataset_id, ...}` (the apply in the database writes this
  // shape). The robustness check perturbs estimates only, so measured values drop out of it (docs/PRD.md §6.5).
  const measured = { source: "measured", dataset_id: "d1", calibration_id: "c1", n: 40 };

  it("stops perturbing measured step values and measured qualified leads", () => {
    const m = northbeamModel();
    const paths = (rows: Parameters<typeof provenanceFromRows>[0]) =>
      estimatedParameters(m, { provenance: provenanceFromRows(rows) }).map((p) => p.path);
    const before = paths({});
    const s = m.steps.find((x) => x.work > 0 && x.rework > 0) ?? m.steps.find((x) => x.work > 0)!;
    expect(before).toContain(`steps.${s.id}.work_hours`);
    expect(before).toContain("demand.leads_per_week");

    const after = paths({
      steps: [{ id: s.id, provenance: { work_hours: measured, rework_rate: measured } }],
      leadSources: [{ provenance: { volume_week: measured } }, { provenance: { volume_week: measured, conversion_to_qualified: { source: "entered" } } }],
    });
    expect(after).not.toContain(`steps.${s.id}.work_hours`);
    expect(after).not.toContain(`steps.${s.id}.rework_rate`);
    expect(after).not.toContain("demand.leads_per_week");
    // Everything else is still perturbed.
    expect(after.length).toBe(before.filter((p) => p !== `steps.${s.id}.work_hours` && p !== `steps.${s.id}.rework_rate` && p !== "demand.leads_per_week").length);
  });

  it("counts qualified leads as known only when every source's are", () => {
    expect(leadsProvenance([])).toBe("estimated");
    expect(leadsProvenance([{ provenance: { volume_week: measured } }, { provenance: {} }])).toBe("estimated");
    // A measured volume is the measured qualified leads at the source's share, whatever the share's provenance.
    expect(leadsProvenance([{ provenance: { volume_week: measured } }])).toBe("measured");
    expect(leadsProvenance([{ provenance: { volume_week: { source: "entered" }, conversion_to_qualified: { source: "entered" } } }])).toBe("entered");
    expect(leadsProvenance([{ provenance: { volume_week: { source: "entered" } } }])).toBe("estimated");
  });
});

import { describe, expect, it } from "vitest";
import {
  LEVER_KIND_IDS,
  SANDBOX_LEVERS,
  changesFromPatch,
  larkspurBundle,
  leverHidden,
  leverOfPath,
  northbeamBundle,
  offeredLevers,
  patchOf,
  sandboxLever,
  toEngineModel,
  wholeRunPatches,
  type SandboxChange,
} from "@transpera-flow/db";
import { PATCH_FIELDS, SELECTORS, type ScenarioPatch } from "@transpera-flow/engine";
import { LEVER_KINDS, leverKindId } from "@/lib/scenarios/lever-catalogue";
import { buildLevers } from "@/lib/scenarios/levers";

// The Sandbox's lever registry (packages/db/src/sandbox-levers.ts) against the engine's patch grammar, the Settings -> Levers catalogue
// and the process page's sliders. The SQL twin is in packages/db/test/sandbox-scenarios.test.ts.

const START = { startDate: "2026-10-05" };
const models = [toEngineModel(northbeamBundle(), START), toEngineModel(larkspurBundle(), START)];

/** Every path the engine's grammar accepts: each field of each collection, with an id where it takes one. */
const everyPath = (): string[] => {
  const out: string[] = [];
  for (const [kind, fields] of Object.entries(PATCH_FIELDS)) {
    for (const field of fields) {
      if (kind === "demand" || kind === "finances" || kind === "health") out.push(`${kind}.${field}`);
      else {
        out.push(`${kind}.some-id.${field}`);
        for (const sel of SELECTORS[kind as keyof typeof SELECTORS] ?? []) out.push(`${kind}.${sel}.${field}`);
      }
    }
  }
  return out;
};

describe("the registry and the engine's patches", () => {
  it("maps every PATCH_FIELDS path to exactly one lever, and back to the same path", () => {
    const paths = everyPath();
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) {
      const hit = leverOfPath(path);
      expect(hit, path).not.toBeNull();
      const change: SandboxChange = { id: "00000000-0000-4000-8000-000000000000", lever: hit!.lever, target: hit!.target, op: "set", value: 1 };
      expect(patchOf(change), path).toEqual({ path, op: "set", value: 1 });
    }
    // No two paths share a lever and target and field: the mapping is one to one.
    expect(countDuplicateTargets(paths)).toBe(0);
    expect(leverOfPath("nope")).toBeNull();
    expect(leverOfPath("steps.a.colour")).toBeNull();
    expect(leverOfPath("steps.@busiest.work_hours")).toBeNull();
  });

  it("changesFromPatch and patchOf round-trip, with new ids each, and the changes parse", () => {
    const patches: ScenarioPatch[] = everyPath().map((path) => ({ path, op: "multiply", value: 1.5 }));
    const changes = changesFromPatch(patches);
    expect(changes.map((c) => patchOf(c))).toEqual(patches);
    expect(new Set(changes.map((c) => c.id)).size).toBe(changes.length);
    let n = 0;
    expect(changesFromPatch(patches.slice(0, 2), () => `00000000-0000-4000-8000-00000000000${++n}`).map((c) => c.id)).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
    expect(() => changesFromPatch([{ path: "nope", op: "set", value: 1 }])).toThrow(/No lever/);
  });

  it("each of the process page's sliders maps to a lever whose Settings, Levers kind is the slider's kind", () => {
    for (const model of models) {
      for (const lever of buildLevers(model)) {
        const hit = leverOfPath(lever.path);
        expect(hit, lever.path).not.toBeNull();
        expect(sandboxLever(hit!.lever)!.kind, lever.path).toBe(leverKindId(lever));
      }
    }
  });

  it("every kind the registry names is a real kind, in the catalogue and in the database package's copy", () => {
    const catalogue = LEVER_KINDS.map((k) => k.id);
    expect([...LEVER_KIND_IDS]).toEqual(catalogue);
    for (const l of SANDBOX_LEVERS) if (l.kind !== null) expect(catalogue, l.id).toContain(l.kind);
    // The kinds the catalogue says are changed in the Sandbox are the ones of the levers with no slider.
    const sandboxKinds = LEVER_KINDS.filter((k) => k.control === "sandbox").map((k) => k.id).sort();
    expect(sandboxKinds).toEqual(["finances.roleCost", "people.leave", "people.starters"]);
    for (const id of sandboxKinds) expect(SANDBOX_LEVERS.some((l) => l.kind === id), id).toBe(true);
  });

  it("offers the levers a person may add: not the migrated-only ones, not role cost yet, and not a hidden kind; levers with no kind are always offered", () => {
    const all = offeredLevers().map((l) => l.id);
    expect(all).toEqual(["A1", "A6", "B1", "B2", "B3", "D1", "D2", "D3", "D4", "D5", "E1", "E2", "E3", "E6"]);
    expect(all).not.toContain("C1");
    for (const x of ["X1", "X2", "X3"]) expect(all).not.toContain(x);
    const hidden = offeredLevers(["people.starters", "process.time", "finances.prices"]).map((l) => l.id);
    expect(hidden).not.toContain("D1");
    expect(hidden).not.toContain("E1");
    expect(hidden).not.toContain("B2");
    expect(hidden).toContain("A6");
    expect(hidden).toContain("E6");
    // Hiding a kind doesn't change what a saved change does; the Sandbox only says so.
    expect(leverHidden(sandboxLever("D1")!, ["people.starters"])).toBe(true);
    expect(leverHidden(sandboxLever("E6")!, ["people.starters"])).toBe(false);
    expect(leverHidden(sandboxLever("A6")!, LEVER_KIND_IDS)).toBe(false);
  });

  it("only offers a lever with ranges for the ops the dialog shows, and the hire range is 0.1 to 1.5 (0.1 to 2 accepted)", () => {
    for (const l of offeredLevers()) {
      expect(Object.keys(l.range).length, l.id).toBeGreaterThan(0);
      for (const op of Object.keys(l.range)) expect(l.ops, `${l.id} ${op}`).toContain(op);
    }
    expect(sandboxLever("D1")!.range.set).toEqual({ min: 0.1, max: 1.5, step: 0.1 });
    expect(sandboxLever("A1")!.displayScale).toBeCloseTo(52 / 12);
  });
});

const countDuplicateTargets = (paths: string[]) => paths.length - new Set(paths.map((p) => JSON.stringify(leverOfPath(p)))).size;

describe("what applies in this model (design suggestion 8)", () => {
  const [northbeam, larkspur] = models as [(typeof models)[0], (typeof models)[0]];

  it("says why the active-clients and churn levers do nothing when clients are counted per service or by name", () => {
    for (const model of models) {
      const roster = model.clients !== undefined || Object.values(model.clientGroups ?? {}).some((g) => g.count > 0);
      for (const id of ["B1", "B3"] as const) {
        const reason = sandboxLever(id)!.applies!(model);
        expect(reason === null, `${id} ${roster}`).toBe(!roster);
        if (reason) expect(reason).toMatch(/Settings, Clients/);
      }
    }
    // A model with neither: both apply.
    const pooled = { ...northbeam, clients: undefined, clientGroups: undefined };
    expect(sandboxLever("B1")!.applies!(pooled)).toBeNull();
    expect(sandboxLever("B3")!.applies!(pooled)).toBeNull();
    expect(sandboxLever("B1")!.applies!({ ...pooled, clientGroups: { x: { count: 3 } } as never })).not.toBeNull();
    expect(sandboxLever("B1")!.applies!({ ...pooled, clientGroups: { x: { count: 0 } } as never })).toBeNull();
  });

  it("needs two services to split traffic between, and nothing else has a reason", () => {
    expect(sandboxLever("A6")!.applies!({ ...northbeam, services: { a: {} as never } })).toMatch(/two or more/);
    expect(sandboxLever("A6")!.applies!({ ...northbeam, services: { a: {} as never, b: {} as never } })).toBeNull();
    expect(sandboxLever("A6")!.applies!({ ...larkspur, services: undefined })).toMatch(/two or more/);
    for (const l of SANDBOX_LEVERS.filter((x) => !["A6", "B1", "B3"].includes(x.id))) expect(l.applies, l.id).toBeUndefined();
  });
});

describe("the process page's scenarios are the standalone whole-run ones (loadScenarios' filter)", () => {
  const c = (lever: SandboxChange["lever"], extra: Partial<SandboxChange> = {}): SandboxChange => ({ id: "00000000-0000-4000-8000-000000000000", lever, target: null, op: "multiply", value: 1.2, ...extra });

  it("turns whole-run patch changes into patches, in order", () => {
    expect(wholeRunPatches([c("A1"), c("B3", { op: "set", value: 0.02 })])).toEqual([
      { path: "demand.leads_per_week", op: "multiply", value: 1.2 },
      { path: "demand.churn_monthly", op: "set", value: 0.02 },
    ]);
    expect(wholeRunPatches([])).toEqual([]);
  });

  it("is null for a change from a month, a hire, leave, a leaver or a solution", () => {
    for (const bad of [c("A1", { from: "2027-05" }), c("D1", { target: "r", op: "set", value: 1 }), c("D3", { target: "p", op: "set", value: 2, from: "2027-03-01" }), c("D2", { target: "p", op: "set", value: 0 }), c("E6", { target: "s", op: "set", value: 1 })]) {
      expect(wholeRunPatches([c("A1"), bad]), bad.lever).toBeNull();
    }
  });
});

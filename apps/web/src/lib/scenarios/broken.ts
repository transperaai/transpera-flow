// Broken scenarios in the browser (issue #16): what the process remembers
// about steps the model no longer has, which saved scenarios a draft would
// break if published, and where a broken patch can be re-pointed. Pure; the
// checks themselves are the engine's (packages/engine/src/broken.ts).

import type { ProcessBundle, ScenarioRow, Viewer } from "@transpera-flow/db";
import {
  BrokenScenarioError,
  checkScenario,
  resolveScenario,
  type BrokenPatch,
  type EngineModel,
  type PatchIssue,
  type RetiredSteps,
  type ScenarioPatch,
} from "@transpera-flow/engine";
import { personName, viewerOf } from "@/lib/viewer";

type Steps = Pick<ProcessBundle, "steps" | "retired">;

/**
 * Steps `bundle` no longer has, by id: its retired rows (split or replaced,
 * with `replaced_by`), then the same from `others` (e.g. the live revision
 * while a draft is shown), then steps of `others` that `bundle` lacks, which
 * were deleted (no replacements). The first record of an id wins.
 */
export function retiredSteps(bundle: Steps, ...others: (Steps | null | undefined)[]): RetiredSteps {
  const out: RetiredSteps = {};
  const present = new Set(bundle.steps.map((s) => s.id));
  const add = (id: string, name: string, replacedBy: string[]) => {
    if (!present.has(id) && !out[id]) out[id] = { name, replacedBy };
  };
  const all = [bundle, ...others.filter((o): o is Steps => Boolean(o))];
  for (const b of all) for (const s of b.retired ?? []) add(s.id, s.name, [...(s.replaced_by ?? [])]);
  for (const b of others) for (const s of b?.steps ?? []) add(s.id, s.name, []);
  return out;
}

export interface BreakingScenario {
  scenario: ScenarioRow;
  broken: BrokenPatch[];
}

/**
 * Saved scenarios that resolve against `before` but need attention against
 * `after`: what publishing a draft (`after`) over live (`before`) would break.
 */
export function newlyBroken(
  before: EngineModel,
  after: EngineModel,
  scenarios: readonly ScenarioRow[],
  retired: RetiredSteps = {},
): BreakingScenario[] {
  return scenarios.flatMap((scenario) => {
    if (checkScenario(before, scenario.patch, retired).status !== "ok") return [];
    const { broken } = checkScenario(after, scenario.patch, retired);
    return broken.length ? [{ scenario, broken }] : [];
  });
}

export interface Named {
  id: string;
  name: string;
}

/**
 * Where a broken patch can point instead: the steps that replaced its target
 * first, then every other target of the same kind in the model (by name).
 * Nothing for a patch outside the grammar or on demand and finances.
 */
export function repointTargets(model: EngineModel, b: BrokenPatch, viewer?: Viewer): { suggested: Named[]; others: Named[] } {
  const suggested = b.replacements;
  const taken = new Set(suggested.map((s) => s.id));
  let all: Named[] = [];
  if (b.kind === "steps") all = model.steps.filter((s) => s.role || s.person || s.work > 0 || s.wait > 0).map((s) => ({ id: s.id, name: s.name }));
  else if (b.kind === "roles") all = Object.entries(model.roles).map(([id, r]) => ({ id, name: r.name }));
  else if (b.kind === "people") all = Object.entries(model.people ?? {}).map(([id, p]) => ({ id, name: personName(viewerOf({ viewer }), id, p.name) }));
  else if (b.kind === "services") all = Object.entries(model.services ?? {}).map(([id, s]) => ({ id, name: s.name }));
  const others = all.filter((x) => !taken.has(x.id)).sort((x, y) => x.name.localeCompare(y.name, "en-GB"));
  return { suggested, others };
}

/**
 * Model resolution for the scenario run: the model with `patches` applied, or
 * why it can't run. A broken patch is never skipped (engine `resolveScenario`).
 */
export function resolveRun(
  model: EngineModel,
  patches: readonly ScenarioPatch[],
  retired: RetiredSteps = {},
): { ok: true; model: EngineModel; issues: PatchIssue[] } | { ok: false; error: string } {
  try {
    return { ok: true, ...resolveScenario(model, patches, { retired }) };
  } catch (err) {
    if (err instanceof BrokenScenarioError) return { ok: false, error: err.message };
    throw err;
  }
}

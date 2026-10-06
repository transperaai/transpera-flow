// Saved scenarios in the browser: describing patches in words, which saved
// scenarios still apply to the model, stacking them with the levers, and the
// compare headline's subject. Pure functions; the panel renders the results.

import type { ScenarioRow, Viewer } from "@transpera-flow/db";
import {
  checkScenario,
  parsePatchPath,
  type BrokenPatch,
  type EngineModel,
  type RetiredSteps,
  type ScenarioPatch,
} from "@transpera-flow/engine";
import { formatNumber } from "@/lib/format";
import { personName, viewerOf } from "@/lib/viewer";

const FIELD_LABELS: Record<string, string> = {
  leads_per_week: "Leads per week",
  active_clients: "Active clients",
  churn_monthly: "Monthly churn",
  retainer: "Monthly retainer",
  price: "price",
  mix_share: "mix share",
  headcount: "head-count",
  cost_rate: "cost rate",
  ongoing_hours: "client hours per client",
  fte: "FTE",
  work_hours: "hands-on time",
  wait_hours: "wait",
  rework_rate: "rework",
  churn_health_sensitivity: "churn sensitivity to health",
  initial: "Starting client health",
  recover: "Health gained per task on time",
  late_penalty: "Health lost per late task",
  missed_penalty: "Health lost per missed task",
};

const SHARES = new Set(["churn_monthly", "rework_rate", "mix_share"]);
const HOURS = new Set(["work_hours", "wait_hours", "ongoing_hours"]);

/** A patch in words: "Audit & proposal hands-on time −60%", "Strategist head-count +1". */
export function describePatch(model: EngineModel, patch: ScenarioPatch, retired: RetiredSteps = {}, viewer?: Viewer): string {
  const target = parsePatchPath(patch.path);
  if (!target) return patch.path;
  const field = target.field;
  let subject: string;
  if (target.kind === "demand" || target.kind === "finances" || target.kind === "health") subject = FIELD_LABELS[field]!;
  else {
    const id = target.id;
    const name =
      target.kind === "roles"
        ? id === "@busiest"
          ? "The busiest role"
          : model.roles[id]?.name
        : target.kind === "steps"
          ? id === "@heaviest"
            ? "The heaviest step"
            : (model.steps.find((s) => s.id === id)?.name ?? (retired[id] ? `${retired[id].name} (removed)` : undefined))
          : target.kind === "people"
            ? (model.people?.[id] ? personName(viewerOf({ viewer }), id, model.people[id].name) : undefined)
            : model.services?.[id]?.name;
    subject = `${name ?? "A removed item"}'s ${FIELD_LABELS[field]}`;
  }
  const value = (v: number) =>
    SHARES.has(field) ? `${formatNumber(v * 100, 1)}%` : HOURS.has(field) ? `${formatNumber(v, 1)} h` : formatNumber(v, 2);
  if (patch.op === "multiply") {
    const pct = Math.round((patch.value - 1) * 100);
    return `${subject} ${pct === 0 ? "×1" : pct > 0 ? `+${pct}%` : `−${-pct}%`}`;
  }
  if (patch.op === "add") return `${subject} ${patch.value >= 0 ? "+" : "−"}${value(Math.abs(patch.value))}`;
  return `${subject} → ${value(patch.value)}`;
}

/**
 * What stops a scenario applying to the model; empty when it applies
 * ("needs attention" otherwise, issue #16). `retired` names steps the model
 * no longer has and what replaced them (./broken.ts `retiredSteps`).
 */
export function scenarioProblems(model: EngineModel, scenario: Pick<ScenarioRow, "patch">, retired: RetiredSteps = {}): BrokenPatch[] {
  return checkScenario(model, scenario.patch, retired).broken;
}

/**
 * The patches to run: the applied scenarios in the order they were applied,
 * leaving out any that need attention, then the unsaved levers.
 */
export function effectivePatches(
  model: EngineModel,
  stack: readonly ScenarioRow[],
  levers: readonly ScenarioPatch[],
  retired: RetiredSteps = {},
): ScenarioPatch[] {
  return [...stack.filter((s) => !scenarioProblems(model, s, retired).length).flatMap((s) => s.patch), ...levers];
}

/** The compare headline's subject; lives in the engine so MCP `compare_scenarios` words it the same. */
export { headlineSubject } from "@transpera-flow/engine";

/** A name for a copy that isn't taken yet: "X (copy)", "X (copy 2)", … */
export function copyName(name: string, taken: readonly string[]): string {
  const base = `${name} (copy)`.slice(0, 120);
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${name} (copy ${n})`.slice(0, 120);
    if (!taken.includes(next)) return next;
  }
}

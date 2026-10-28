// A scenario's effective changes (docs/plans/sandbox-p1-brief.md §3): its parents' changes first (root first), then its own. This is what
// runs, and what the change list shows (inherited changes are read-only). Pure.

import { cappedMonths, MAX_CHANGE_MONTHS, MAX_PARENT_DEPTH, MAX_SOLUTION_CHANGES, type SandboxChange, type SandboxScenarioRow } from "@transpera-flow/db";

/** A change and the scenario it came from. */
export interface EffectiveChange {
  change: SandboxChange;
  scenarioId: string;
  scenarioName: string;
  /** True for a parent's change (shown read-only on the child). */
  inherited: boolean;
}

type Row = Pick<SandboxScenarioRow, "id" | "name" | "parent_id" | "changes">;

/**
 * The changes that run for `scenario` (which may be a draft not in `rows`): the chain of parents from the root down, then its own.
 * An error (not a throw) for a parent that is missing, a loop, or a chain deeper than the database takes.
 */
export function effectiveChanges(scenario: Row, rows: readonly Row[]): { ok: true; changes: EffectiveChange[]; parents: Row[] } | { ok: false; error: string } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parents: Row[] = [];
  const seen = new Set([scenario.id]);
  for (let at = scenario.parent_id; at; ) {
    if (seen.has(at)) return { ok: false, error: "These scenarios build on each other in a loop." };
    const parent = byId.get(at);
    if (!parent) return { ok: false, error: "The scenario this one builds on isn't there any more." };
    seen.add(at);
    parents.unshift(parent);
    if (parents.length > MAX_PARENT_DEPTH) return { ok: false, error: `Scenarios can build on each other up to ${MAX_PARENT_DEPTH} deep.` };
    at = parent.parent_id;
  }
  const tag = (r: Row, inherited: boolean) => r.changes.map((change): EffectiveChange => ({ change, scenarioId: r.id, scenarioName: r.name, inherited }));
  return { ok: true, changes: [...parents.flatMap((p) => tag(p, true)), ...tag(scenario, false)], parents };
}

/**
 * Why the effective changes can't run, or null: the parent chain adds up to more change months or solutions than one scenario may have
 * (the database checks each scenario alone; editing a parent could push a child over).
 */
export function effectiveLimitProblem(changes: readonly SandboxChange[]): string | null {
  if (cappedMonths(changes).length > MAX_CHANGE_MONTHS) return `Together with the scenarios it builds on, this has changes from more than ${MAX_CHANGE_MONTHS} different months.`;
  if (changes.filter((c) => c.lever === "E6").length > MAX_SOLUTION_CHANGES) return `Together with the scenarios it builds on, this puts more than ${MAX_SOLUTION_CHANGES} solutions live.`;
  return null;
}

/** The ids of the scenarios that build on `id`, directly or further down. */
export function descendantsOf(id: string, rows: readonly Pick<SandboxScenarioRow, "id" | "parent_id">[]): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length) {
    const at = queue.shift()!;
    for (const r of rows) {
      if (r.parent_id !== at || out.includes(r.id)) continue;
      out.push(r.id);
      queue.push(r.id);
    }
  }
  return out;
}

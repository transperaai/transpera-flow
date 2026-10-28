// Input checks behind the Sandbox Server Actions (app/w/[slug]/sandbox-actions.ts) and the Save button. They reject what the database
// would, with plain messages, and the one thing it cannot see: two solutions for one process going live in the same month, and the
// limits on the effective changes (a scenario with its parents'). Pure.

import { changesProblem, MAX_HORIZON_MONTHS, MAX_SCENARIO_DESCRIPTION, MAX_SCENARIO_NAME, type SandboxChange, type SolutionRow } from "@transpera-flow/db";
import { effectiveChanges, effectiveLimitProblem, descendantsOf } from "./effective";

export { isId } from "@/lib/sources/validate";

export interface SandboxInput {
  name: string;
  description: string | null;
  parent_id: string | null;
  changes: SandboxChange[];
  horizon_months: number;
}

/** What `parseSandboxInput` needs for the checks beyond the database's: the workspace's solutions and process names, and its scenarios. */
export interface SandboxParseContext {
  solutions: readonly Pick<SolutionRow, "id" | "process_id">[];
  processName: (processId: string) => string;
  /** The workspace's saved scenarios, for the parent and for the effective limits of this scenario and those that build on it. */
  scenarios?: readonly { id: string; name: string; parent_id: string | null; changes: SandboxChange[] }[];
  /** The scenario being saved (null: a new one). */
  selfId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Two solutions for one process can't go live in the same month. */
function solutionClash(changes: readonly SandboxChange[], context: SandboxParseContext): string | null {
  const processOf = new Map(context.solutions.map((s) => [s.id, s.process_id]));
  const taken = new Set<string>();
  for (const c of changes) {
    if (c.lever !== "E6") continue;
    const process = processOf.get(c.target ?? "");
    if (!process) continue;
    const key = `${process}|${(c.from ?? "").slice(0, 7)}`;
    if (taken.has(key)) return `Two solutions for ${context.processName(process)} can't go live in the same month.`;
    taken.add(key);
  }
  return null;
}

/** A scenario as typed, checked as the database checks it, plus the checks the database can't make. */
export function parseSandboxInput(input: unknown, context?: SandboxParseContext): { ok: true; value: SandboxInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "That scenario isn't valid." };
  const { name: rawName, description: rawDescription, parent_id: rawParent, changes, horizon_months: horizon } = input as Record<string, unknown>;
  if (typeof rawName !== "string" || !rawName.trim()) return { ok: false, error: "Give the scenario a name." };
  const name = rawName.trim();
  if (name.length > MAX_SCENARIO_NAME) return { ok: false, error: `A scenario's name can have up to ${MAX_SCENARIO_NAME} characters.` };
  if (rawDescription !== undefined && rawDescription !== null && typeof rawDescription !== "string") return { ok: false, error: "That description isn't valid." };
  const description = typeof rawDescription === "string" && rawDescription.trim() ? rawDescription.trim() : null;
  if (description && description.length > MAX_SCENARIO_DESCRIPTION) return { ok: false, error: `A description can have up to ${MAX_SCENARIO_DESCRIPTION} characters.` };
  if (rawParent !== undefined && rawParent !== null && (typeof rawParent !== "string" || !UUID.test(rawParent))) return { ok: false, error: "That scenario isn't valid." };
  const parent_id = (rawParent as string | null | undefined) ?? null;
  if (horizon !== undefined && (typeof horizon !== "number" || !Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON_MONTHS)) return { ok: false, error: `The horizon is 1 to ${MAX_HORIZON_MONTHS} months.` };
  const problem = changesProblem(changes);
  if (problem) return { ok: false, error: problem };
  const list = changes as SandboxChange[];
  const value: SandboxInput = { name, description, parent_id, changes: list, horizon_months: (horizon as number | undefined) ?? 12 };
  if (context) {
    const clash = solutionClash(list, context);
    if (clash) return { ok: false, error: clash };
    const rows = context.scenarios ?? [];
    if (parent_id !== null && !rows.some((r) => r.id === parent_id)) return { ok: false, error: "The scenario this one builds on isn't there any more." };
    if (parent_id !== null && context.selfId && (parent_id === context.selfId || descendantsOf(context.selfId, rows).includes(parent_id))) {
      return { ok: false, error: "A scenario can't build on itself or on one that builds on it." };
    }
    // This scenario's own effective changes, then each scenario that builds on it (editing a parent could push a child over).
    const self = { id: context.selfId ?? "new", name, parent_id, changes: list };
    const others = rows.filter((r) => r.id !== self.id);
    const mine = effectiveChanges(self, others);
    if (!mine.ok) return { ok: false, error: mine.error };
    const own = effectiveLimitProblem(mine.changes.map((c) => c.change)) ?? solutionClash(mine.changes.map((c) => c.change), context);
    if (own) return { ok: false, error: own };
    if (context.selfId) {
      const withSelf = [...others, self];
      for (const id of descendantsOf(context.selfId, others)) {
        const child = withSelf.find((r) => r.id === id)!;
        const eff = effectiveChanges(child, withSelf);
        const bad = eff.ok ? effectiveLimitProblem(eff.changes.map((c) => c.change)) : eff.error;
        if (bad) return { ok: false, error: `“${child.name}” builds on this one: ${bad.replace(/^Together with the scenarios it builds on, this/, "it")}` };
      }
    }
  }
  return { ok: true, value };
}

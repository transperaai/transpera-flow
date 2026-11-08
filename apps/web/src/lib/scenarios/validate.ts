// Input checks behind the scenario Server Actions (app/w/[slug]/scenario-actions.ts).
// They only reject malformed input early: the database checks the patch shape
// again (private.is_sandbox_changes) and RLS decides who may write.

import { parsePatches, type ScenarioPatch } from "@transpera-flow/engine";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const MAX_NAME = 120;
export const MAX_DESCRIPTION = 2000;

export interface ScenarioInput {
  name: string;
  description: string | null;
  patch: ScenarioPatch[];
  parent_scenario_id: string | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A scenario to save: a name, an optional description, at least one patch, and the scenario it copies (if any). */
export function parseScenarioInput(input: unknown): Parsed<ScenarioInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "That scenario isn't valid." };
  const { name, description, patch, parent_scenario_id: parent } = input as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim()) return { ok: false, error: "Give the scenario a name." };
  if (name.trim().length > MAX_NAME) return { ok: false, error: `Keep the name to ${MAX_NAME} characters.` };
  if (description !== undefined && description !== null && typeof description !== "string") return { ok: false, error: "That description isn't valid." };
  const desc = typeof description === "string" && description.trim() ? description.trim() : null;
  if (desc && desc.length > MAX_DESCRIPTION) return { ok: false, error: `Keep the description to ${MAX_DESCRIPTION} characters.` };
  const patches = parsePatches(patch);
  if (!patches.ok) return { ok: false, error: patches.error };
  if (!patches.patches.length) return { ok: false, error: "Move at least one lever before saving." };
  if (parent !== undefined && parent !== null && !isId(parent)) return { ok: false, error: "That scenario isn't valid." };
  return { ok: true, value: { name: name.trim(), description: desc, patch: patches.patches, parent_scenario_id: parent ?? null } };
}

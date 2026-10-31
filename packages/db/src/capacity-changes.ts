// Capacity changes as stored objects (capacity build P7, docs/plans/capacity/p7-sandbox-brief.md section 1; migration 20270123000000).
//
// A change is an automation or augmentation that acts on parts of steps: the engine's `StepChangeEffect[]` (with step ids), its adoption, its ramp,
// the tiers it applies to, what it costs a month, the issue it fixes and where its numbers came from. The Sandbox swaps one in for a step from a
// month: `toEngineStepChange(row, startMonth)` is the engine's `EngineStepChange` for that. Nothing here touches `toEngineModel`: today's model has
// no `changes` unless P2b's example workspace puts some there.
//
// Pure functions, plus the one reader. The writes are the web app's server actions (apps/web/src/app/w/[slug]/capacity-change-actions.ts).

import type { EngineStepChange, SourceLabel, StepChangeEffect } from "@transpera-flow/engine";
import type { Db } from "./queries";

export interface CapacityChangeRow {
  id: string;
  name: string;
  kind: "automation" | "augmentation";
  effects: StepChangeEffect[];
  adoption: number;
  ramp_months: number;
  /** Tier keys, or null for every tier. */
  tiers: string[] | null;
  cost_monthly: number | null;
  issue_id: string | null;
  source: SourceLabel;
  provenance: Record<string, unknown>;
}

/** What a person types or picks to make or edit a change (the id is the database's). */
export interface CapacityChangeInput {
  name: string;
  kind: CapacityChangeRow["kind"];
  effects: StepChangeEffect[];
  adoption: number;
  ramp_months: number;
  tiers: string[] | null;
  cost_monthly: number | null;
  issue_id: string | null;
  source: SourceLabel;
}

export const MAX_CHANGE_EFFECTS = 40;
export const CHANGE_SOURCES: readonly SourceLabel[] = ["interview", "calculator", "measured", "estimate"];

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const STEP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the workspace's changes, oldest first, as the signed-in user (members read). */
export async function loadCapacityChanges(db: Db, workspaceId: string): Promise<CapacityChangeRow[]> {
  const rows = await db
    .selectFrom("capacity_changes")
    .select(["id", "name", "kind", "effects", "adoption", "ramp_months", "tiers", "cost_monthly", "issue_id", "source", "provenance"])
    .where("workspace_id", "=", workspaceId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind as CapacityChangeRow["kind"],
    effects: (Array.isArray(r.effects) ? r.effects : []) as StepChangeEffect[],
    adoption: Number(r.adoption),
    ramp_months: Number(r.ramp_months),
    tiers: r.tiers ?? null,
    cost_monthly: r.cost_monthly === null ? null : Number(r.cost_monthly),
    issue_id: r.issue_id,
    source: r.source as SourceLabel,
    provenance: (r.provenance ?? {}) as Record<string, unknown>,
  }));
}

/** The engine's change for a row swapped in from the 1-based `startMonth`. */
export function toEngineStepChange(row: Pick<CapacityChangeRow, "id" | "name" | "kind" | "effects" | "adoption" | "ramp_months" | "tiers" | "issue_id">, startMonth: number): EngineStepChange {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    effects: row.effects.map((e) => ({ ...e })),
    adoption: row.adoption,
    startMonth,
    rampMonths: row.ramp_months,
    ...(row.tiers && row.tiers.length ? { tiers: [...row.tiers] } : {}),
    ...(row.issue_id ? { issueId: row.issue_id } : {}),
  };
}

/** The ids of the steps a change acts on, in order of first use. */
export function changeStepIds(change: Pick<CapacityChangeRow, "effects">): string[] {
  const out: string[] = [];
  for (const e of change.effects) if (!out.includes(e.step)) out.push(e.step);
  return out;
}

/** The changes that act on a step. */
export function changesActingOn<T extends Pick<CapacityChangeRow, "effects">>(changes: readonly T[], stepId: string): T[] {
  return changes.filter((c) => c.effects.some((e) => e.step === stepId));
}

const PART_WORDS = { automatable: "the automatable part", augmentable: "the augmentable part" } as const;

/** One effect in plain words: "Removes 85% of the automatable part, 2 min of checking left." */
export function describeEffect(e: StepChangeEffect): string {
  if (e.part === "automatable") {
    const left = e.residualHours && e.residualHours > 0 ? `, ${Math.round(e.residualHours * 60)} min of checking left` : "";
    return `Removes ${Math.round(e.remove * 100)}% of ${PART_WORDS.automatable}${left}`;
  }
  return `Speeds up ${PART_WORDS.augmentable} ${Math.round(e.factor * 100) / 100} times`;
}

/** What is wrong with a change as typed, in plain words, or null. `stepIds` is the steps that exist (when given, an effect must point at one). */
export function checkCapacityChange(input: CapacityChangeInput, stepIds?: ReadonlySet<string>): string | null {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 200) return "Give the change a name of up to 200 characters.";
  if (input.kind !== "automation" && input.kind !== "augmentation") return "Choose automation or augmentation.";
  if (!isFiniteNumber(input.adoption) || input.adoption < 0 || input.adoption > 1) return "Adoption is a share from 0% to 100%.";
  if (!Number.isInteger(input.ramp_months) || input.ramp_months < 0 || input.ramp_months > 24) return "Months to full effect is a whole number from 0 to 24.";
  if (input.cost_monthly !== null && (!isFiniteNumber(input.cost_monthly) || input.cost_monthly < 0 || input.cost_monthly > 10_000_000)) return "What it costs a month must be 0 or more.";
  if (input.tiers !== null && (input.tiers.length < 1 || input.tiers.length > 20)) return "Pick at least one tier, or leave it for every tier.";
  if (!CHANGE_SOURCES.includes(input.source)) return "Say where the numbers came from.";
  if (!input.effects.length) return "Add at least one effect: a step and the part of it the change acts on.";
  if (input.effects.length > MAX_CHANGE_EFFECTS) return `A change has at most ${MAX_CHANGE_EFFECTS} effects.`;
  for (const e of input.effects) {
    // With the steps that exist given, that set decides; without it, the id must at least be a step id's shape (the table checks the same).
    if (typeof e.step !== "string" || (stepIds ? !stepIds.has(e.step) : !STEP_ID.test(e.step))) return "An effect points at a step that isn't there.";
    if (e.part === "automatable") {
      if (!isFiniteNumber(e.remove) || e.remove < 0 || e.remove > 1) return "The share an automation removes is from 0% to 100%.";
      if (e.residualHours !== undefined && (!isFiniteNumber(e.residualHours) || e.residualHours < 0 || e.residualHours > 1000)) return "Checking time is 0 or more.";
    } else if (e.part === "augmentable") {
      if (!isFiniteNumber(e.factor) || e.factor < 1 || e.factor > 100) return "An augmentation speeds a part up by at least 1 times.";
    } else return "An effect acts on the automatable or the augmentable part.";
  }
  return null;
}

/** The input as it will be stored: trimmed name, effects with only their own keys. */
export function cleanCapacityChange(input: CapacityChangeInput): CapacityChangeInput {
  return {
    ...input,
    name: input.name.trim(),
    effects: input.effects.map((e) =>
      e.part === "automatable"
        ? { step: e.step, part: "automatable" as const, remove: e.remove, ...(e.residualHours !== undefined && e.residualHours > 0 ? { residualHours: e.residualHours } : {}) }
        : { step: e.step, part: "augmentable" as const, factor: e.factor },
    ),
    tiers: input.tiers && input.tiers.length ? [...new Set(input.tiers)] : null,
  };
}

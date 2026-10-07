// Per-person times in calibration (issue #227): what the page needs to propose them, and who may see them. Framework-free.
//
// Privacy (PRD D20): only owners, editors and agency admins with Per-person times switched on get anything here. For everyone
// else the setup is `hidden`, so nothing per-person is computed or shown. Nothing here sorts people or times by value: people
// stay in the roster's order and steps in the process's.

import type { PersonTimeProposal, PersonTimesPerson } from "@transpera-flow/engine";
import { hidesPay, type ProcessBundle, type StepRow } from "@transpera-flow/db";
import { stepsPersonCanDo } from "@/lib/people";

export type PersonTimesSetup =
  /** Members and viewers: nothing per-person is shown or computed. */
  | { state: "hidden" }
  /** Owners, editors and agency admins with the switch off. */
  | { state: "off" }
  | { state: "on"; people: { id: string; name: string }[]; persons: PersonTimesPerson[] };

export function personTimesSetup(live: ProcessBundle, steps: readonly StepRow[]): PersonTimesSetup {
  if (hidesPay(live)) return { state: "hidden" };
  if (live.workspace.settings.capacity_factor_enabled !== true) return { state: "off" };
  const active = live.people.filter((p) => p.active !== false);
  const factors = live.personCapacityFactors ?? [];
  const source = (s: string): "entered" | "measured" => (s === "measured" ? "measured" : "entered");
  return {
    state: "on",
    people: active.map((p) => ({ id: p.id, name: p.name })),
    persons: active.map((p) => {
      const mine = factors.filter((f) => f.person_id === p.id);
      const every = mine.find((f) => f.step_id === null);
      const byStep: Record<string, { factor: number; source: "entered" | "measured" }> = {};
      for (const f of mine) if (f.step_id !== null) byStep[f.step_id] = { factor: Number(f.factor), source: source(f.source) };
      return {
        id: p.id,
        canDo: stepsPersonCanDo(p.id, steps, live.personSkills ?? [], live.personRoles ?? []).map((s) => s.id),
        every: every ? { factor: Number(every.factor), source: source(every.source) } : null,
        steps: byStep,
      };
    }),
  };
}

/** Ticked to start with: a value to set that changes something, isn't within the usual spread, isn't at a bound, and doesn't replace an entered time. */
export const initiallyTickedFactor = (p: PersonTimeProposal): boolean => Boolean(p.set) && p.changed && !p.within && !p.limited && p.currentSource !== "entered";

/** A proposal can be ticked when it has a value that would change something. */
export const selectableFactor = (p: PersonTimeProposal): boolean => Boolean(p.set) && p.changed;

/** The proposals grouped by person, in the order of `people` (the roster); people with no proposal are left out. */
export function groupByPerson(
  proposals: readonly PersonTimeProposal[],
  people: readonly { id: string; name: string }[],
): { person: { id: string; name: string }; proposals: PersonTimeProposal[] }[] {
  const out: { person: { id: string; name: string }; proposals: PersonTimeProposal[] }[] = [];
  for (const person of people) {
    const mine = proposals.filter((p) => p.personId === person.id);
    if (mine.length) out.push({ person, proposals: mine });
  }
  return out;
}

const HEX = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A per-person key: `factor:<person id>:<step id>`. */
export const factorKeyRe = new RegExp(`^factor:${HEX}:${HEX}$`, "i");

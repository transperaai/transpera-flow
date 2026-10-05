// Who can work a step, as the engine dispatches it. Its own module so the engine
// (simulate.ts), the absence test and the key-person facts share one rule.

import type { EnginePerson, EngineStep } from "./model";

/** Whether the person can work the step: pinned to it, skilled for it, or holding its role. */
export function eligible(personId: string, p: EnginePerson, s: EngineStep): boolean {
  if (s.person) return s.person === personId;
  if (p.skills) return p.skills.includes(s.id);
  return s.role !== null && p.roles.includes(s.role);
}

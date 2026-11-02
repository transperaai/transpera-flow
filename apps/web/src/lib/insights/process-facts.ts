// The facts a process page shows (Austin, 2 Nov): only those about this process. The run covers the whole company, so its
// facts name people and roles from every process; a process page keeps a fact when it is about one of its own steps, about
// a person who works its steps (pinned to one, or with hands-on hours on one in the run), about a role its steps use (a fact
// about the role as a whole, with no person), or about the process as a whole (no step, role, person, client or scenario).

import type { DetectedIssue, SimulationResult } from "@transpera-flow/engine";

export interface ProcessScope {
  steps: readonly { id: string; role_id: string | null; person_id: string | null }[];
}

export function factsForProcess(facts: readonly DetectedIssue[], process: ProcessScope, result: Pick<SimulationResult, "personTime"> | null): DetectedIssue[] {
  const steps = new Set(process.steps.map((s) => s.id));
  const roles = new Set(process.steps.flatMap((s) => (s.role_id ? [s.role_id] : [])));
  const people = new Set(process.steps.flatMap((s) => (s.person_id ? [s.person_id] : [])));
  for (const [person, hours] of Object.entries(result?.personTime?.stepHours ?? {})) {
    if (Object.entries(hours).some(([step, h]) => steps.has(step) && h > 0)) people.add(person);
  }
  return facts.filter((f) => {
    if (f.personId) return people.has(f.personId);
    if (f.roleId) return roles.has(f.roleId);
    if (f.stepId) return steps.has(f.stepId);
    return !f.clientId && !f.scenarioId;
  });
}

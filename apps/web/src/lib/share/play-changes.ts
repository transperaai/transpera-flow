// Build it on a visitor's idea (issue #33, B4): the lever changes it carries, checked against the live process as it is NOW. This is the
// server-side half of "redacted ids mapped back to real ones": a snapshot keeps real ids (they seed the engine's random streams), so
// nothing is translated. A change is kept only when it is well formed and its step, role, person or service is still in the live
// process; the rest are dropped with one plain note. Pure.

import type { ProcessBundle } from "@transpera-flow/db";
import { parsePatches, type ScenarioPatch } from "@transpera-flow/engine";

const ID_PATH = /^(services|roles|people|steps)\.([^.]+)\.[a-z_]+$/;

/** The ids the live process still has: its steps (and the steps of the processes inside it), roles, people and services. */
function liveIds(live: ProcessBundle) {
  return {
    steps: new Set([...live.steps, ...(live.otherProcesses ?? []).flatMap((p) => p.steps)].map((s) => s.id)),
    roles: new Set(live.roles.map((r) => r.id)),
    people: new Set(live.people.map((p) => p.id)),
    services: new Set(live.services.map((s) => s.id)),
  };
}

export function mapPlayChanges(levers: unknown, live: ProcessBundle): { levers: ScenarioPatch[]; notes: string[] } {
  const raw = Array.isArray(levers) ? levers : [];
  const ids = liveIds(live);
  const kept: ScenarioPatch[] = [];
  let dropped = 0;
  for (const one of raw) {
    const parsed = parsePatches([one]);
    if (!parsed.ok) {
      dropped++;
      continue;
    }
    const patch = parsed.patches[0]!;
    const m = ID_PATH.exec(patch.path);
    if (m) {
      const [, family, id] = m as unknown as [string, "services" | "roles" | "people" | "steps", string];
      // A selector ("@busiest") names no id: the Editor's patch grammar resolves it, and a visitor can't send one anyway.
      if (!id.startsWith("@") && !ids[family].has(id)) {
        dropped++;
        continue;
      }
    }
    kept.push(patch);
  }
  const notes = dropped ? [`${dropped} of the visitor's changes no longer apply (a step, role or service has gone since they sent it).`] : [];
  return { levers: kept, notes };
}

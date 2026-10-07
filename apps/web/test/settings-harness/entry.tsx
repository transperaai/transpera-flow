// The Simulation and People parts of Settings on a bare page, for ../settings-browser.test.ts (C6, issue #198): the real
// components with the Server Actions stood in for by ../build-harness.ts (each call is noted on `window.__serverActions`).
// Nothing here ships.

import { createRoot } from "react-dom/client";
import { larkspurBundle, larkspurPersonIds, type PersonCapacityFactorRow } from "@transpera-flow/db";
import { PeopleSettings, SimulationSettings } from "@/app/w/[slug]/settings/people-settings";
import type { WorkspaceSettingsData } from "@/lib/data";

declare global {
  interface Window {
    mountSettings: (options: {
      who: "owner" | "editor" | "member";
      switch?: boolean;
      factors?: PersonCapacityFactorRow[];
      /** What the stood-in save of a time answers: saved (the default is the Server Action, which answers an error here), or someone else's value. */
      factorSaves?: "saved" | { conflict: number };
      /** Hand the page every row, as a bug would: a member's screen must still show only their own. */
      unfiltered?: boolean;
    }) => void;
    __serverActions?: { name: string; args: unknown[] }[];
  }
}

window.mountSettings = ({ who, switch: on = false, factors = [], factorSaves, unfiltered = false }) => {
  const b = larkspurBundle();
  const own = larkspurPersonIds.jess!;
  // A member's Settings read holds only their own person (RLS, `can_see_person`) and their own factors.
  const people = (who === "member" ? b.people.filter((p) => p.id === own) : b.people).map((p) => ({ ...p, email: null, notes: null }));
  const ids = new Set(people.map((p) => p.id));
  const steps = b.steps.filter((s) => s.role_id).map((s) => ({ id: s.id, name: s.name, role_id: s.role_id }));
  const data = {
    workspace: { ...b.workspace, settings: { ...b.workspace.settings, ...(on ? { capacity_factor_enabled: true } : {}) } },
    canEdit: who !== "member",
    canManage: who === "owner",
    roles: b.roles.map((r) => ({ id: r.id, name: r.name, color: r.color, active: r.active })),
    roleUsage: {},
    steps,
    people,
    personRoles: b.personRoles.filter((r) => ids.has(r.person_id)),
    personSkills: b.personSkills.filter((r) => ids.has(r.person_id)),
    personLeave: b.personLeave.filter((r) => ids.has(r.person_id)).map((l) => ({ ...l, note: null })),
    // As RLS gives them: a member's read holds only their own person's rows. `unfiltered` hands the page the lot instead.
    personCapacityFactors: unfiltered ? factors : factors.filter((f) => ids.has(f.person_id)),
  } as unknown as WorkspaceSettingsData;
  createRoot(document.getElementById("root")!).render(
    <div className="flex flex-col gap-6 p-4">
      <SimulationSettings data={data} />
      <PeopleSettings
        data={data}
        saveFactor={
          factorSaves === undefined
            ? undefined
            : async (_person, _step, _base, value) => (factorSaves === "saved" ? { status: "saved", value } : { status: "conflict", theirs: factorSaves.conflict })
        }
      />
    </div>,
  );
};

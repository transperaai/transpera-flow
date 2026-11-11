// Screenshots for Q14 (docs/plans/capacity/q14-shots): the People & roles page built from the real components and the example agency
// (the engine's `capacityModel()` through `capacitySetupFromModel`), in the frame the page uses. Test only, nothing here ships.

import { createRoot } from "react-dom/client";
import { capacitySetupFromModel } from "@transpera-flow/db";
import { capacityModel } from "@transpera-flow/engine";
import { PeopleAndRoles, PeopleHeaderActions } from "@/components/setup/people-roles";
import { peopleMeta } from "@/lib/setup/people-meta";
import { SettingsPage } from "@/components/settings/settings-page";
import { SettingsBand } from "@/components/settings/settings-band";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { WorkspaceSettingsData } from "@/lib/data";

declare global {
  interface Window {
    /** Mounts the page; `open` is "facing" or "shared" (the first such person's panel), `role` a role name. Returns the two names. */
    mountQ14: (options: { open?: "facing" | "shared"; role?: string }) => void;
  }
}

const WS = "00000000-0000-4000-8000-000000000001";

window.mountQ14 = ({ open, role }) => {
  const setup = capacitySetupFromModel(capacityModel(), { canEdit: true });
  const kindOf = (p: (typeof setup.people)[number]) => setup.roles.find((r) => r.id === p.role_ids[0])?.kind;
  const target = open === "facing" ? setup.people.find((p) => kindOf(p) === "client_facing") : open === "shared" ? setup.people.find((p) => kindOf(p) === "shared") : undefined;
  const data = {
    workspace: { id: WS, name: "Northbeam", slug: "northbeam", settings: { currency: "AUD", hours_per_week: 38 } },
    canEdit: true,
    canManage: true,
    roles: setup.roles.map((r) => ({ id: r.id, name: r.name, color: null, active: r.active, leadership: r.leadership })),
    roleUsage: {},
    steps: [],
    people: setup.people.map((p) => ({ id: p.id, workspace_id: WS, name: p.name, email: p.email, fte: p.fte, capacity_hours_week: p.capacity_hours_week, cost_rate: null, active: p.active, start_date: p.start_date, end_date: p.end_date, notes: p.notes })),
    personRoles: setup.people.flatMap((p) => p.role_ids.map((r) => ({ person_id: p.id, role_id: r, workspace_id: WS }))),
    personSkills: [],
    personLeave: [],
    personCapacityFactors: [],
  } as unknown as WorkspaceSettingsData;
  createRoot(document.getElementById("root")!).render(
    <SidebarProvider>
      <main className="min-w-0 flex-1">
        {/* People & roles is a section of the one Settings page: its band, as page.tsx renders it. */}
        <SettingsPage title="Workspace settings" eyebrow="Settings">
          <PhoneNotice />
          <SettingsBand id="people-roles" title="People & roles" description={`${peopleMeta(setup).join(" · ")}: people and roles open into a panel; then how the shared teams work.`} action={<PeopleHeaderActions setup={setup} data={data} />}>
            <PeopleAndRoles setup={setup} data={data} />
          </SettingsBand>
        </SettingsPage>
      </main>
    </SidebarProvider>,
  );
  // Open a panel by clicking its row once it has rendered.
  setTimeout(() => {
    const sel = target ? `[data-person="${target.name}"]` : role ? `[data-role="${role}"]` : null;
    if (sel) (document.querySelector(sel) as HTMLElement | null)?.click();
  }, 300);
};

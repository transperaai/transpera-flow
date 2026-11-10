// Screenshots for Q11 group B (docs/plans/capacity/q11-shots/b): Set up and Settings pages on a bare page, built from the real components
// in the same frame the pages use. Test only, nothing here ships.

import { createRoot } from "react-dom/client";
import { build } from "../setup-harness/entry";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { DEFAULT_PURPOSES } from "@transpera-flow/db";
import { PurposesSettings } from "@/components/purposes/purposes-settings";
import { ChurnDriversSettings } from "@/app/w/[slug]/settings/churn-drivers-settings";
import { TiersAndClients } from "@/components/setup/tiers-clients";
import { PeopleAndRoles, PeopleHeaderActions } from "@/components/setup/people-roles";
import { peopleMeta } from "@/lib/setup/people-meta";
import { SettingsPage } from "@/components/settings/settings-page";
import { LinkRows } from "@/components/settings/link-rows";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SimulationSettings } from "@/app/w/[slug]/settings/people-settings";
import { SettingsSection } from "@/app/w/[slug]/settings/section";
import { HealthSettings } from "@/app/w/[slug]/settings/servicing-settings";
import { WorkspaceDetails } from "@/app/w/[slug]/settings/workspace-details";
import { saveOverheadMonthly } from "@/app/w/[slug]/settings/actions";
import { saveWorkspaceCurrency, saveWorkspaceName } from "@/app/w/[slug]/settings/workspace-actions";

declare global {
  interface Window {
    mountQ11b: (what: string) => void;
  }
}

window.mountQ11b = (what) => {
  if (what === "sidebar") {
    // Q19: the workspace tile is always the monogram. The live shell, as the layout builds it, around a stand-in page.
    createRoot(document.getElementById("root")!).render(
      <WorkspaceShell
        mode="live"
        defaultOpen
        slug="northbeam"
        workspaceName="Northbeam Digital"
        workspaces={[{ name: "Northbeam Digital", href: "/w/northbeam" }, { name: "Larkspur Studio", href: "/w/larkspur" }]}
        counts={{ processes: 6, openIssues: 3 }}
        viewer={{ name: "Olive Owner", email: "olive@northbeam.example" }}
      >
        <main className="p-6 text-sm text-muted-foreground">The page goes here.</main>
      </WorkspaceShell>,
    );
    return;
  }
  const { setup, data, roster } = build("owner", 0);
  let page: React.ReactNode = null;
  if (what === "setup-clients") {
    page = (
      <SettingsPage title="Tiers & clients" eyebrow="Settings" description="Where tiers, tier counts and named clients are keyed in. A named client starts from its tier's values; anything filled in replaces them. Agency admins and the Owner can change this; everyone can read it.">
        <PhoneNotice />
        <p className="px-1 text-sm text-fg-2" data-unique-clients>
          <b className="text-foreground">8</b> unique clients: 6 with Organic, 3 with Performance, 1 taking both services.
        </p>
        <TiersAndClients setup={setup} data={data} roster={roster} />
      </SettingsPage>
    );
  } else if (what === "setup-people") {
    page = (
      <SettingsPage title="People & roles" eyebrow="Settings" description={peopleMeta(setup)} actions={<PeopleHeaderActions setup={setup} data={data} />}>
        <PhoneNotice />
        <PeopleAndRoles setup={setup} data={data} />
      </SettingsPage>
    );
  } else if (what === "settings") {
    page = (
      <SettingsPage
        title="Settings"
        eyebrow="Company"
        description="Changes save as you go. If someone else changes the same field at the same time, you'll be asked which value to keep."
      >
        <PhoneNotice />
        <SettingsSection id="services" title="Clients and team" description="Tiers, clients, roles and people have a page each, as the capacity figures' inputs.">
          <LinkRows label="Settings pages" items={[
            { href: "#", title: "Tiers & clients", description: "Tiers (pricing, entry process, servicing steps, path tags), tier client counts and optional named clients." },
            { href: "#", title: "People & roles", description: "Roles, shared teams, people (hours, leave, skills, dates, per-person times), salaries and portfolios." },
          ]} />
        </SettingsSection>
        <WorkspaceDetails workspaceId={data.workspace.id} name="Acme" currency="AUD" overheadMonthly={18000} canManage saveName={saveWorkspaceName} saveCurrency={saveWorkspaceCurrency} saveOverhead={saveOverheadMonthly} />
        <SimulationSettings data={data} />
        <PurposesSettings mode="live" workspaceId={data.workspace.id} stored={null} initial={DEFAULT_PURPOSES.map((c) => ({ ...c }))} use={{ winning: 3 }} save={async () => ({ status: "error", message: "n/a" })} />
        <ChurnDriversSettings mode="demo" workspaceId={null} bundle={null} rows={[]} />
        <HealthSettings data={data} />
      </SettingsPage>
    );
  } else if (what === "purposes") {
    page = (
      <SettingsPage title="Settings" eyebrow="Company">
        <PurposesSettings mode="live" workspaceId={data.workspace.id} stored={[] as never} initial={[] as never} use={{} as never} save={(async () => ({ status: "error", message: "n/a" })) as never}>
          <p className="text-sm text-muted-foreground">Time by these categories is shown in the Sandbox and on the Overview.</p>
        </PurposesSettings>
      </SettingsPage>
    );
  }
  createRoot(document.getElementById("root")!).render(<SidebarProvider><main className="min-w-0 flex-1">{page}</main></SidebarProvider>);
};

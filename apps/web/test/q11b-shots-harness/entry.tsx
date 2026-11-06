// Screenshots for Q11 group B (docs/plans/capacity/q11-shots/b): Set up and Settings pages on a bare page, built from the real components
// in the same frame the pages use. Test only, nothing here ships.

import Link from "next/link";
import { createRoot } from "react-dom/client";
import { build } from "../setup-harness/entry";
import { BrandingSettings } from "@/components/branding/branding-settings";
import { ChangeLog } from "@/components/change-log";
import { PurposesSettings } from "@/components/purposes/purposes-settings";
import { TiersAndClients } from "@/components/setup/tiers-clients";
import { PeopleAndRoles, PeopleHeaderActions, peopleMeta } from "@/components/setup/people-roles";
import { SettingsPage } from "@/components/settings/settings-page";
import { LinkRows } from "@/components/settings/link-rows";
import { SectionCard } from "@/components/page-kit";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { buttonVariants } from "@/components/ui/button";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SimulationSettings } from "@/app/w/[slug]/settings/people-settings";
import { SettingsSection } from "@/app/w/[slug]/settings/section";
import { HealthSettings } from "@/app/w/[slug]/settings/servicing-settings";
import { WorkspaceDetails } from "@/app/w/[slug]/settings/workspace-details";
import { saveOverheadMonthly } from "@/app/w/[slug]/settings/actions";
import { saveWorkspaceCurrency, saveWorkspaceName } from "@/app/w/[slug]/settings/workspace-actions";
import { readBranding } from "@/lib/branding/branding";

declare global {
  interface Window {
    mountQ11b: (what: string) => void;
  }
}

window.mountQ11b = (what) => {
  const { setup, data, roster } = build("owner", 0);
  let page: React.ReactNode = null;
  if (what === "setup-clients") {
    page = (
      <SettingsPage title="Tiers & clients" eyebrow="Set up" description="Where tiers, tier counts and named clients are keyed in. A named client starts from its tier's values; anything filled in replaces them. Agency admins and the Owner can change this; everyone can read it." width="max-w-6xl">
        <PhoneNotice />
        <p className="px-1 text-sm text-fg-2" data-unique-clients>
          <b className="text-foreground">8</b> unique clients: 6 with Organic, 3 with Performance, 1 taking both services.
        </p>
        <TiersAndClients setup={setup} data={data} roster={roster} />
      </SettingsPage>
    );
  } else if (what === "setup-people") {
    page = (
      <SettingsPage title="People & roles" eyebrow="Set up" description={peopleMeta(setup)} actions={<PeopleHeaderActions setup={setup} data={data} />} width="max-w-6xl">
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
        <SectionCard id="more-settings" title="More settings" description="The rest of Settings has a page each.">
          <LinkRows label="Settings pages" items={[
            { href: "#", title: "Branding", description: "A logo and an accent colour that make this workspace look like the client's." },
            { href: "#", title: "Purposes", description: "The categories a step's \"What it achieves\" is chosen from." },
            { href: "#", title: "Historical data", description: "Import past data, check it against the model and apply the changes you choose." },
            { href: "#", title: "Change log", description: "Who changed the company model, and what they changed." },
          ]} />
        </SectionCard>
        <WorkspaceDetails workspaceId={data.workspace.id} name="Acme" currency="AUD" overheadMonthly={18000} canManage saveName={saveWorkspaceName} saveCurrency={saveWorkspaceCurrency} saveOverhead={saveOverheadMonthly} />
        <SimulationSettings data={data} />
        <SettingsSection id="services" title="Services, clients, roles and people" description="These moved to Set up, where the capacity figures' inputs are keyed in.">
          <LinkRows label="Set up pages" items={[
            { href: "#", title: "Tiers & clients", description: "Services (pricing, entry process, servicing steps, path tags), tiers, counted clients, named clients and the client health benchmark." },
            { href: "#", title: "People & roles", description: "Roles, shared teams, people (hours, leave, skills, dates, per-person times), salaries and portfolios." },
          ]} />
        </SettingsSection>
        <HealthSettings data={data} />
      </SettingsPage>
    );
  } else if (what === "branding") {
    page = (
      <SettingsPage title="Branding" eyebrow="Settings" description="Make this workspace look like the client's: a logo and an accent colour. Changes save as you go." actions={<Link href="#" className={buttonVariants({ variant: "outline" })}>Back to settings</Link>}>
        <PhoneNotice />
        <BrandingSettings mode="live" workspaceId={data.workspace.id} name="Acme" branding={readBranding({})} logoSha={null} logoUrl={null} saveAccent={async () => ({ status: "error", message: "n/a" })} removeLogo={async () => ({ status: "error", message: "n/a" })} />
      </SettingsPage>
    );
  } else if (what === "changes") {
    page = (
      <SettingsPage title="Change log" eyebrow="Company" description="Who changed the company model, and what they changed.">
        <ChangeLog entries={[]} model={{} as never} people={{}} stepNames={{}} />
      </SettingsPage>
    );
  } else if (what === "purposes") {
    page = (
      <SettingsPage title="Purposes" eyebrow="Settings">
        <PurposesSettings mode="live" workspaceId={data.workspace.id} stored={[] as never} initial={[] as never} use={{} as never} save={(async () => ({ status: "error", message: "n/a" })) as never}>
          <p className="text-sm text-muted-foreground">Time by these categories is shown in the Sandbox and on the Overview.</p>
        </PurposesSettings>
      </SettingsPage>
    );
  }
  createRoot(document.getElementById("root")!).render(<SidebarProvider><main className="min-w-0 flex-1">{page}</main></SidebarProvider>);
};

// Screenshots for Q11 group B (docs/plans/capacity/q11-shots/b): Set up and Settings pages on a bare page, built from the real components
// in the same frame the pages use. Test only, nothing here ships.

import Link from "next/link";
import { createRoot } from "react-dom/client";
import { build } from "../setup-harness/entry";
import { BrandingSettings } from "@/components/branding/branding-settings";
import { ChangeLog } from "@/components/change-log";
import { PurposesSettings } from "@/components/purposes/purposes-settings";
import { TiersAndClients } from "@/components/setup/tiers-clients";
import { PeopleAndRoles } from "@/components/setup/people-roles";
import { Page } from "@/components/shell/page";
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
      <Page title="Tiers & clients" eyebrow="Set up" description="Where tiers, tier counts and named clients are keyed in. A named client starts from its tier's values; anything filled in replaces them. Agency admins and the Owner can change this; everyone can read it." width="max-w-6xl">
        <PhoneNotice />
        <p className="rounded-lg border border-line bg-panel p-3 text-sm" data-unique-clients>
          <b>8</b> unique clients: 6 with Organic, 3 with Performance, 1 taking both services.
        </p>
        <TiersAndClients setup={setup} data={data} roster={roster} />
      </Page>
    );
  } else if (what === "setup-people") {
    page = (
      <Page title="People & roles" eyebrow="Set up" description="Who works here, their hours, their team time and their portfolio. Portfolios are named clients plus a count per tier. Agency admins and the Owner can change this; everyone can read it." width="max-w-6xl">
        <PhoneNotice />
        <PeopleAndRoles setup={setup} data={data} />
      </Page>
    );
  } else if (what === "settings") {
    page = (
      <Page
        title="Settings"
        eyebrow="Company"
        actions={
          <>
            {["Branding", "Purposes", "Historical data", "Change log"].map((l) => (
              <Link key={l} href="#" className={buttonVariants({ variant: "outline", size: "sm" })}>
                {l}
              </Link>
            ))}
          </>
        }
        description="Changes save as you go. If someone else changes the same field at the same time, you'll be asked which value to keep."
      >
        <PhoneNotice />
        <WorkspaceDetails workspaceId={data.workspace.id} name="Acme" currency="AUD" overheadMonthly={18000} canManage saveName={saveWorkspaceName} saveCurrency={saveWorkspaceCurrency} saveOverhead={saveOverheadMonthly} />
        <SimulationSettings data={data} />
        <SettingsSection id="services" title="Services, clients, roles and people" description="These moved to Set up, where the capacity figures' inputs are keyed in.">
          <ul className="flex flex-col gap-1">
            <li>
              <Link href="#" className="text-accent underline-offset-4 hover:underline">
                Tiers &amp; clients
              </Link>
              : services (pricing, entry process, servicing steps, path tags), tiers, counted clients, named clients and the client health benchmark.
            </li>
            <li>
              <Link href="#" className="text-accent underline-offset-4 hover:underline">
                People &amp; roles
              </Link>
              : roles, shared teams, people (hours, leave, skills, dates, per-person times), salaries and portfolios.
            </li>
          </ul>
        </SettingsSection>
        <HealthSettings data={data} />
      </Page>
    );
  } else if (what === "branding") {
    page = (
      <Page title="Branding" eyebrow="Settings" description="Make this workspace look like the client's: a logo and an accent colour. Changes save as you go." actions={<Link href="#" className={buttonVariants({ variant: "outline", size: "sm" })}>Back to settings</Link>}>
        <PhoneNotice />
        <BrandingSettings mode="live" workspaceId={data.workspace.id} name="Acme" branding={readBranding({})} logoSha={null} logoUrl={null} saveAccent={async () => ({ status: "error", message: "n/a" })} removeLogo={async () => ({ status: "error", message: "n/a" })} />
      </Page>
    );
  } else if (what === "changes") {
    page = (
      <Page title="Change log" eyebrow="Company" description="Who changed the company model, and what they changed.">
        <ChangeLog entries={[]} model={{} as never} people={{}} stepNames={{}} />
      </Page>
    );
  } else if (what === "purposes") {
    page = (
      <Page title="Purposes" eyebrow="Settings">
        <PurposesSettings mode="live" workspaceId={data.workspace.id} stored={[] as never} initial={[] as never} use={{} as never} save={(async () => ({ status: "error", message: "n/a" })) as never}>
          <p className="text-sm text-muted-foreground">Time by these categories is shown in the Sandbox and on the Overview.</p>
        </PurposesSettings>
      </Page>
    );
  }
  createRoot(document.getElementById("root")!).render(<SidebarProvider>{page}</SidebarProvider>);
};

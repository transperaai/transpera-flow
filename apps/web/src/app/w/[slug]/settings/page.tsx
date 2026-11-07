import { notFound } from "next/navigation";
import { LinkRows } from "@/components/settings/link-rows";
import { SettingsPage } from "@/components/settings/settings-page";
import { SectionCard } from "@/components/page-kit";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { loadLiveProcess, loadWorkspaceSettings } from "@/lib/data";
import { ChurnDriversSettings } from "./churn-drivers-settings";
import { DemandSettings } from "./demand-settings";
import { MarketSettings } from "./market-settings";
import { SimulationSettings } from "./people-settings";
import { SettingsSection } from "./section";
import { saveOverheadMonthly } from "./actions";
import { saveWorkspaceCurrency, saveWorkspaceName } from "./workspace-actions";
import { WorkspaceDetails } from "./workspace-details";

/** The stored overheads as a number, or null when none are set (the database keeps only null or a number from 0 to 100,000,000). */
const overheadOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export default async function WorkspaceSettingsPage(props: PageProps<"/w/[slug]/settings">) {
  const { slug } = await props.params;
  const [data, bundle] = await Promise.all([loadWorkspaceSettings(slug), loadLiveProcess(slug)]);
  if (!data) notFound();
  return (
    <SettingsPage
      title="Settings"
      eyebrow="Company"
      description="Changes save as you go. If someone else changes the same field at the same time, you'll be asked which value to keep."
    >
      <PhoneNotice />
      <SectionCard id="more-settings" title="More settings" description="The rest of Settings has a page each.">
        <LinkRows
          label="Settings pages"
          items={[
            { href: `/w/${slug}/settings/purposes`, title: "Purposes", description: "The categories a step's \"What it achieves\" is chosen from." },
          ]}
        />
      </SectionCard>
      <WorkspaceDetails
        workspaceId={data.workspace.id}
        name={data.workspace.name}
        currency={data.workspace.settings.currency}
        overheadMonthly={overheadOf(data.workspace.settings.overhead_monthly)}
        canManage={data.canManage}
        saveName={saveWorkspaceName}
        saveCurrency={saveWorkspaceCurrency}
        saveOverhead={saveOverheadMonthly}
      />
      <SimulationSettings data={data} />
      <SettingsSection id="services" title="Services, clients, roles and people" description="These moved to Set up, where the capacity figures' inputs are keyed in.">
        <LinkRows
          label="Set up pages"
          items={[
            { href: `/w/${slug}/setup/clients`, title: "Tiers & clients", description: "Tiers (pricing, entry process, servicing steps, path tags), tier client counts and optional named clients." },
            { href: `/w/${slug}/setup/people`, title: "People & roles", description: "Roles, shared teams, people (hours, leave, skills, dates, per-person times), salaries and portfolios." },
          ]}
        />
      </SettingsSection>
      <ChurnDriversSettings mode={data.canEdit ? "live" : "readonly"} workspaceId={data.workspace.id} bundle={bundle} rows={data.churnDrivers} />
      <DemandSettings data={data} />
      <MarketSettings data={data} />
    </SettingsPage>
  );
}

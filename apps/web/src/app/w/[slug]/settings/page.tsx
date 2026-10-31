import Link from "next/link";
import { notFound } from "next/navigation";
import { Page } from "@/components/shell/page";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { buttonVariants } from "@/components/ui/button";
import { loadLiveProcess, loadWorkspaceClients, loadWorkspaceSettings } from "@/lib/data";
import { clientSources } from "@/lib/clients";
import { loadLatestChecks } from "@/lib/calibration/client-data";
import { addClient, saveClientAssignment, saveClientField, saveClientServices } from "./client-actions";
import { ClientsSettings } from "./clients-settings";
import { ChurnDriversSettings } from "./churn-drivers-settings";
import { ClientGroupsSettings } from "./client-groups-settings";
import { DemandSettings } from "./demand-settings";
import { MarketSettings } from "./market-settings";
import { PeopleSettings, SimulationSettings } from "./people-settings";
import { RolesSettings } from "./roles-settings";
import { ServicesSettings } from "./services-settings";
import { HealthSettings } from "./servicing-settings";
import { saveOverheadMonthly } from "./actions";
import { saveWorkspaceCurrency, saveWorkspaceName } from "./workspace-actions";
import { WorkspaceDetails } from "./workspace-details";

/** The stored overheads as a number, or null when none are set (the database keeps only null or a number from 0 to 100,000,000). */
const overheadOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export default async function WorkspaceSettingsPage(props: PageProps<"/w/[slug]/settings">) {
  const { slug } = await props.params;
  const [data, bundle] = await Promise.all([loadWorkspaceSettings(slug), loadLiveProcess(slug)]);
  if (!data) notFound();
  const [roster, history] = await Promise.all([loadWorkspaceClients(data.workspace.id), loadLatestChecks(data.workspace.id)]);
  return (
    <Page
      title="Settings"
      eyebrow="Company"
      actions={
        <>
          <Link href={`/w/${slug}/settings/branding`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Branding
          </Link>
          <Link href={`/w/${slug}/settings/purposes`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Purposes
          </Link>
          <Link href={`/w/${slug}/settings/calibration`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Historical data
          </Link>
          {data.canManage && (
            <Link href={`/w/${slug}/settings/changes`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Change log
            </Link>
          )}
        </>
      }
      description="Changes save as you go. If someone else changes the same field at the same time, you'll be asked which value to keep."
    >
      <PhoneNotice />
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
      <RolesSettings data={data} />
      <ServicesSettings data={data} />
      <ClientGroupsSettings data={data} />
      <ClientsSettings
        workspaceId={data.workspace.id}
        currency={data.workspace.settings.currency}
        {...roster}
        services={data.services}
        roles={data.roles}
        people={data.people}
        personRoles={data.personRoles}
        canEdit={data.canEdit}
        sources={clientSources(data.processes, data.services, data.clientGroups)}
        ops={{ add: addClient, saveField: saveClientField, saveServices: saveClientServices, saveAssignment: saveClientAssignment }}
      />
      <ChurnDriversSettings mode={data.canEdit ? "live" : "readonly"} workspaceId={data.workspace.id} bundle={bundle} rows={data.churnDrivers} history={history} />
      <HealthSettings data={data} />
      <DemandSettings data={data} />
      <MarketSettings data={data} />
      <PeopleSettings data={data} />
    </Page>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { Page } from "@/components/shell/page";
import { buttonVariants } from "@/components/ui/button";
import { loadLiveProcess, loadWorkspaceClients, loadWorkspaceSettings } from "@/lib/data";
import { namedClientsSimulated } from "@/lib/clients";
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
import { saveWorkspaceCurrency, saveWorkspaceName } from "./workspace-actions";
import { WorkspaceDetails } from "./workspace-details";

/** AI analysis runs here after a publish or a market change (A46): allow it time. */
export const maxDuration = 300;

export default async function WorkspaceSettingsPage(props: PageProps<"/w/[slug]/settings">) {
  const { slug } = await props.params;
  const [data, bundle] = await Promise.all([loadWorkspaceSettings(slug), loadLiveProcess(slug)]);
  if (!data) notFound();
  const roster = await loadWorkspaceClients(data.workspace.id);
  return (
    <Page
      title="Settings"
      eyebrow="Company"
      actions={
        <>
          <Link href={`/w/${slug}/settings/levers`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Levers
          </Link>
          <Link href={`/w/${slug}/settings/rules`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Analysis rules
          </Link>
          <Link href={`/w/${slug}/settings/ai`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            AI analysis
          </Link>
        </>
      }
      description="Changes save as you go. If someone else changes the same field at the same time, you'll be asked which value to keep."
    >
      <WorkspaceDetails
        workspaceId={data.workspace.id}
        name={data.workspace.name}
        currency={data.workspace.settings.currency}
        canManage={data.canManage}
        saveName={saveWorkspaceName}
        saveCurrency={saveWorkspaceCurrency}
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
        simulated={namedClientsSimulated(data.clientGroups)}
        ops={{ add: addClient, saveField: saveClientField, saveServices: saveClientServices, saveAssignment: saveClientAssignment }}
      />
      <ChurnDriversSettings mode={data.canEdit ? "live" : "readonly"} workspaceId={data.workspace.id} bundle={bundle} rows={data.churnDrivers} />
      <HealthSettings data={data} />
      <DemandSettings data={data} />
      <MarketSettings data={data} />
      <PeopleSettings data={data} />
    </Page>
  );
}

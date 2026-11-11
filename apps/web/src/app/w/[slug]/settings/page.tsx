import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCapacitySetup, uniqueClients, workspacePurposes } from "@transpera-flow/db";
import { PurposesSettings } from "@/components/purposes/purposes-settings";
import { SettingsBand } from "@/components/settings/settings-band";
import { SettingsPage } from "@/components/settings/settings-page";
import { PeopleAndRoles } from "@/components/setup/people-roles";
import { TiersAndClients } from "@/components/setup/tiers-clients";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { currentUserId, loadAccessSettings } from "@/lib/access-data";
import { getDb } from "@/lib/auth/session";
import { loadDeploymentAccess } from "@/lib/deployment-access";
import { loadLiveProcess, loadPurposeUse, loadStoredPurposes, loadWorkspaceClients, loadWorkspaceSettings } from "@/lib/data";
import { peopleMeta } from "@/lib/setup/people-meta";
import { AccessSection, accessParams } from "./access/access-section";
import { ChurnDriversSettings } from "./churn-drivers-settings";
import { DemandSettings } from "./demand-settings";
import { SimulationSettings } from "./people-settings";
import { saveOverheadMonthly, savePurposes } from "./actions";
import { saveWorkspaceCurrency, saveWorkspaceName } from "./workspace-actions";
import { WorkspaceDetails } from "./workspace-details";

/** The stored overheads as a number, or null when none are set (the database keeps only null or a number from 0 to 100,000,000). */
const overheadOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Settings: one scrolling page of eight sections, each with its own heading band (`SettingsBand`) and anchor, in the sub-nav's order:
 * #workspace, #simulation, #purposes, #churn-drivers, #demand, #tiers-clients, #people-roles and, for whoever manages the workspace,
 * #access. The old Tiers & clients, People & roles and Access pages redirect to their anchors (next.config.ts).
 */
export default async function WorkspaceSettingsPage(props: PageProps<"/w/[slug]/settings">) {
  const { slug } = await props.params;
  const [data, bundle] = await Promise.all([loadWorkspaceSettings(slug), loadLiveProcess(slug)]);
  if (!data) notFound();
  const ws = data.workspace.id;
  const [purposes, purposeUse, setup, roster, access] = await Promise.all([
    loadStoredPurposes(ws),
    loadPurposeUse(ws),
    getDb().then((db) => loadCapacitySetup(db, ws)),
    loadWorkspaceClients(ws),
    // Access is for owners and Agency admins only: loadAccessSettings answers null without can_manage_workspace.
    data.canManage ? Promise.all([loadAccessSettings(slug), currentUserId(), loadDeploymentAccess(), props.searchParams]) : null,
  ]);
  if (!setup) notFound();
  const u = uniqueClients(setup);
  const counts = setup.departments.map((d) => `${u.byDepartment[d.id] ?? 0} with ${d.name}`);
  const [accessSettings, userId, signInView, search] = access ?? [];
  return (
    <SettingsPage
      title="Workspace settings"
      slug={slug}
      canManage={data.canManage}
      description="Fields save as you go: each says Saved once it has. If someone else changes the same field at the same time, you'll be asked which value to keep."
    >
      <PhoneNotice />
      <WorkspaceDetails
        workspaceId={ws}
        name={data.workspace.name}
        currency={data.workspace.settings.currency}
        overheadMonthly={overheadOf(data.workspace.settings.overhead_monthly)}
        canManage={data.canManage}
        saveName={saveWorkspaceName}
        saveCurrency={saveWorkspaceCurrency}
        saveOverhead={saveOverheadMonthly}
      />
      <SimulationSettings data={data} />
      <PurposesSettings
        mode={data.canEdit ? "live" : "readonly"}
        workspaceId={ws}
        stored={purposes}
        initial={workspacePurposes({ purposes })}
        use={purposeUse}
        save={savePurposes}
      >
        <p className="text-sm text-muted-foreground">
          Time by these categories is shown in the{" "}
          <Link href={`/w/${slug}/sandbox`} className="underline">
            Sandbox
          </Link>{" "}
          and on the Overview.
        </p>
      </PurposesSettings>
      <ChurnDriversSettings mode={data.canEdit ? "live" : "readonly"} workspaceId={ws} bundle={bundle} rows={data.churnDrivers} removed={data.workspace.settings.churn_drivers_removed} />
      <DemandSettings data={data} />
      <SettingsBand
        id="tiers-clients"
        title="Tiers & clients"
        description="Tiers and their numbers, clients taking both services, and named clients. A named client starts from its tier's values; anything filled in replaces them. Agency admins and the Owner can change this; everyone can read it."
      >
        <p className="px-1 text-sm text-fg-2" data-unique-clients>
          <b className="text-foreground">{u.unique}</b> unique clients: {counts.join(", ")}, {u.both} taking both services.
        </p>
        <TiersAndClients setup={setup} data={data} roster={roster} />
      </SettingsBand>
      <SettingsBand id="people-roles" title="People & roles" description={<span data-people-meta>{peopleMeta(setup).join(" · ")}: people and roles open into a panel; then how the shared teams work.</span>}>
        <PeopleAndRoles setup={setup} data={data} />
      </SettingsBand>
      {accessSettings && <AccessSection slug={slug} settings={accessSettings} userId={userId ?? null} signInView={signInView ?? null} params={accessParams(search ?? {})} />}
    </SettingsPage>
  );
}

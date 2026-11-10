import Link from "next/link";
import { notFound } from "next/navigation";
import { workspacePurposes } from "@transpera-flow/db";
import { PurposesSettings } from "@/components/purposes/purposes-settings";
import { SettingsPage } from "@/components/settings/settings-page";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { loadLiveProcess, loadPurposeUse, loadStoredPurposes, loadWorkspaceSettings } from "@/lib/data";
import { ChurnDriversSettings } from "./churn-drivers-settings";
import { DemandSettings } from "./demand-settings";
import { SimulationSettings } from "./people-settings";
import { saveOverheadMonthly, savePurposes } from "./actions";
import { saveWorkspaceCurrency, saveWorkspaceName } from "./workspace-actions";
import { WorkspaceDetails } from "./workspace-details";

/** The stored overheads as a number, or null when none are set (the database keeps only null or a number from 0 to 100,000,000). */
const overheadOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export default async function WorkspaceSettingsPage(props: PageProps<"/w/[slug]/settings">) {
  const { slug } = await props.params;
  const [data, bundle] = await Promise.all([loadWorkspaceSettings(slug), loadLiveProcess(slug)]);
  if (!data) notFound();
  const [purposes, purposeUse] = await Promise.all([loadStoredPurposes(data.workspace.id), loadPurposeUse(data.workspace.id)]);
  return (
    <SettingsPage
      title="Workspace settings"
      slug={slug}
      canManage={data.canManage}
      description="Fields save as you go: each says Saved once it has. If someone else changes the same field at the same time, you'll be asked which value to keep."
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
      <PurposesSettings
        mode={data.canEdit ? "live" : "readonly"}
        workspaceId={data.workspace.id}
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
      <ChurnDriversSettings mode={data.canEdit ? "live" : "readonly"} workspaceId={data.workspace.id} bundle={bundle} rows={data.churnDrivers} removed={data.workspace.settings.churn_drivers_removed} />
      <DemandSettings data={data} />
    </SettingsPage>
  );
}

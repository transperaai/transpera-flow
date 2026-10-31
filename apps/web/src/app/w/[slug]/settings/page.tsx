import Link from "next/link";
import { notFound } from "next/navigation";
import { Page } from "@/components/shell/page";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { buttonVariants } from "@/components/ui/button";
import { loadLiveProcess, loadWorkspaceSettings } from "@/lib/data";
import { loadLatestChecks } from "@/lib/calibration/client-data";
import { ChurnDriversSettings } from "./churn-drivers-settings";
import { DemandSettings } from "./demand-settings";
import { MarketSettings } from "./market-settings";
import { SimulationSettings } from "./people-settings";
import { SettingsSection } from "./section";
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
  const history = await loadLatestChecks(data.workspace.id);
  return (
    <Page
      title="Settings"
      eyebrow="Company"
      actions={
        <>
          <Link href={`/w/${slug}/settings/branding`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Branding
          </Link>
          <Link href={`/w/${slug}/settings/levers`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Levers
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
      <SettingsSection id="services" title="Services, clients, roles and people" description="These moved to Set up, where the capacity figures' inputs are keyed in.">
        <ul className="flex flex-col gap-1">
          <li>
            <Link href={`/w/${slug}/setup/clients`} className="text-accent underline-offset-4 hover:underline">
              Tiers &amp; clients
            </Link>
            : services (pricing, entry process, servicing steps, path tags), tiers, counted clients, named clients and the client health benchmark.
          </li>
          <li>
            <Link href={`/w/${slug}/setup/people`} className="text-accent underline-offset-4 hover:underline">
              People &amp; roles
            </Link>
            : roles, shared teams, people (hours, leave, skills, dates, per-person times), salaries and portfolios.
          </li>
        </ul>
      </SettingsSection>
      <ChurnDriversSettings mode={data.canEdit ? "live" : "readonly"} workspaceId={data.workspace.id} bundle={bundle} rows={data.churnDrivers} history={history} />
      <HealthSettings data={data} />
      <DemandSettings data={data} />
      <MarketSettings data={data} />
    </Page>
  );
}

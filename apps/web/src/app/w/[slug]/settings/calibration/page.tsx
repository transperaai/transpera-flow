import Link from "next/link";
import { notFound } from "next/navigation";
import { CalibrationPanel } from "@/components/calibration/calibration-panel";
import { Page } from "@/components/shell/page";
import { buttonVariants } from "@/components/ui/button";
import { canEditWorkspace } from "@/lib/access-data";
import { ClientCalibrationPanel } from "@/components/calibration/client-calibration-panel";
import { ImportsHistory } from "@/components/calibration/imports-history";
import { OtherImportsPanel } from "@/components/calibration/other-imports-panel";
import { loadCalibrationPage } from "@/lib/calibration/data";
import { loadClientCalibration } from "@/lib/calibration/client-data";
import { loadImports } from "@/lib/calibration/import-data";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";

/**
 * Settings → Historical data (issue #41, C2; the import wizard is issue #40, C1): calibrate a process from a stage history, deals
 * or time logs (part 1), and the clients' normal churn from a clients file with checks against a servicing log or jobs (part 2);
 * leads and invoices are checks only. The Imports card lists every import. Everyone in the workspace can read a file here and see
 * what it measures; owners and editors apply the changes they tick and save imports.
 */
export default async function CalibrationPage(props: PageProps<"/w/[slug]/settings/calibration">) {
  const { slug } = await props.params;
  const { process } = await props.searchParams;
  const [data, clientData] = await Promise.all([loadCalibrationPage(slug, typeof process === "string" ? process : undefined), loadClientCalibration(slug)]);
  if (!data) notFound();
  const [canEdit, imports] = await Promise.all([canEditWorkspace(data.workspaceId), loadImports(data.workspaceId)]);
  const leadSources = data.stored.leadSources.map((s) => ({ id: s.id, name: s.name, volumeWeek: Number(s.volume_week) }));
  const mode = canEdit ? "live" : "readonly";
  return (
    <Page
      title="Historical data"
      eyebrow="Company"
      description="Import past data, check it, compare it with the model, and apply the changes you choose."
      actions={
        <Link href={`/w/${slug}/settings`} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Settings
        </Link>
      }
    >
      <PhoneReadOnly>
      <CalibrationPanel
        mode={canEdit ? "live" : "readonly"}
        workspaceId={data.workspaceId}
        base={`/w/${slug}`}
        processes={data.processes}
        process={data.process}
        hasDraft={data.hasDraft}
        stored={data.stored}
        history={data.history}
        personTimes={data.personTimes}
        previous={imports.previous}
      />
      {clientData && (
        <ClientCalibrationPanel
          mode={canEdit ? "live" : "readonly"}
          workspaceId={clientData.workspaceId}
          base={`/w/${slug}`}
          rows={clientData.rows}
          runs={clientData.runs}
          history={clientData.history}
          previous={imports.previous}
        />
      )}
      <OtherImportsPanel mode={mode} workspaceId={data.workspaceId} leadSources={leadSources} previous={imports.previous} />
      <ImportsHistory imports={imports.imports} leadSources={leadSources} />
      </PhoneReadOnly>
    </Page>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { CalibrationPanel } from "@/components/calibration/calibration-panel";
import { Page } from "@/components/shell/page";
import { buttonVariants } from "@/components/ui/button";
import { canEditWorkspace } from "@/lib/access-data";
import { ClientCalibrationPanel } from "@/components/calibration/client-calibration-panel";
import { loadCalibrationPage } from "@/lib/calibration/data";
import { loadClientCalibration } from "@/lib/calibration/client-data";

/**
 * Settings → Historical data (issue #41, C2): calibrate a process from a step log (part 1), and the clients' normal churn
 * from a clients file with checks against a servicing log (part 2). Everyone in the workspace can read a file here and see
 * what it measures; owners and editors apply the changes they tick.
 */
export default async function CalibrationPage(props: PageProps<"/w/[slug]/settings/calibration">) {
  const { slug } = await props.params;
  const { process } = await props.searchParams;
  const [data, clientData] = await Promise.all([loadCalibrationPage(slug, typeof process === "string" ? process : undefined), loadClientCalibration(slug)]);
  if (!data) notFound();
  const canEdit = await canEditWorkspace(data.workspaceId);
  return (
    <Page
      title="Historical data"
      eyebrow="Company"
      description="Replace estimates with what actually happened. Read a log of past work, compare it with the model, and apply the changes you choose."
      actions={
        <Link href={`/w/${slug}/settings`} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Settings
        </Link>
      }
    >
      <CalibrationPanel
        mode={canEdit ? "live" : "readonly"}
        workspaceId={data.workspaceId}
        base={`/w/${slug}`}
        processes={data.processes}
        process={data.process}
        hasDraft={data.hasDraft}
        stored={data.stored}
        history={data.history}
      />
      {clientData && (
        <ClientCalibrationPanel
          mode={canEdit ? "live" : "readonly"}
          workspaceId={clientData.workspaceId}
          base={`/w/${slug}`}
          rows={clientData.rows}
          runs={clientData.runs}
          history={clientData.history}
        />
      )}
    </Page>
  );
}

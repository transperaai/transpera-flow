import Link from "next/link";
import { notFound } from "next/navigation";
import { CalibrationPanel } from "@/components/calibration/calibration-panel";
import { Page } from "@/components/shell/page";
import { buttonVariants } from "@/components/ui/button";
import { canEditWorkspace } from "@/lib/access-data";
import { loadCalibrationPage } from "@/lib/calibration/data";

/**
 * Settings → Historical data (issue #41, C2 part 1): calibrate a process from a step log. Everyone in the workspace can
 * read a log here and see what it measures; owners and editors apply the changes they tick.
 */
export default async function CalibrationPage(props: PageProps<"/w/[slug]/settings/calibration">) {
  const { slug } = await props.params;
  const { process } = await props.searchParams;
  const data = await loadCalibrationPage(slug, typeof process === "string" ? process : undefined);
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
    </Page>
  );
}

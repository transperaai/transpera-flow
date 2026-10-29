import Link from "next/link";
import { notFound } from "next/navigation";
import { workspacePurposes } from "@transpera-flow/db";
import { PurposesSettings } from "@/components/purposes/purposes-settings";
import { canEditWorkspace } from "@/lib/access-data";
import { loadPurposeUse, loadStoredPurposes, loadWorkspaceHead } from "@/lib/data";
import { savePurposes } from "../actions";

/**
 * Settings -> Purposes (sandbox phase 4): the categories a step's "What it achieves" is chosen from, and the Sandbox's "Where the time goes"
 * adds working time up by. Everyone in the workspace reads the list; Agency admins and the Owner change it.
 */
export default async function PurposesPage(props: PageProps<"/w/[slug]/settings/purposes">) {
  const { slug } = await props.params;
  const head = await loadWorkspaceHead(slug);
  if (!head) notFound();
  const [canEdit, stored, use] = await Promise.all([canEditWorkspace(head.id), loadStoredPurposes(head.id), loadPurposeUse(head.id)]);
  return (
    <PurposesSettings mode={canEdit ? "live" : "readonly"} workspaceId={head.id} stored={stored} initial={workspacePurposes({ purposes: stored })} use={use} save={savePurposes}>
      <p className="text-sm text-muted-foreground">
        Time by these categories is shown in the{" "}
        <Link href={`/w/${slug}/sandbox`} className="underline">
          Sandbox
        </Link>{" "}
        and on the Overview.
      </p>
    </PurposesSettings>
  );
}

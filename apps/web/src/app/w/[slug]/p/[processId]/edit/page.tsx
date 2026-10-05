import { notFound } from "next/navigation";
import { WorkspaceEditorPage } from "@/components/editor/workspace-editor-page";
import { UploadNotice } from "@/components/processes/upload-notice";
import { isId } from "@/lib/editor/validate";

/** The Editor: a process's draft on its own screen (issue #104). */
/** AI analysis runs here after a publish or a market change (A46), and saving a solution simulates it on the server (A49): allow it time. */
export const maxDuration = 300;

export default async function EditPage(props: PageProps<"/w/[slug]/p/[processId]/edit">) {
  const { slug, processId } = await props.params;
  if (!isId(processId)) notFound();
  return (
    <>
      <WorkspaceEditorPage slug={slug} processId={processId} searchParams={await props.searchParams} />
      {/* What an upload noticed on the way in, shown once (issue #166). */}
      <UploadNotice processId={processId} />
    </>
  );
}

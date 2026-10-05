import { notFound } from "next/navigation";
import { archiveProcess, changeProcessKind, renameProcess, restoreProcess } from "@/app/w/[slug]/process-admin-actions";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { ProcessesPage } from "@/components/processes/processes-page";
import { canEditWorkspace } from "@/lib/access-data";
import { loadWorkspaceHead } from "@/lib/data";
import { loadProcessesAndArchived } from "@/lib/processes/data";
import { openProcessCard } from "./actions";
import { createUpload, previewUpload } from "./upload-actions";

/**
 * Every process of the workspace, sub-processes indented, each row opening its map card (issue #101). Editors make, rename,
 * re-type, archive and restore processes here (issue #182).
 */
export default async function WorkspaceProcessesPage(props: PageProps<"/w/[slug]/processes">) {
  const { slug } = await props.params;
  const workspace = await loadWorkspaceHead(slug);
  if (!workspace) notFound();
  const [{ rows, archived }, canEdit] = await Promise.all([loadProcessesAndArchived(workspace.id), canEditWorkspace(workspace.id)]);
  const base = `/w/${slug}`;
  return (
    <ProcessesPage
      rows={rows}
      hrefs={Object.fromEntries([...rows, ...archived].map((r) => [r.id, `${base}/p/${r.id}`]))}
      companyMapHref={base}
      loadCard={openProcessCard.bind(null, slug)}
      create={canEdit ? createProcess.bind(null, workspace.id, slug) : undefined}
      upload={canEdit ? { preview: previewUpload.bind(null, workspace.id, slug), create: createUpload.bind(null, workspace.id, slug) } : undefined}
      archived={archived}
      admin={canEdit ? { rename: renameProcess, changeKind: changeProcessKind, archive: archiveProcess, restore: restoreProcess } : undefined}
    />
  );
}

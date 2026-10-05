import { notFound } from "next/navigation";
import { createServicingProcess } from "@/app/w/[slug]/process-actions";
import { ProcessesPage } from "@/components/processes/processes-page";
import { canEditWorkspace } from "@/lib/access-data";
import { loadWorkspaceHead } from "@/lib/data";
import { loadProcessesPage } from "@/lib/processes/data";
import { openProcessCard } from "./actions";
import { createUpload, previewUpload } from "./upload-actions";

/** Every process of the workspace, sub-processes indented, each row opening its map card (issue #101). */
export default async function WorkspaceProcessesPage(props: PageProps<"/w/[slug]/processes">) {
  const { slug } = await props.params;
  const workspace = await loadWorkspaceHead(slug);
  if (!workspace) notFound();
  const [rows, canEdit] = await Promise.all([loadProcessesPage(workspace.id), canEditWorkspace(workspace.id)]);
  const base = `/w/${slug}`;
  return (
    <ProcessesPage
      rows={rows}
      hrefs={Object.fromEntries(rows.map((r) => [r.id, `${base}/p/${r.id}`]))}
      companyMapHref={base}
      loadCard={openProcessCard.bind(null, slug)}
      create={canEdit ? createServicingProcess.bind(null, workspace.id, slug) : undefined}
      upload={canEdit ? { preview: previewUpload.bind(null, workspace.id, slug), create: createUpload.bind(null, workspace.id, slug) } : undefined}
    />
  );
}

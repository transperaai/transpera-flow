import { notFound } from "next/navigation";
import { archiveProcess, changeProcessCategory, changeProcessKind, renameProcess, restoreProcess } from "@/app/w/[slug]/process-admin-actions";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { ProcessesPage } from "@/components/processes/processes-page";
import { canEditWorkspace } from "@/lib/access-data";
import { loadCompanyId, loadWorkspaceHead } from "@/lib/data";
import { loadCompanyRowFacts, loadProcessesAndArchived } from "@/lib/processes/data";
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
  const [{ rows, archived }, canEdit, companyFacts] = await Promise.all([loadProcessesAndArchived(workspace.id), canEditWorkspace(workspace.id), loadCompanyRowFacts(workspace.id)]);
  const base = `/w/${slug}`;
  // With nothing published the Overview is the start page, which has no map to read: editors go to the company map's Editor (and
  // come back here), and members and viewers get no button (issue #243). Once something is published, everyone reads the map at
  // the Overview and editors also get the Editor beside it, to make a new company map version.
  const published = rows.some((r) => r.version !== null);
  const anyCompanyId = await loadCompanyId(workspace.id);
  const editHref = canEdit && anyCompanyId ? `${base}/p/${anyCompanyId}/edit?from=${encodeURIComponent(`${base}/processes`)}` : undefined;
  const companyMap = published ? { href: base, edit: false, editHref } : editHref ? { href: editHref, edit: true } : undefined;
  return (
    <ProcessesPage
      rows={rows}
      hrefs={Object.fromEntries([...rows, ...archived].map((r) => [r.id, `${base}/p/${r.id}`]))}
      companyMap={companyMap}
      // The company map's History: the same page the Overview's History button opens.
      companyHistoryHref={published && anyCompanyId ? `${base}/p/${anyCompanyId}/history` : undefined}
      companyRow={
        companyFacts && (published || companyFacts.draft)
          ? { version: companyFacts.version, draft: companyFacts.draft, href: base, historyHref: companyFacts.version ? `${base}/p/${companyFacts.id}/history` : undefined, editHref }
          : undefined
      }
      loadCard={openProcessCard.bind(null, slug)}
      create={canEdit ? createProcess.bind(null, workspace.id, slug) : undefined}
      upload={canEdit ? { preview: previewUpload.bind(null, workspace.id, slug), create: createUpload.bind(null, workspace.id, slug) } : undefined}
      archived={archived}
      admin={canEdit ? { rename: renameProcess, changeKind: changeProcessKind, changeCategory: changeProcessCategory, archive: archiveProcess, restore: restoreProcess } : undefined}
    />
  );
}

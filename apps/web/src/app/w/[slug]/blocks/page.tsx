import { notFound } from "next/navigation";
import { openBlockBase } from "./actions";
import { BlockLibrary } from "@/components/blocks/block-library";
import { blockUsers } from "@/lib/blocks/rows";
import { canEditWorkspace } from "@/lib/access-data";
import { loadProcessList, loadWorkspaceBlocks, loadWorkspaceHead, loadWorkspaceRoleNames, loadWorkspaceSolutions } from "@/lib/data";

/**
 * The Block library (issue #116; a list since Q15): the workspace's saved bundles of steps. "New block" and "Edit" open the Editor in
 * block mode; the Editor needs a process of the workspace to take its roles and people from, so the first one lends them.
 */
export default async function WorkspaceBlocksPage(props: PageProps<"/w/[slug]/blocks">) {
  const { slug } = await props.params;
  const workspace = await loadWorkspaceHead(slug);
  if (!workspace) notFound();
  const [blocks, canEdit, processes, solutions, roles] = await Promise.all([
    loadWorkspaceBlocks(workspace.id),
    canEditWorkspace(workspace.id),
    loadProcessList(workspace.id),
    loadWorkspaceSolutions(workspace.id),
    loadWorkspaceRoleNames(workspace.id),
  ]);
  const first = processes[0];
  const libraryHref = `/w/${slug}/blocks`;
  const editBase = canEdit && first ? `/w/${slug}/p/${first.id}/edit` : null;
  const newHref = editBase ? `${editBase}?mode=block&from=${encodeURIComponent(libraryHref)}` : null;
  return (
    <BlockLibrary
      blocks={blocks}
      mode={canEdit ? "live" : "readonly"}
      newHref={newHref}
      editBase={editBase}
      libraryHref={libraryHref}
      workspaceId={workspace.id}
      solutionsBase={`/w/${slug}`}
      users={blockUsers(solutions.solutions)}
      roles={roles}
      slug={slug}
      baseProcessId={first?.id ?? null}
      openBase={openBlockBase}
    />
  );
}

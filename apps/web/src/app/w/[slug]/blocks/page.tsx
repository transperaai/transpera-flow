import { notFound } from "next/navigation";
import { BlockLibrary } from "@/components/blocks/block-library";
import { blockUsage } from "@/lib/blocks/usage";
import { canEditWorkspace } from "@/lib/access-data";
import { loadProcessList, loadWorkspaceBlocks, loadWorkspaceHead, loadWorkspaceSolutions } from "@/lib/data";

/**
 * The Block library (issue #116): the workspace's saved bundles of steps. "New block" opens the Editor in block mode; the
 * Editor needs a process of the workspace to take its roles and people from, so the first one lends them.
 */
export default async function WorkspaceBlocksPage(props: PageProps<"/w/[slug]/blocks">) {
  const { slug } = await props.params;
  const workspace = await loadWorkspaceHead(slug);
  if (!workspace) notFound();
  const [blocks, canEdit, processes, solutions] = await Promise.all([loadWorkspaceBlocks(workspace.id), canEditWorkspace(workspace.id), loadProcessList(workspace.id), loadWorkspaceSolutions(workspace.id)]);
  const first = processes[0];
  const newHref = canEdit && first ? `/w/${slug}/p/${first.id}/edit?mode=block&from=${encodeURIComponent(`/w/${slug}/blocks`)}` : null;
  return <BlockLibrary blocks={blocks} mode={canEdit ? "live" : "readonly"} newHref={newHref} usage={blockUsage(solutions.solutions)} />;
}

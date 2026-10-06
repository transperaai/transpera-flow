import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { canEditWorkspace, canManageWorkspace, currentViewer } from "@/lib/access-data";
import { pendingSuggestionCount, shellCounts } from "@/lib/company-data";
import { listWorkspaces, loadWorkspaceHead } from "@/lib/data";

/** The sidebar around every page of a workspace (issue #93). Fetched once per visit: navigation inside the workspace doesn't re-render it. */
export default async function WorkspaceLayout(props: LayoutProps<"/w/[slug]">) {
  const { slug } = await props.params;
  const workspace = await loadWorkspaceHead(slug);
  if (!workspace) notFound();
  const [workspaces, canManage, canEdit, pendingSuggestions, shell, viewer] = await Promise.all([
    listWorkspaces(),
    canManageWorkspace(workspace.id),
    canEditWorkspace(workspace.id),
    pendingSuggestionCount(workspace.id),
    shellCounts(workspace.id),
    currentViewer(),
  ]);
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  return (
    <WorkspaceShell
      mode="live"
      defaultOpen={defaultOpen}
      slug={slug}
      workspaceName={workspace.name}
      workspaces={workspaces.map((w) => ({ name: w.name, href: `/w/${w.slug}` }))}
      canManage={canManage}
      canEdit={canEdit}
      counts={{ processes: shell.processes, openIssues: shell.openIssues, pendingSuggestions, unlinkedSources: shell.unlinkedSources }}
      viewer={viewer ? { name: viewer.name, email: viewer.email } : null}
    >
      {props.children}
    </WorkspaceShell>
  );
}

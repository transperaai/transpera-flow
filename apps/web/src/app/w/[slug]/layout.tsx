import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { currentViewer } from "@/lib/access-data";
import { shellCounts } from "@/lib/company-data";
import { listWorkspaces, loadWorkspaceHead } from "@/lib/data";

/** The sidebar around every page of a workspace (issue #93). Fetched once per visit: navigation inside the workspace doesn't re-render it. */
export default async function WorkspaceLayout(props: LayoutProps<"/w/[slug]">) {
  const { slug } = await props.params;
  const workspace = await loadWorkspaceHead(slug);
  if (!workspace) notFound();
  const [workspaces, shell, viewer] = await Promise.all([
    listWorkspaces(),
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
      counts={{ processes: shell.processes, openIssues: shell.openIssues }}
      viewer={viewer ? { name: viewer.name, email: viewer.email } : null}
    >
      {props.children}
    </WorkspaceShell>
  );
}

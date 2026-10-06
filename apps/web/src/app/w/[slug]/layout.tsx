import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { canEditWorkspace, canManageWorkspace, currentViewer } from "@/lib/access-data";
import { brandingCss, logoUrl, readBranding } from "@/lib/branding/branding";
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
  // Client branding (issue #34): the accent tokens for this workspace, or nothing (an unbranded workspace renders exactly as
  // before). A plain <style>, with no `href` or `precedence`: React hoists a <style precedence> into <head> and never removes
  // it, so moving to an unbranded workspace would keep the old colours. This one goes when the layout re-renders for another
  // slug. It sits outside the shell, so the full-screen Editor is branded too.
  const branding = readBranding(workspace.branding, workspace.id);
  const css = brandingCss(branding);
  return (
    <>
      {css && <style data-brand="">{css}</style>}
      <WorkspaceShell
        mode="live"
        defaultOpen={defaultOpen}
        slug={slug}
        workspaceName={workspace.name}
        logoUrl={logoUrl(branding.logoPath, process.env.NEXT_PUBLIC_SUPABASE_URL)}
        workspaces={workspaces.map((w) => ({ name: w.name, href: `/w/${w.slug}` }))}
        canManage={canManage}
        canEdit={canEdit}
        counts={{ processes: shell.processes, openIssues: shell.openIssues, pendingSuggestions, unlinkedSources: shell.unlinkedSources }}
        viewer={viewer ? { name: viewer.name, email: viewer.email } : null}
      >
        {props.children}
      </WorkspaceShell>
    </>
  );
}

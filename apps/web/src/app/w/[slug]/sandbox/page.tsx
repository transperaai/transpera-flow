import { notFound } from "next/navigation";
import { SandboxView } from "@/components/sandbox/sandbox-view";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { NotPublished } from "@/components/shell/not-published";
import { Page } from "@/components/shell/page";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { canEditWorkspace } from "@/lib/access-data";
import { loadLiveProcess, loadPublishState, loadWorkspaceIssues, loadWorkspaceSandboxScenarios, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";
import { loadWorkspaceLeverSettings } from "@/lib/levers/data";

/**
 * The Sandbox: who gets too busy, and when, from the live model run forward month by month, and scenarios of changes to try, save,
 * run and compare. Everyone who can read the workspace sees the saved scenarios and runs and compares them; Agency admins and the
 * Owner also add, move, save and delete.
 */
export default async function WorkspaceSandboxPage(props: PageProps<"/w/[slug]/sandbox">) {
  const { slug } = await props.params;
  const live = await loadLiveProcess(slug);
  if (!live) {
    // Nothing is published (a new client): there is nothing to run forward. No scenarios are loaded.
    const state = await loadPublishState(slug);
    if (!state) notFound();
    const canEdit = await canEditWorkspace(state.workspace.id);
    return (
      <Page title="Sandbox" width="max-w-6xl">
        <NotPublished
          what="The Sandbox runs the published processes forward month by month to show who gets too busy, and when, and lets you try changes before you make them."
          canEdit={canEdit}
          base={`/w/${slug}`}
          firstDraft={state.firstDraft}
          create={canEdit ? createProcess.bind(null, state.workspace.id, slug) : undefined}
        />
      </Page>
    );
  }
  const ws = live.workspace.id;
  const [issues, sources, canEdit, scenarios, solutions, levers] = await Promise.all([
    loadWorkspaceIssues(ws),
    loadWorkspaceSources(ws),
    canEditWorkspace(ws),
    loadWorkspaceSandboxScenarios(ws),
    loadWorkspaceSolutions(ws).then((d) => d.solutions),
    loadWorkspaceLeverSettings(ws),
  ]);
  const base = `/w/${slug}`;
  return (
    <Page title="Sandbox" width="max-w-6xl" hideHeader>
      <SourceLinkingScope workspaceId={ws} sources={sources} canEdit={canEdit}>
        <SandboxView
          live={live}
          issues={issues}
          sources={sources}
          mode={canEdit ? "live" : "readonly"}
          issuesHref={`${base}/issues`}
          peopleHref={`${base}/settings`}
          leversHref={`${base}/settings/levers`}
          scenarios={scenarios}
          solutions={solutions}
          hiddenLevers={levers.hidden}
        />
      </SourceLinkingScope>
    </Page>
  );
}

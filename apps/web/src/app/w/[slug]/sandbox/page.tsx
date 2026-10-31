import { notFound } from "next/navigation";
import { loadCapacityChanges, loadCapacitySetup } from "@transpera-flow/db";
import { PlayPage } from "@/components/sandbox/play-page";
import { SandboxView } from "@/components/sandbox/sandbox-view";
import { SANDBOX_SCENARIOS_SHOWN } from "@/lib/sandbox/scenarios-shown";
import { getDb } from "@/lib/auth/session";
import { loadLiveCompany, loadLiveParts } from "@/lib/overview/data";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { NotPublished } from "@/components/shell/not-published";
import { Page } from "@/components/shell/page";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { canEditWorkspace } from "@/lib/access-data";
import { loadLiveProcess, loadPublishState, loadWorkspaceIssues, loadWorkspaceSandboxScenarios, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";

/**
 * The Sandbox (capacity build P7, D38): free play. The company's processes on top (the map, a map version per process, a block per step), the levers on
 * the left and the results on the right: a verdict and four charts against today's path. Nothing is saved; the levers reset when you leave. Everyone who
 * can read the workspace plays; Agency admins and the Owner also add, edit and remove the list of changes. Stored scenarios stay in the database, and
 * the old scenario page is behind SANDBOX_SCENARIOS_SHOWN.
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
  if (!SANDBOX_SCENARIOS_SHOWN) {
    const db = await getDb();
    const [setup, library, parts, company, issues, canEdit, solutions] = await Promise.all([
      loadCapacitySetup(db, ws),
      loadCapacityChanges(db, ws),
      loadLiveParts(ws),
      loadLiveCompany(ws),
      loadWorkspaceIssues(ws),
      canEditWorkspace(ws),
      loadWorkspaceSolutions(ws),
    ]);
    if (!setup) notFound();
    return (
      <Page title="Sandbox" eyebrow="Company" description="Swap process blocks and pull the levers, then watch the next 12 months change. Nothing here touches live data." width="max-w-6xl">
        <PlayPage live={live} parts={parts} company={company} setup={setup} library={library} solutions={solutions.solutions} solutionLinks={solutions.links} issues={issues} canEdit={canEdit} base={`/w/${slug}`} />
      </Page>
    );
  }
  const [issues, sources, canEdit, scenarios, solutions] = await Promise.all([
    loadWorkspaceIssues(ws),
    loadWorkspaceSources(ws),
    canEditWorkspace(ws),
    loadWorkspaceSandboxScenarios(ws),
    loadWorkspaceSolutions(ws).then((d) => d.solutions),
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
          purposesHref={`${base}/settings/purposes`}
          scenarios={scenarios}
          solutions={solutions}
        />
      </SourceLinkingScope>
    </Page>
  );
}

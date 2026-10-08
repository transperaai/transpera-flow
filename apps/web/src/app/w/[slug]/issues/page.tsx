import { notFound } from "next/navigation";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { NotPublished } from "@/components/shell/not-published";
import { Page } from "@/components/shell/page";
import { IssuesPage } from "@/components/issues-page";
import { loadLiveFirstPrinciples } from "@/lib/first-principles/data";
import { canEditWorkspace } from "@/lib/access-data";
import { loadLiveProcess, loadProcessNames, loadPublishState, loadWorkspaceIssues, loadWorkspaceLiveRevisionIds, loadWorkspaceScenarios, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";

const DESCRIPTION = (
  <>
    Problems you&apos;ve confirmed, linked to a whole process or to specific steps. Resolved issues stay here with their full history. Each one keeps the rating agreed when it was confirmed.
  </>
);

/** The Issues list (A48): the problems people have confirmed, filtered by Open / Resolved / All and rating (both in the URL). */
export default async function WorkspaceIssuesPage(props: PageProps<"/w/[slug]/issues">) {
  const { slug } = await props.params;
  const bundle = await loadLiveProcess(slug);
  if (!bundle) {
    // Nothing is published (a new client: only the company map, or drafts): there is nothing to rate issues against yet, which is not a missing page.
    const state = await loadPublishState(slug);
    if (!state) notFound();
    const canEdit = await canEditWorkspace(state.workspace.id);
    return (
      <Page title="Issues" eyebrow="Improve" description={DESCRIPTION}>
        <NotPublished
          what="Issues are problems you confirm on a published process: its findings, or ones you log by hand."
          canEdit={canEdit}
          base={`/w/${slug}`}
          firstDraft={state.firstDraft}
          create={canEdit ? createProcess.bind(null, state.workspace.id, slug) : undefined}
        />
      </Page>
    );
  }
  const ws = bundle.workspace.id;
  const [canEdit, issues, scenarios, processes, sources, liveRevisions, firstPrinciples, solutions] = await Promise.all([
    canEditWorkspace(ws),
    loadWorkspaceIssues(ws),
    loadWorkspaceScenarios(ws),
    loadProcessNames(ws),
    loadWorkspaceSources(ws),
    loadWorkspaceLiveRevisionIds(ws),
    loadLiveFirstPrinciples(bundle.process.id, bundle.revision.id),
    loadWorkspaceSolutions(ws),
  ]);
  return (
    <Page
      title="Issues"
      eyebrow="Improve"
      description={DESCRIPTION}
    >
      <IssuesPage
        bundle={bundle}
        issues={issues}
        scenarios={scenarios}
        processes={processes}
        sources={sources}
        liveRevisions={liveRevisions}
        solutions={solutions}
        firstPrinciples={firstPrinciples}
        base={`/w/${slug}`}
        mode={canEdit ? "live" : "readonly"}
      />
    </Page>
  );
}

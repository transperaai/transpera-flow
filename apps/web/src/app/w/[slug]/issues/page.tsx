import Link from "next/link";
import { notFound } from "next/navigation";
import { Page } from "@/components/shell/page";
import { IssuesPage } from "@/components/issues-page";
import { loadLiveFirstPrinciples } from "@/lib/first-principles/data";
import { canEditWorkspace } from "@/lib/access-data";
import { loadLiveProcess, loadProcessNames, loadWorkspaceIssues, loadWorkspaceLiveRevisionIds, loadWorkspaceScenarios, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";

/** The Issues list (A48): the problems people have confirmed, filtered by Open / Resolved / All and rating (both in the URL). */
export default async function WorkspaceIssuesPage(props: PageProps<"/w/[slug]/issues">) {
  const { slug } = await props.params;
  const bundle = await loadLiveProcess(slug);
  if (!bundle) notFound();
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
      description={
        <>
          Problems you&apos;ve confirmed, linked to a whole process or to specific steps. Resolved issues stay here with their full history. Each one keeps the rating agreed when it was confirmed.
        </>
      }
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

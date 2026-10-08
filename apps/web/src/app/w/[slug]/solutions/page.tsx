import { notFound } from "next/navigation";
import { NewSolutionButton, SolutionsList } from "@/components/solutions/solutions-list";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { NotPublished } from "@/components/shell/not-published";
import { Page } from "@/components/shell/page";
import { canEditWorkspace, currentUserId } from "@/lib/access-data";
import { loadMemberNames, loadPendingIdeaCount, loadProcessNames, loadPublishState, loadWorkspaceHead, loadWorkspaceIssues, loadWorkspaceLiveRevisionIds, loadWorkspaceSolutions } from "@/lib/data";

/** The Solutions list (A50): every solution built and simulated, with the issues each solves and how it did. */
export default async function WorkspaceSolutionsPage(props: PageProps<"/w/[slug]/solutions">) {
  const { slug } = await props.params;
  const head = await loadWorkspaceHead(slug);
  if (!head) notFound();
  const ws = head.id;
  const [canEdit, viewerId, solutions, issues, processes, live, memberNames, ideas] = await Promise.all([
    canEditWorkspace(ws),
    currentUserId(),
    loadWorkspaceSolutions(ws),
    loadWorkspaceIssues(ws),
    loadProcessNames(ws),
    loadWorkspaceLiveRevisionIds(ws),
    loadMemberNames(ws),
    loadPendingIdeaCount(ws),
  ]);
  const base = `/w/${slug}`;
  // Nothing published (a new client): a solution is a changed copy of a published process, so there is nothing to list or to start from.
  const state = Object.keys(live).length === 0 ? await loadPublishState(slug) : null;
  return (
    <Page
      title="Solutions"
      eyebrow="Improve"
      description="Every solution that has been built and simulated. Each one says which issues it solves, and how it did against each issue's target. They never change the live map."
      actions={canEdit ? <NewSolutionButton processes={processes.filter((p) => live[p.id])} base={base} /> : undefined}
    >
      {state ? (
        <NotPublished
          what="A solution is a changed copy of a published process, simulated against its issues."
          canEdit={canEdit}
          base={base}
          firstDraft={state.firstDraft}
          create={canEdit ? createProcess.bind(null, ws, slug) : undefined}
        />
      ) : (
        <SolutionsList data={solutions} issues={issues} processes={processes} base={base} mode={canEdit ? "live" : "readonly"} viewerId={viewerId} memberNames={memberNames} ideas={ideas} />
      )}
    </Page>
  );
}

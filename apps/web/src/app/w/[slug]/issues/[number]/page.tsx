import { notFound } from "next/navigation";
import { buildSolutionHref, solutionEditorHref } from "@/lib/solutions/links";
import { isUnpublished } from "@transpera-flow/db";
import { IssuePage } from "@/components/issues/issue-page";
import { ShareButton } from "@/components/share/share-dialog";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { Page } from "@/components/shell/page";
import { canEditWorkspace, currentUserId } from "@/lib/access-data";
import { IssueIdeas } from "@/components/idea-card";
import { loadIssueIdeas } from "@/lib/company-data";
import { findIssue } from "@/lib/issues/pages";
import { loadProcessForEditing, loadProcessNames, loadMemberNames, loadWorkspaceIssueEvents, loadWorkspaceIssues, loadWorkspaceLiveRevisionIds, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";

/**
 * One issue (A48): where it sits on the map, what is wrong, the solutions tested, AI ideas and its history, with its
 * target, owners, links and sources beside. `[number]` is the issue's number in the workspace (an id works too).
 */
export default async function WorkspaceIssuePage(props: PageProps<"/w/[slug]/issues/[number]">) {
  const { slug, number } = await props.params;
  // The workspace's issues come first: the page needs the one asked for, and the process it is on.
  const probe = await loadProcessForEditing(slug);
  if (!probe) notFound();
  const ws = probe.live.workspace.id;
  const issues = await loadWorkspaceIssues(ws);
  const issue = findIssue(issues, number);
  if (!issue) notFound();
  // The map is the issue's own process; one that can't be loaded falls back to the workspace's first.
  const processId = issue.links.find((l) => l.process_id)?.process_id ?? issue.process_id;
  const own = processId && processId !== probe.live.process.id ? await loadProcessForEditing(slug, processId) : probe;
  const { live, draft } = own ?? probe;
  const bundle = isUnpublished(live) && draft ? draft : live;
  const [canEdit, sources, processes, events, liveRevisions, viewerId, solutions, memberNames, aiIdeas] = await Promise.all([
    canEditWorkspace(ws),
    loadWorkspaceSources(ws),
    loadProcessNames(ws),
    loadWorkspaceIssueEvents(ws, issue.id),
    loadWorkspaceLiveRevisionIds(ws),
    currentUserId(),
    loadWorkspaceSolutions(ws),
    loadMemberNames(ws),
    loadIssueIdeas(ws, issue.id),
  ]);
  const base = `/w/${slug}`;
  return (
    <Page title={issue.number ? `Issue #${issue.number}` : "Issue"} eyebrow="Improve" width="max-w-6xl" hideHeader>
      <SourceLinkingScope workspaceId={ws} sources={sources} canEdit={canEdit} issueSources={{ issueId: issue.id, sourceIds: issue.source_ids }}>
      <IssuePage
        issue={issue}
        issues={issues}
        bundle={bundle}
        processes={processes}
        sources={sources}
        events={events}
        mode={canEdit ? "live" : "readonly"}
        base={base}
        buildHref={buildSolutionHref(base, issue, `${base}/issues/${issue.number}`) ?? solutionEditorHref(base, bundle.process.id, { issueId: issue.id })}
        viewerId={viewerId}
        liveRevisions={liveRevisions}
        ideas={
          <IssueIdeas
            key="ideas"
            issueId={issue.id}
            base={base}
            from={`${base}/issues/${issue.number}`}
            canEdit={canEdit}
            initial={aiIdeas.ideas}
            lookups={aiIdeas.lookups}
            workspaceId={ws}
          />
        }
        solutions={solutions}
        memberNames={memberNames}
        share={canEdit && issue.number != null ? <ShareButton slug={slug} kind="issue" targetId={issue.id} what={`Issue #${issue.number}`} /> : undefined}
      />
      </SourceLinkingScope>
    </Page>
  );
}

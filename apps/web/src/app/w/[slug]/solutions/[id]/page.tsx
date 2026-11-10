import { notFound } from "next/navigation";
import { SolutionPage } from "@/components/solutions/solution-page";
import { Page } from "@/components/shell/page";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { canEditWorkspace, currentUserId } from "@/lib/access-data";
import { loadLiveProcess, loadMemberNames, loadSolutionBase, loadProcessNames, loadWorkspaceIssues, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";
import { isId } from "@/lib/sources/validate";

/**
 * One solution (A50, descoped in Q12): its header with the issues it fixes and the ways on (Open in editor, Try it in the Sandbox), what it
 * changes in plain lines, the live map and its map side by side, and its notes. `[id]` is the solution's id.
 */
export default async function WorkspaceSolutionPage(props: PageProps<"/w/[slug]/solutions/[id]">) {
  const { slug, id } = await props.params;
  if (!isId(id)) notFound();
  const bundle = await loadLiveProcess(slug);
  if (!bundle) notFound();
  const ws = bundle.workspace.id;
  const [canEdit, viewerId, solutions, issues, processes, sources] = await Promise.all([
    canEditWorkspace(ws),
    currentUserId(),
    loadWorkspaceSolutions(ws),
    loadWorkspaceIssues(ws),
    loadProcessNames(ws),
    loadWorkspaceSources(ws),
  ]);
  const solution = solutions.solutions.find((s) => s.id === id);
  if (!solution) notFound();
  // Who built it, and the version the solution was copied from (for the maps and the lines; if it can't be read the rest of the page still works).
  const [memberNames, compare] = await Promise.all([
    loadMemberNames(ws),
    loadSolutionBase(slug, solution.process_id, solution.base_revision_id, bundle).catch(() => null),
  ]);
  return (
    <Page title={solution.name} eyebrow="Improve" hideHeader>
      <SourceLinkingScope workspaceId={ws} sources={sources} canEdit={canEdit}>
        <SolutionPage
          workspaceId={ws}
          solutionId={solution.id}
          data={solutions}
          issues={issues}
          processes={processes}
          base={`/w/${slug}`}
          mode={canEdit ? "live" : "readonly"}
          viewerId={viewerId}
          memberNames={memberNames}
          compareBase={compare?.base ?? null}
          movedOn={compare?.movedOn ?? null}
        />
      </SourceLinkingScope>
    </Page>
  );
}

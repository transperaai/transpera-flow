import { notFound, redirect } from "next/navigation";
import { EditorView } from "@/components/editor/editor-view";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { canEditWorkspace, currentViewer } from "@/lib/access-data";
import { loadIdeaProposal } from "@/lib/company-data";
import { ideaSeed } from "@/lib/suggestions/idea";
import { loadDismissedEditorTours, loadProcessForEditing, loadWorkspaceBlocks, loadWorkspaceIssues, loadWorkspaceScenarios, loadWorkspaceSources } from "@/lib/data";
import { firstPrinciplesDraftChanged } from "@/lib/first-principles/data";
import { loadLiveParts } from "@/lib/overview/data";
import { loadLibrary } from "@/lib/editor/library-data";
import { exitHref, parseEditorMode, parseHorizon, parseIssueParam } from "@/lib/editor/modes";
import { issueAboutProcess, solutionIssueOf } from "@/lib/solutions/area";

/**
 * The Editor for a process of the workspace (issue #104): `/w/[slug]/p/[processId]/edit`. Full screen, outside the
 * sidebar. Someone who can't edit goes back to the map, which they can still read.
 */
export async function WorkspaceEditorPage({
  slug,
  processId,
  searchParams,
}: {
  slug: string;
  processId: string;
  searchParams: { mode?: string | string[]; from?: string | string[]; horizon?: string | string[]; issue?: string | string[]; idea?: string | string[] };
}) {
  // The Editor also opens the company map (B11), by its id: the same screen, on its holders and handoff lines.
  const process = await loadProcessForEditing(slug, processId, { includeCompany: true });
  if (!process) notFound();
  const company = process.live.process.is_company === true;
  // The map's cards draw from the processes they link to (live), which the Editor is not editing. In any other editor the process
  // library (B12) can link any process into the draft, so every live process is at hand to draw and simulate through its link;
  // the ones the run already carries keep their place (the pipeline first), the rest follow, and only a link brings one in.
  const [parts, library] = await Promise.all([loadLiveParts(process.live.workspace.id), loadLibrary(process.live.workspace.id)]);
  const withParts = (b: typeof process.live) => {
    if (company) return { ...b, otherProcesses: parts };
    const have = new Set([b.process.id, ...(b.otherProcesses ?? []).map((p) => p.process.id)]);
    return { ...b, otherProcesses: [...(b.otherProcesses ?? []), ...parts.filter((p) => !have.has(p.process.id))] };
  };
  const live = withParts(process.live);
  const draft = process.draft ? withParts(process.draft) : process.draft;
  // The company map is read at the Overview, not at a process page of its own.
  const base = company ? `/w/${slug}` : `/w/${slug}/p/${processId}`;
  const canEdit = await canEditWorkspace(live.workspace.id);
  // An archived process (issue #182) is read only until it is restored: its page says so.
  if (!canEdit || live.process.archived_at) redirect(base);
  const [scenarios, blocks, sources, viewer, fpChanged, tours] = await Promise.all([
    loadWorkspaceScenarios(live.workspace.id),
    loadWorkspaceBlocks(live.workspace.id),
    loadWorkspaceSources(live.workspace.id),
    currentViewer(),
    company ? Promise.resolve(false) : firstPrinciplesDraftChanged(live.process.id, live.revision.id, draft?.revision.id ?? null),
    loadDismissedEditorTours(),
  ]);
  const tourDismissed = tours.includes(company ? "company" : "process");
  // Solution mode built for an issue (`?issue=`, A49): the issue's steps are outlined and its target is what the verdict checks.
  // The company map has no solutions or blocks: it is edited as a draft only.
  const editorMode = company ? "draft" : parseEditorMode(searchParams.mode);
  const issueId = editorMode === "solution" ? parseIssueParam(searchParams.issue) : null;
  const issueRow = issueId ? (await loadWorkspaceIssues(live.workspace.id)).find((i) => i.id === issueId) : undefined;
  // "Build it" on a solution idea (A52): `?idea=` names a waiting idea for this issue, whose steps the Editor places.
  const ideaId = issueRow ? parseIssueParam(searchParams.idea) : null;
  const ideaRow = ideaId ? await loadIdeaProposal(live.workspace.id, ideaId) : null;
  const idea = ideaRow && ideaRow.issue_id === issueRow?.id ? ideaSeed(ideaRow, live.roles) : null;
  return (
    <SourceLinkingScope workspaceId={live.workspace.id} sources={sources} canEdit>
    <EditorView
      key={live.process.id}
      live={live}
      draft={draft}
      mode="live"
      extraChanges={fpChanged ? 1 : 0}
      editorMode={editorMode}
      idea={idea}
      issue={issueRow && issueAboutProcess(issueRow, live.process.id) ? solutionIssueOf(issueRow, live.process.id, live.steps) : null}
      scenarios={scenarios}
      blocks={blocks}
      sources={sources}
      userId={viewer?.userId ?? null}
      tourDismissed={tourDismissed}
      historyHref={`/w/${slug}/p/${processId}/history`}
      viewer={viewer}
      sourcesHref={`/w/${slug}/sources`}
      settingsHref={`/w/${slug}/settings`}
      exitHref={exitHref(searchParams.from, base)}
      horizonMonths={parseHorizon(searchParams.horizon)}
      library={editorMode === "draft" ? library : undefined}
    />
    </SourceLinkingScope>
  );
}

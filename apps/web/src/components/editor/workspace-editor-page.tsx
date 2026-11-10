import { bundleFromSolution } from "@transpera-flow/db/sandbox";
import { notFound, redirect } from "next/navigation";
import { EditorPhoneGate } from "@/components/editor/editor-phone-gate";
import { EditorView } from "@/components/editor/editor-view";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { canEditWorkspace, currentViewer } from "@/lib/access-data";
import { loadDismissedEditorTours, loadProcessForEditing, loadTierSetup, loadWorkspaceBlocks, loadWorkspaceIssues, loadWorkspaceScenarios, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";
import { loadLiveParts } from "@/lib/overview/data";
import { loadDepartmentLaneInput } from "@/lib/overview/lanes-data";
import { loadLibrary } from "@/lib/editor/library-data";
import { readBlock } from "@/lib/blocks/blocks";
import { exitHref, parseEditorMode, parseHorizon, parseIssueParam } from "@/lib/editor/modes";
import { issueAboutProcess, solutionIssueOf } from "@/lib/solutions/area";

/**
 * The `?notice=` the Editor sends a person back with when it can't open: `read-only` (they may only view this workspace)
 * or `archived` (the process is archived). The read-only page shows "You can't edit this process" for either.
 */
export const EDIT_NOTICE = { readOnly: "read-only", archived: "archived" } as const;

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
  searchParams: { mode?: string | string[]; from?: string | string[]; horizon?: string | string[]; issue?: string | string[]; solution?: string | string[]; block?: string | string[] };
}) {
  // The Editor also opens the company map (B11), by its id: the same screen, on its holders and handoff lines.
  const process = await loadProcessForEditing(slug, processId, { includeCompany: true });
  if (!process) notFound();
  const company = process.live.process.is_company === true;
  // The map's cards draw from the processes they link to (live), which the Editor is not editing. A process's own editor makes no new links
  // (editor brainstorm, item 3), but a step that already holds one is drawn from it and can be turned into steps, so every live process is
  // at hand; the ones the run already carries keep their place (the pipeline first), the rest follow, and only a link brings one in.
  // The process library (B12) is the company map's palette alone.
  const [parts, library] = await Promise.all([loadLiveParts(process.live.workspace.id), company ? loadLibrary(process.live.workspace.id) : Promise.resolve(undefined)]);
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
  // An archived process (issue #182) is read only until it is restored. Either way the read-only page is told why it was
  // opened instead (`?notice=`), so it can say "You can't edit this process" rather than leave the person guessing.
  if (!canEdit || live.process.archived_at) redirect(`${base}?notice=${live.process.archived_at ? EDIT_NOTICE.archived : EDIT_NOTICE.readOnly}`);
  const [scenarios, blocks, sources, viewer, tours, tierSetup, laneInput] = await Promise.all([
    loadWorkspaceScenarios(live.workspace.id),
    loadWorkspaceBlocks(live.workspace.id),
    loadWorkspaceSources(live.workspace.id),
    currentViewer(),
    loadDismissedEditorTours(),
    loadTierSetup(live.workspace.id),
    company ? loadDepartmentLaneInput(live.workspace.id) : Promise.resolve(undefined),
  ]);
  const tourDismissed = tours.includes(company ? "company" : "process");
  // Solution mode built for an issue (`?issue=`, A49): the issue's steps are outlined and its target is what the verdict checks.
  // The company map has no solutions or blocks: it is edited as a draft only.
  const editorMode = company ? "draft" : parseEditorMode(searchParams.mode);
  // "Open in editor" on a solution's page (`?solution=<id>`): the map starts as that solution's copy, linked to the issue it fixes.
  const fromSolutionId = editorMode === "solution" ? parseIssueParam(searchParams.solution) : null;
  const stored = fromSolutionId ? await loadWorkspaceSolutions(live.workspace.id) : null;
  const fromSolution = stored?.solutions.find((s) => s.id === fromSolutionId && s.process_id === live.process.id);
  const issueId = editorMode === "solution" ? (parseIssueParam(searchParams.issue) ?? (fromSolution ? (stored?.links.find((l) => l.solution_id === fromSolution.id)?.issue_id ?? null) : null)) : null;
  const issueRow = issueId ? (await loadWorkspaceIssues(live.workspace.id)).find((i) => i.id === issueId) : undefined;
  const exit = exitHref(searchParams.from, base);
  // "Edit" on a block of the library (`?mode=block&block=<id>`, Q15): block mode starts from that block. One that isn't there goes back to where we came from.
  const editBlockId = editorMode === "block" ? parseIssueParam(searchParams.block) : null;
  const editRow = editBlockId ? blocks.find((b) => b.id === editBlockId) : undefined;
  if (editBlockId && !editRow) redirect(exit);
  return (
    <EditorPhoneGate backHref={exit}>
    <SourceLinkingScope workspaceId={live.workspace.id} sources={sources} canEdit>
    <EditorView
      key={live.process.id}
      live={live}
      draft={draft}
      mode="live"
      editorMode={editorMode}
      issue={issueRow && issueAboutProcess(issueRow, live.process.id) ? solutionIssueOf(issueRow, live.process.id, live.steps) : null}
      scenarios={scenarios}
      blocks={blocks}
      userId={viewer?.userId ?? null}
      // Only those addPurpose would accept (Agency admins and the Owner, as on Settings -> Purposes) are offered "+ New purpose…".
      canAddPurpose={canEdit}
      tourDismissed={tourDismissed}
      historyHref={`/w/${slug}/p/${processId}/history`}
      settingsHref={`/w/${slug}/settings`}
      exitHref={exit}
      solutionSeed={fromSolution ? { bundle: bundleFromSolution(live, fromSolution), name: fromSolution.name } : undefined}
      processEditorHref={`${base}/edit?from=${encodeURIComponent(exit)}`}
      editBlock={editRow ? { id: editRow.id, name: editRow.name, description: editRow.description, bundle: readBlock(editRow.steps) } : undefined}
      blockEditorHref={`${base}/edit?mode=block&from=${encodeURIComponent(exit)}`}
      horizonMonths={parseHorizon(searchParams.horizon)}
      library={company ? library : undefined}
      tierSetup={tierSetup}
      laneInput={laneInput}
      // The changes already stored on the solution this editor was opened on (D53), kept and saved with it as they are.
      stepChanges={fromSolution?.step_changes}
    />
    </SourceLinkingScope>
    </EditorPhoneGate>
  );
}

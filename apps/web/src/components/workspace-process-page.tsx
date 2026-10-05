import { notFound } from "next/navigation";
import { createServicingProcess } from "@/app/w/[slug]/process-actions";
import { isUnpublished } from "@transpera-flow/db";
import { isBlank } from "@transpera-flow/engine";
import { aiConfigured, loadAiViews } from "@/lib/ai/data";
import { ProcessNav } from "@/components/process-nav";
import { ProcessPage } from "@/components/process-page";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { canEditWorkspace, currentUserId } from "@/lib/access-data";
import { loadIdeaIssueIds, loadLastChange } from "@/lib/process-page/data";
import { loadProcessFirstPrinciples } from "@/lib/first-principles/data";
import { processRatings, trailOf } from "@/lib/processes/rows";
import { loadWorkspaceAnalysisRules } from "@/lib/rules/data";
import { loadMemberNames, loadProcessForEditing, loadProcessVersion, loadWorkspaceIssues, loadWorkspaceLiveRevisionIds, loadWorkspaceScenarios, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";

/**
 * A process of the workspace on the canvas, at `/w/[slug]/p/[processId]` (any process, never-published ones
 * included; issue #76). The workspace root is the Overview.
 */
export async function WorkspaceProcessPage({ slug, processId, version }: { slug: string; processId: string; version?: number | null }) {
  const process = await loadProcessForEditing(slug, processId);
  if (!process) notFound();
  const { live, draft, processes } = process;
  // `?version=N` shows an earlier version, read only; a number that isn't an earlier version shows live.
  const earlier = version ? await loadProcessVersion(live, version) : null;
  const [canEdit, scenarios, issues, sources, rules, liveRevisions, solutions, viewerId, memberNames, lastChange, ideaIssueIds] = await Promise.all([
    canEditWorkspace(live.workspace.id),
    loadWorkspaceScenarios(live.workspace.id),
    loadWorkspaceIssues(live.workspace.id),
    loadWorkspaceSources(live.workspace.id),
    loadWorkspaceAnalysisRules(live.workspace.id),
    // Every process, so a dismissal on a step of a process inside this one is measured against that process.
    loadWorkspaceLiveRevisionIds(live.workspace.id),
    loadWorkspaceSolutions(live.workspace.id, live.process.id),
    currentUserId(),
    loadMemberNames(live.workspace.id),
    loadLastChange(live.process.id),
    loadIdeaIssueIds(live.workspace.id),
  ]);
  // First principles of the version on screen, and whether the draft has answers live doesn't (A54).
  const shown = earlier ?? (isUnpublished(live) && draft ? draft : live);
  const fpIds = [shown.revision.id, ...(draft && draft !== shown ? [draft.revision.id] : [])];
  const fp = await loadProcessFirstPrinciples(live.process.id, fpIds);
  const fpShown = fp[shown.revision.id]!;
  // What AI wrote about the version on screen (A46). A draft that was never published has nothing.
  const aiViews = isUnpublished(live) && !earlier ? {} : await loadAiViews([shown.revision.id]);
  const fpDraft = draft && draft !== shown && !earlier ? fp[draft.revision.id]! : null;
  const draftChanged = fpDraft !== null && JSON.stringify(fpDraft.doc) !== JSON.stringify(fpShown.doc);
  const base = `/w/${slug}`;
  const hrefs = Object.fromEntries(processes.map((p) => [p.id, `${base}/p/${p.id}`]));
  const byId = new Map(processes.map((p) => [p.id, { id: p.id, name: p.name, parentId: p.parentId ?? null }]));
  const ratings = processRatings(processes, issues, [...live.steps, ...(live.otherProcesses ?? []).flatMap((p) => p.steps)]);
  return (
    <SourceLinkingScope workspaceId={live.workspace.id} sources={sources} canEdit={canEdit && !earlier}>
    <ProcessPage
      key={live.process.id}
      // A process never published has only its draft to show.
      bundle={shown}
      viewingVersion={earlier ? earlier.revision.number : null}
      liveVersion={isUnpublished(live) ? 0 : live.revision.number}
      // An earlier version is read only, so nothing on it can be logged or edited.
      mode={canEdit && !earlier ? "live" : "readonly"}
      scenarios={scenarios}
      issues={issues}
      sources={sources}
      liveRevisions={liveRevisions}
      analysisRules={rules.settings}
      registerHref={`${base}/issues`}
      settingsHref={`${base}/settings`}
      rating={ratings[live.process.id] ?? null}
      editHref={canEdit ? `${base}/p/${live.process.id}/edit` : undefined}
      historyHref={`${base}/p/${live.process.id}/history`}
      solutions={{ data: solutions, base, viewerId, memberNames }}
      ideaIssueIds={ideaIssueIds}
      aboutInfo={{ trail: trailOf({ id: live.process.id, parentId: live.process.parent_process_id }, byId).map((t) => t.name), hasDraft: draft !== null && !isUnpublished(live), lastChange }}
      ai={{ view: aiViews[shown.revision.id] ?? null, configured: aiConfigured(), hasFirstPrinciples: fpShown.doc !== null && !isBlank(fpShown.doc), versionNumber: isUnpublished(live) ? null : shown.revision.number }}
      firstPrinciples={{ doc: fpShown.doc, href: `${base}/p/${live.process.id}/first-principles`, draftChanged, inheritedFrom: fpShown.inheritedFrom }}
      inside={processes.filter((p) => p.parentId === live.process.id).map((p) => ({ id: p.id, name: p.name, href: hrefs[p.id]! }))}
      processPicker={
        <ProcessNav
          processes={processes}
          current={live.process.id}
          hrefs={hrefs}
          create={canEdit ? createServicingProcess.bind(null, live.workspace.id, slug) : undefined}
          ratings={ratings}
          processesHref={`${base}/processes`}
          companyMapHref={base}
        />
      }
    />
    </SourceLinkingScope>
  );
}

import { notFound, redirect } from "next/navigation";
import { restoreProcess } from "@/app/w/[slug]/process-admin-actions";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { ArchivedBanner } from "@/components/processes/archived-banner";
import { isUnpublished } from "@transpera-flow/db";
import { ProcessNav } from "@/components/process-nav";
import { ShareButton } from "@/components/share/share-dialog";
import { ProcessPage } from "@/components/process-page";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { canEditWorkspace, currentUserId } from "@/lib/access-data";
import { loadLastChange } from "@/lib/process-page/data";
import { loadProcessFirstPrinciples } from "@/lib/first-principles/data";
import { processRatings, trailOf } from "@/lib/processes/rows";
import { loadCompanyId, loadMemberNames, loadProcessForEditing, loadProcessVersion, loadWorkspaceHead, loadWorkspaceIssues, loadWorkspaceLiveRevisionIds, loadWorkspaceScenarios, loadWorkspaceSolutions, loadWorkspaceSources, withDeleteCandidates } from "@/lib/data";

/**
 * A process of the workspace on the canvas, at `/w/[slug]/p/[processId]` (any process, never-published ones
 * included; issue #76). The workspace root is the Overview.
 */
export async function WorkspaceProcessPage({ slug, processId, version }: { slug: string; processId: string; version?: number | null }) {
  const process = await loadProcessForEditing(slug, processId);
  if (!process) {
    // The company map is read at the Overview, not at a process page of its own (it can't be simulated). Any other unknown id is a 404.
    const head = await loadWorkspaceHead(slug);
    if (head && (await loadCompanyId(head.id)) === processId) redirect(version ? `/w/${encodeURIComponent(slug)}?version=${version}` : `/w/${encodeURIComponent(slug)}`);
    notFound();
  }
  const { live, draft, processes } = process;
  // An archived process (issue #182) opens read only, with its date and, for editors, Restore.
  const archivedAt = live.process.archived_at ?? null;
  // `?version=N` shows an earlier version, read only; a number that isn't an earlier version shows live.
  const earlier = version ? await loadProcessVersion(live, version) : null;
  const [canEdit, scenarios, issues, sources, liveRevisions, solutions, viewerId, memberNames] = await Promise.all([
    canEditWorkspace(live.workspace.id),
    loadWorkspaceScenarios(live.workspace.id),
    loadWorkspaceIssues(live.workspace.id),
    loadWorkspaceSources(live.workspace.id),
    // Every process, so a dismissal on a step of a process inside this one is measured against that process.
    loadWorkspaceLiveRevisionIds(live.workspace.id),
    loadWorkspaceSolutions(live.workspace.id, live.process.id),
    currentUserId(),
    loadMemberNames(live.workspace.id),
  ]);
  // Who last published the live version.
  const lastChange = isUnpublished(live) ? null : await loadLastChange(live.revision.id, memberNames);
  // First principles of the version on screen, and whether the draft has answers live doesn't (A54).
  const shown = earlier ?? (isUnpublished(live) && draft ? draft : live);
  const fpIds = [shown.revision.id, ...(draft && draft !== shown ? [draft.revision.id] : [])];
  const fp = await loadProcessFirstPrinciples(live.process.id, fpIds);
  const fpShown = fp[shown.revision.id]!;
  const fpDraft = draft && draft !== shown && !earlier ? fp[draft.revision.id]! : null;
  const draftChanged = fpDraft !== null && JSON.stringify(fpDraft.doc) !== JSON.stringify(fpShown.doc);
  const base = `/w/${slug}`;
  const hrefs = Object.fromEntries(processes.map((p) => [p.id, `${base}/p/${p.id}`]));
  const byId = new Map(processes.map((p) => [p.id, { id: p.id, name: p.name, parentId: p.parentId ?? null }]));
  const ratings = processRatings(processes, issues, [...live.steps, ...(live.otherProcesses ?? []).flatMap((p) => p.steps)]);
  return (
    <SourceLinkingScope workspaceId={live.workspace.id} sources={sources} canEdit={canEdit && !earlier && !archivedAt}>
    <ProcessPage
      key={live.process.id}
      // A process never published has only its draft to show.
      bundle={await withDeleteCandidates(shown)}
      viewingVersion={earlier ? earlier.revision.number : null}
      liveVersion={isUnpublished(live) ? 0 : live.revision.number}
      // An earlier version is read only, so nothing on it can be logged or edited.
      mode={canEdit && !earlier && !archivedAt ? "live" : "readonly"}
      notice={archivedAt ? <ArchivedBanner name={live.process.name} archivedAt={archivedAt} restore={canEdit ? restoreProcess.bind(null, live.process.id) : undefined} /> : undefined}
      scenarios={scenarios}
      issues={issues}
      sources={sources}
      liveRevisions={liveRevisions}
      registerHref={`${base}/issues`}
      settingsHref={`${base}/settings`}
      rating={ratings[live.process.id] ?? null}
      editHref={canEdit && !archivedAt ? `${base}/p/${live.process.id}/edit` : undefined}
      historyHref={`${base}/p/${live.process.id}/history`}
      solutions={{ data: solutions, base, viewerId, memberNames }}
      aboutInfo={{ trail: trailOf({ id: live.process.id, parentId: live.process.parent_process_id }, byId).map((t) => t.name), hasDraft: draft !== null && !isUnpublished(live), lastChange }}
      // Agency admins share the published version of an ordinary process (not an earlier version, an archived one or the company map).
      share={canEdit && !earlier && !archivedAt && !isUnpublished(live) && !live.process.is_company ? <ShareButton slug={slug} kind="process" targetId={live.process.id} what={live.process.name} /> : undefined}
      firstPrinciples={{ doc: fpShown.doc, href: `${base}/p/${live.process.id}/first-principles`, draftChanged, inheritedFrom: fpShown.inheritedFrom }}
      inside={processes.filter((p) => p.parentId === live.process.id).map((p) => ({ id: p.id, name: p.name, href: hrefs[p.id]! }))}
      processPicker={
        <ProcessNav
          processes={processes}
          current={live.process.id}
          hrefs={hrefs}
          create={canEdit ? createProcess.bind(null, live.workspace.id, slug) : undefined}
          ratings={ratings}
          processesHref={`${base}/processes`}
          companyMapHref={base}
        />
      }
    />
    </SourceLinkingScope>
  );
}

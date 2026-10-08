import { notFound } from "next/navigation";
import { isBlank } from "@transpera-flow/engine";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { createUpload, previewUpload } from "@/app/w/[slug]/processes/upload-actions";
import { Overview } from "@/components/overview/overview";
import { StartOverview } from "@/components/overview/start-overview";
import { setupChecklist } from "@/lib/overview/setup";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { aiConfigured, loadLatestAiViews, loadWorkspaceAiSettings, loadWorkspaceFindings } from "@/lib/ai/data";
import { analysisBaseHash, isStale } from "@/lib/ai/model-hash";
import { NARRATION_MODEL } from "@/lib/narration/anthropic";
import { loadLiveProcess, loadSolutionBase, loadWorkspaceHead, loadWorkspaceIssues, loadWorkspaceOverview, loadWorkspaceSetup, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";
import { solutionsToCompare, type SolutionBases } from "@/lib/overview/impact";
import { canEditWorkspace } from "@/lib/access-data";
import { loadLiveFirstPrinciples } from "@/lib/first-principles/data";
import { companyMapView } from "@/lib/overview/company-version";
import { loadCompanyVersion, loadLiveCompany, loadLiveParts } from "@/lib/overview/data";
import { ShareButton } from "@/components/share/share-dialog";
import { workspaceIsEmpty } from "@/lib/restore/empty";
import { createClient } from "@/lib/supabase/server";

/** The Overview of a workspace (issue #100): the landing page, at `/w/[slug]` and `/w/[slug]/overview`. */
export async function WorkspaceOverview({ slug, mapVersion = null }: { slug: string; /** `?version=N`: show an earlier version of the company map, read only. */ mapVersion?: number | null }) {
  const live = await loadLiveProcess(slug);
  if (!live) {
    // Nothing is published (a new client): the start page. Members and viewers get a plain sentence; counts only go to editors.
    const head = await loadWorkspaceHead(slug);
    if (!head) notFound();
    const [overview, canEdit] = await Promise.all([loadWorkspaceOverview(slug), canEditWorkspace(head.id)]);
    // The card to restore a backup: only for someone who can, and only while the workspace is empty (drafts count as not empty).
    const canRestore = canEdit && (await workspaceIsEmpty(await createClient(), head.id));
    const setup = canEdit ? await loadWorkspaceSetup(head.id) : null;
    const base = `/w/${slug}`;
    const unpublished = (overview?.processes ?? []).filter((p) => !p.live);
    const firstDraft = unpublished.find((p) => p.draft) ?? null;
    return (
      <StartOverview
        slug={slug}
        name={head.name}
        canEdit={canEdit}
        checklist={setup ? setupChecklist(setup, base, firstDraft) : null}
        drafts={canEdit ? unpublished.map((p) => ({ id: p.id, name: p.name })) : []}
        companyEditHref={setup?.companyId ? `${base}/p/${setup.companyId}/edit?from=${encodeURIComponent(base)}` : null}
        create={canEdit ? createProcess.bind(null, head.id, slug) : undefined}
        upload={canEdit ? { preview: previewUpload.bind(null, head.id, slug), create: createUpload.bind(null, head.id, slug) } : undefined}
        canRestore={canRestore}
      />
    );
  }
  const ws = live.workspace.id;
  const [parts, company, issues, sources, canEdit, firstPrinciples, solutions, findings, aiSettings] = await Promise.all([
    loadLiveParts(ws),
    loadLiveCompany(ws),
    loadWorkspaceIssues(ws),
    loadWorkspaceSources(ws),
    canEditWorkspace(ws),
    loadLiveFirstPrinciples(live.process.id, live.revision.id),
    loadWorkspaceSolutions(ws),
    loadWorkspaceFindings(ws, { viewer: live.viewer, people: live.people }),
    loadWorkspaceAiSettings(ws),
  ]);
  // The latest analysis of the whole company (B17), stored against the company map; out of date once the company model changed.
  const aiView = company ? ((await loadLatestAiViews([company.process.id], { viewer: live.viewer, people: live.people }))[company.process.id] ?? null) : null;
  // Out of date once what it read changed (model, first principles, Anthropic model, sources); the page adds the facts.
  const baseHash = aiView ? analysisBaseHash(live, firstPrinciples, "company", { readSources: aiSettings.read_sources, model: NARRATION_MODEL }) : null;
  const stale = isStale(aiView, { base: baseHash, revisionId: company?.revision.id ?? null });
  const base = `/w/${slug}`;
  // An earlier version of the company map (only its layout and handoff lines differ); a number that isn't one shows live.
  const found = company && mapVersion ? await loadCompanyVersion(ws, mapVersion) : null;
  const view = companyMapView(company, found, canEdit);
  // The solutions the Overview compares before and after (B15): for any copied from an earlier version than live, that version's steps.
  const liveRevision = new Map(parts.map((p) => [p.process.id, p.revision.id]));
  const older = solutionsToCompare(solutions, issues).filter(({ solution: s }) => liveRevision.get(s.process_id) !== s.base_revision_id);
  const loaded = await Promise.all(older.map(({ solution: s }) => loadSolutionBase(slug, s.process_id, s.base_revision_id, live).catch(() => null)));
  const solutionBases: SolutionBases = Object.fromEntries(older.flatMap(({ solution: s }, i) => (loaded[i] ? [[s.id, { steps: loaded[i]!.base.steps, edges: loaded[i]!.base.edges }]] : [])));
  return (
    <SourceLinkingScope workspaceId={ws} sources={sources} canEdit={canEdit}>
    <Overview
      workspaceName={live.workspace.name}
      live={live}
      parts={parts}
      company={view.map}
      viewingMapVersion={view.viewingVersion}
      issues={issues}
      sources={sources}
      mode={canEdit ? "live" : "readonly"}
      firstPrinciples={firstPrinciples}
      solutions={solutions}
      solutionBases={solutionBases}
      hrefs={Object.fromEntries(parts.map((p) => [p.process.id, `${base}/p/${p.process.id}`]))}
      processesHref={`${base}/processes`}
      companyEditHref={view.canEdit && company ? `${base}/p/${company.process.id}/edit?from=${encodeURIComponent(base)}` : undefined}
      companyHistoryHref={company ? `${base}/p/${company.process.id}/history` : undefined}
      bundleHref={canEdit ? `${base}/export/bundle` : undefined}
      issuesHref={`${base}/issues`}
      forecastHref={`${base}/forecast`}
      ai={{ view: aiView, stale, configured: aiConfigured(), hasFirstPrinciples: firstPrinciples !== null && !isBlank(firstPrinciples), versionNumber: null }}
      findings={findings}
      share={canEdit ? <ShareButton slug={slug} kind="overview" targetId={null} what="The Overview" /> : undefined}
    />
    </SourceLinkingScope>
  );
}

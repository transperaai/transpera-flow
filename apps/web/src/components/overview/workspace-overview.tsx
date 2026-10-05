import Link from "next/link";
import { notFound } from "next/navigation";
import { isBlank } from "@transpera-flow/engine";
import { Overview } from "@/components/overview/overview";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { aiConfigured, loadLatestAiViews, loadWorkspaceAiSettings, loadWorkspaceFindings } from "@/lib/ai/data";
import { analysisBaseHash, isStale } from "@/lib/ai/model-hash";
import { NARRATION_MODEL } from "@/lib/narration/anthropic";
import { ShellHeader } from "@/components/shell/shell-header";
import { loadLiveProcess, loadSolutionBase, loadWorkspaceHead, loadWorkspaceIssues, loadWorkspaceOverview, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";
import { solutionsToCompare, type SolutionBases } from "@/lib/overview/impact";
import { canEditWorkspace } from "@/lib/access-data";
import { loadLiveFirstPrinciples } from "@/lib/first-principles/data";
import { companyMapView } from "@/lib/overview/company-version";
import { loadCompanyVersion, loadLiveCompany, loadLiveParts } from "@/lib/overview/data";

/** The Overview of a workspace (issue #100): the landing page, at `/w/[slug]` and `/w/[slug]/overview`. */
export async function WorkspaceOverview({ slug, mapVersion = null }: { slug: string; /** `?version=N`: show an earlier version of the company map, read only. */ mapVersion?: number | null }) {
  const live = await loadLiveProcess(slug);
  if (!live) {
    const head = await loadWorkspaceHead(slug);
    if (!head) notFound();
    const overview = await loadWorkspaceOverview(slug);
    return <EmptyOverview slug={slug} name={head.name} unpublished={overview?.processes ?? []} />;
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
    loadWorkspaceFindings(ws),
    loadWorkspaceAiSettings(ws),
  ]);
  // The latest analysis of the whole company (B17), stored against the company map; out of date once the company model changed.
  const aiView = company ? ((await loadLatestAiViews([company.process.id]))[company.process.id] ?? null) : null;
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
      bundleHref={`${base}/export/bundle`}
      issuesHref={`${base}/issues`}
      forecastHref={`${base}/forecast`}
      ai={{ view: aiView, stale, configured: aiConfigured(), hasFirstPrinciples: firstPrinciples !== null && !isBlank(firstPrinciples), versionNumber: null }}
      findings={findings}
    />
    </SourceLinkingScope>
  );
}

/** A workspace with no published process (a new one): what to do next, where the Overview will be. */
function EmptyOverview({ slug, name, unpublished }: { slug: string; name: string; unpublished: { id: string; name: string; draft: boolean }[] }) {
  const base = `/w/${slug}`;
  return (
    <div>
      <ShellHeader title="Overview" />
      <section className="mx-auto mt-6 w-full max-w-3xl rounded-token border border-dashed border-line p-6">
        <h1 className="text-base font-bold">{name} has no published process yet</h1>
        <p className="mt-2 text-fg-2">The Overview shows the company map, headline numbers and trends once a process is published.</p>
        {unpublished.length > 0 && (
          <>
            <p className="mt-3 text-fg-2">These haven&apos;t been published yet:</p>
            <ul className="mt-1 list-disc pl-5">
              {unpublished.map((p) => (
                <li key={p.id}>
                  <Link href={`${base}/p/${p.id}`} className="font-semibold hover:underline">
                    {p.name}
                  </Link>
                  {p.draft && <span className="ml-2 text-fg-3">has a draft</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-3 text-fg-2">
          To get started, add roles under{" "}
          <Link href={`${base}/settings`} className="underline">
            People &amp; settings
          </Link>
          , then import a process with Claude (<code>set_active_workspace</code>, then <code>import_process</code>). Create a token under{" "}
          <Link href="/settings/tokens" className="underline">
            API tokens
          </Link>{" "}
          to connect it.
        </p>
      </section>
    </div>
  );
}

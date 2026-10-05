import Link from "next/link";
import { notFound } from "next/navigation";
import { isBlank } from "@transpera-flow/engine";
import { Overview } from "@/components/overview/overview";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { aiConfigured, loadAiViews } from "@/lib/ai/data";
import { ShellHeader } from "@/components/shell/shell-header";
import { loadLiveProcess, loadWorkspaceHead, loadWorkspaceIssues, loadWorkspaceOverview, loadWorkspaceSources } from "@/lib/data";
import { canEditWorkspace } from "@/lib/access-data";
import { loadLiveFirstPrinciples } from "@/lib/first-principles/data";
import { companyMapView } from "@/lib/overview/company-version";
import { loadCompanyVersion, loadLiveCompany, loadLiveParts } from "@/lib/overview/data";
import { loadWorkspaceAnalysisRules } from "@/lib/rules/data";

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
  const [parts, company, issues, sources, rules, canEdit, firstPrinciples, aiViews] = await Promise.all([
    loadLiveParts(ws),
    loadLiveCompany(ws),
    loadWorkspaceIssues(ws),
    loadWorkspaceSources(ws),
    loadWorkspaceAnalysisRules(ws),
    canEditWorkspace(ws),
    loadLiveFirstPrinciples(live.process.id, live.revision.id),
    loadAiViews([live.revision.id]),
  ]);
  const base = `/w/${slug}`;
  // An earlier version of the company map (only its layout and handoff lines differ); a number that isn't one shows live.
  const found = company && mapVersion ? await loadCompanyVersion(ws, mapVersion) : null;
  const view = companyMapView(company, found, canEdit);
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
      analysisRules={rules.settings}
      firstPrinciples={firstPrinciples}
      hrefs={Object.fromEntries(parts.map((p) => [p.process.id, `${base}/p/${p.process.id}`]))}
      processesHref={`${base}/processes`}
      companyEditHref={view.canEdit && company ? `${base}/p/${company.process.id}/edit?from=${encodeURIComponent(base)}` : undefined}
      companyHistoryHref={company ? `${base}/p/${company.process.id}/history` : undefined}
      bundleHref={`${base}/export/bundle`}
      issuesHref={`${base}/issues`}
      rulesHref={`${base}/settings/rules`}
      ai={{ view: aiViews[live.revision.id] ?? null, configured: aiConfigured(), hasFirstPrinciples: firstPrinciples !== null && !isBlank(firstPrinciples), versionNumber: live.revision.number }}
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

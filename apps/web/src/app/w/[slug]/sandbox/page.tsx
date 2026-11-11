import { notFound } from "next/navigation";
import { loadCapacitySetup } from "@transpera-flow/db";
import { PlayPage } from "@/components/sandbox/play-page";
import { SandboxView } from "@/components/sandbox/sandbox-view";
import { SANDBOX_SCENARIOS_SHOWN } from "@/lib/sandbox/scenarios-shown";
import { getDb } from "@/lib/auth/session";
import { listCompanyRevisions, loadCompanyRevision, loadLiveCompany, loadLiveParts } from "@/lib/overview/data";
import { loadDepartmentLaneInput } from "@/lib/overview/lanes-data";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { PageHeader } from "@/components/page-kit";
import { NotPublished } from "@/components/shell/not-published";
import { Page } from "@/components/shell/page";
import { ShellHeader } from "@/components/shell/shell-header";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { canEditWorkspace } from "@/lib/access-data";
import { isId } from "@/lib/sources/validate";
import { loadLiveProcess, loadPublishState, loadWorkspaceIssues, loadWorkspaceSandboxScenarios, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";

/**
 * The Sandbox (capacity build P7, D38): free play, as one scrolling page. A toolbar, the company map (click a process to load another
 * version of it), the levers laid out in a band under it, then the results against today's path: a verdict, its figures and the charts. Nothing is saved; the levers reset when you leave. Everyone who
 * can read the workspace plays; Stored scenarios stay in the database, and
 * the old scenario page is behind SANDBOX_SCENARIOS_SHOWN.
 */
export default async function WorkspaceSandboxPage(props: PageProps<"/w/[slug]/sandbox">) {
  const { slug } = await props.params;
  const { solution: solutionParam, company: companyParam } = await props.searchParams;
  const live = await loadLiveProcess(slug);
  if (!live) {
    // Nothing is published (a new client): there is nothing to run forward. No scenarios are loaded.
    const state = await loadPublishState(slug);
    if (!state) notFound();
    const canEdit = await canEditWorkspace(state.workspace.id);
    return (
      <Page title="Sandbox" hideHeader>
        <PageHeader label="Sandbox" eyebrow={<span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Company</span>} title="Sandbox" />
        <NotPublished
          what="The Sandbox runs the published processes forward month by month to show who gets too busy, and when, and lets you try changes before you make them."
          canEdit={canEdit}
          base={`/w/${slug}`}
          firstDraft={state.firstDraft}
          create={canEdit ? createProcess.bind(null, state.workspace.id, slug) : undefined}
        />
      </Page>
    );
  }
  const ws = live.workspace.id;
  if (!SANDBOX_SCENARIOS_SHOWN) {
    const db = await getDb();
    const [setup, parts, liveCompany, issues, canEdit, solutions, laneInput, companyRevisions] = await Promise.all([
      loadCapacitySetup(db, ws),
      loadLiveParts(ws),
      loadLiveCompany(ws),
      loadWorkspaceIssues(ws),
      canEditWorkspace(ws),
      loadWorkspaceSolutions(ws),
      loadDepartmentLaneInput(ws),
      listCompanyRevisions(ws),
    ]);
    if (!setup) notFound();
    // `?company=<revision id | draft>`: another version of the company map (Q17): it is run against today's path, so an unpublished map can be tested.
    const chosen = typeof companyParam === "string" ? (companyParam === "draft" ? companyRevisions.find((r) => r.status === "draft") : companyRevisions.find((r) => r.id === companyParam)) : undefined;
    const company = chosen && !chosen.live ? ((await loadCompanyRevision(ws, chosen.id)) ?? liveCompany) : liveCompany;
    const companyRevisionId = chosen && company !== liveCompany ? chosen.id : (companyRevisions.find((r) => r.live)?.id ?? null);
    // One page that scrolls as a whole, on a phone too: no viewport-height frame and no panes of its own.
    return (
      <div className="flex min-w-0 flex-col">
        <ShellHeader title="Sandbox" />
        <PlayPage live={live} parts={parts} company={company} setup={setup} solutions={solutions.solutions} solutionLinks={solutions.links} issues={issues} canEdit={canEdit} base={`/w/${slug}`} laneInput={laneInput} companyRevisions={companyRevisions} companyRevisionId={companyRevisionId} initialSolutionId={typeof solutionParam === "string" && isId(solutionParam) ? solutionParam : null} />
      </div>
    );
  }
  const [issues, sources, canEdit, scenarios, solutions] = await Promise.all([
    loadWorkspaceIssues(ws),
    loadWorkspaceSources(ws),
    canEditWorkspace(ws),
    loadWorkspaceSandboxScenarios(ws),
    loadWorkspaceSolutions(ws).then((d) => d.solutions),
  ]);
  const base = `/w/${slug}`;
  return (
    <Page title="Sandbox" hideHeader>
      <SourceLinkingScope workspaceId={ws} sources={sources} canEdit={canEdit}>
        <SandboxView
          live={live}
          issues={issues}
          sources={sources}
          mode={canEdit ? "live" : "readonly"}
          issuesHref={`${base}/issues`}
          peopleHref={`${base}/settings`}
          purposesHref={`${base}/settings#purposes`}
          scenarios={scenarios}
          solutions={solutions}
        />
      </SourceLinkingScope>
    </Page>
  );
}

import { notFound } from "next/navigation";
import { ForecastView } from "@/components/forecast/forecast-view";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { NotPublished } from "@/components/shell/not-published";
import { Page } from "@/components/shell/page";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { canEditWorkspace } from "@/lib/access-data";
import { loadLiveProcess, loadPublishState, loadWorkspaceForecastPlans, loadWorkspaceIssues, loadWorkspaceSolutions, loadWorkspaceSources } from "@/lib/data";

/** The Forecast (issue #35, B6): who gets too busy, and when, from the live model run forward month by month. */
export default async function WorkspaceForecastPage(props: PageProps<"/w/[slug]/forecast">) {
  const { slug } = await props.params;
  const live = await loadLiveProcess(slug);
  if (!live) {
    // Nothing is published (a new client): there is nothing to run forward. No plans are loaded.
    const state = await loadPublishState(slug);
    if (!state) notFound();
    const canEdit = await canEditWorkspace(state.workspace.id);
    return (
      <Page title="Forecast" width="max-w-6xl">
        <NotPublished
          what="The forecast runs the published processes forward month by month to show who gets too busy, and when."
          canEdit={canEdit}
          base={`/w/${slug}`}
          firstDraft={state.firstDraft}
          create={canEdit ? createProcess.bind(null, state.workspace.id, slug) : undefined}
        />
      </Page>
    );
  }
  const ws = live.workspace.id;
  const [issues, sources, canEdit] = await Promise.all([loadWorkspaceIssues(ws), loadWorkspaceSources(ws), canEditWorkspace(ws)]);
  // Plans are for owners, editors and agency admins (B7): everyone else gets the forecast as it was, with no plan UI.
  const [plans, solutions] = canEdit ? await Promise.all([loadWorkspaceForecastPlans(ws), loadWorkspaceSolutions(ws).then((d) => d.solutions)]) : [[], []];
  const base = `/w/${slug}`;
  return (
    <Page title="Forecast" width="max-w-6xl" hideHeader>
      <SourceLinkingScope workspaceId={ws} sources={sources} canEdit={canEdit}>
        <ForecastView
          live={live}
          issues={issues}
          sources={sources}
          mode={canEdit ? "live" : "readonly"}
          issuesHref={`${base}/issues`}
          peopleHref={`${base}/settings`}
          plans={plans}
          solutions={solutions}
        />
      </SourceLinkingScope>
    </Page>
  );
}

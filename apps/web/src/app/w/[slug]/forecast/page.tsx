import { notFound } from "next/navigation";
import { ForecastView } from "@/components/forecast/forecast-view";
import { Page } from "@/components/shell/page";
import { SourceLinkingScope } from "@/components/sources/linking-scope";
import { canEditWorkspace } from "@/lib/access-data";
import { loadLiveProcess, loadWorkspaceIssues, loadWorkspaceSources } from "@/lib/data";

/** The Forecast (issue #35, B6): who gets too busy, and when, from the live model run forward month by month. */
export default async function WorkspaceForecastPage(props: PageProps<"/w/[slug]/forecast">) {
  const { slug } = await props.params;
  const live = await loadLiveProcess(slug);
  if (!live) notFound();
  const ws = live.workspace.id;
  const [issues, sources, canEdit] = await Promise.all([loadWorkspaceIssues(ws), loadWorkspaceSources(ws), canEditWorkspace(ws)]);
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
        />
      </SourceLinkingScope>
    </Page>
  );
}

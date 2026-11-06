import { notFound } from "next/navigation";
import { Page } from "@/components/shell/page";
import { SourcesPage } from "@/components/sources-page";
import { canEditWorkspace } from "@/lib/access-data";
import { loadSourcesPage } from "@/lib/data";

/** The Sources screen (docs/PRD.md §8 screen 7): the audit's transcripts and notes, and every value citing each one. */
export default async function WorkspaceSourcesPage(props: PageProps<"/w/[slug]/sources">) {
  const { slug } = await props.params;
  const data = await loadSourcesPage(slug);
  if (!data) notFound();
  const canEdit = await canEditWorkspace(data.workspace.id);
  return (
    <Page title="Sources" hideHeader>
      <SourcesPage
        workspaceId={data.workspace.id}
        sources={data.sources}
        total={data.total}
        totalAll={data.totalAll}
        deletedSourceIds={data.deletedSourceIds}
        citations={data.citations}
        links={data.links}
        targets={data.targets}
        mode={canEdit ? "live" : "readonly"}
        processBase={`/w/${slug}/p`}
      />
    </Page>
  );
}

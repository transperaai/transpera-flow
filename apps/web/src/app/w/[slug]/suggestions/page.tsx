import Link from "next/link";
import { notFound } from "next/navigation";
import { LiveProposals } from "@/components/proposals-review";
import { Page } from "@/components/shell/page";
import { ChangeLog, LiveSuggestions } from "@/components/suggestions-review";
import { loadSuggestionsPage } from "@/lib/company-data";

/** The Suggestions screen (docs/PRD.md §8 screen 8, §7.1c; issues #25 and #117). */
export default async function SuggestionsPage(props: PageProps<"/w/[slug]/suggestions">) {
  const { slug } = await props.params;
  const data = await loadSuggestionsPage(slug);
  if (!data) notFound();
  return (
    <Page
      title="Suggestions"
      eyebrow="Improve"
      description={
        <>
          Everything AI proposes waits here. Nothing reaches the map, issues, solutions or settings until you act on it. Changes you make in{" "}
          <Link href={`/w/${slug}/settings`} className="underline underline-offset-2">
            settings
          </Link>{" "}
          apply straight away.
          {!data.canEdit && " You can view suggestions; editors and owners review them."}
        </>
      }
    >
      <LiveProposals
        workspaceId={data.workspace.id}
        initial={data.proposals}
        lookups={data.lookups}
        contacts={data.contacts}
        canEdit={data.canEdit}
        base={`/w/${slug}`}
      >
        <LiveSuggestions
          workspaceId={data.workspace.id}
          initial={data.suggestions}
          model={data.model}
          sources={data.sources}
          canEdit={data.canEdit}
          sourcesHref={`/w/${slug}/sources`}
        />
      </LiveProposals>
      {data.changes && <ChangeLog entries={data.changes} model={data.model} people={data.people} />}
    </Page>
  );
}

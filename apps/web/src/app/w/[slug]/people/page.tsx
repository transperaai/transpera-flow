import Link from "next/link";
import { notFound } from "next/navigation";
import { createProcess } from "@/app/w/[slug]/process-actions";
import { PeoplePage } from "@/components/people-page";
import { NotPublished } from "@/components/shell/not-published";
import { Page } from "@/components/shell/page";
import { canEditWorkspace } from "@/lib/access-data";
import { loadLiveProcess, loadPublishState } from "@/lib/data";

/** The People page (issue #120): the company's client health against its benchmark, the team, and how busy each person is. */
export default async function WorkspacePeoplePage(props: PageProps<"/w/[slug]/people">) {
  const { slug } = await props.params;
  const bundle = await loadLiveProcess(slug);
  const description = "How healthy your clients are, and how busy each person is, from a simulation of the live process.";
  if (!bundle) {
    // Nothing is published (a new client): nothing to simulate. No roster, names, counts or pay here, for anyone (#30);
    // Settings, People is the roster.
    const state = await loadPublishState(slug);
    if (!state) notFound();
    const canEdit = await canEditWorkspace(state.workspace.id);
    const base = `/w/${slug}`;
    return (
      <Page title="People" eyebrow="Company" description={description} width="max-w-6xl">
        <NotPublished
          what="How busy each person is, and how healthy your clients are, come from a simulation of a published process."
          canEdit={canEdit}
          base={base}
          firstDraft={state.firstDraft}
          create={canEdit ? createProcess.bind(null, state.workspace.id, slug) : undefined}
        />
        {canEdit && (
          <p className="mt-3 text-sm">
            <Link href={`${base}/settings#people-heading`} className="font-medium text-accent hover:underline">
              Add people in Settings →
            </Link>
          </p>
        )}
      </Page>
    );
  }
  return (
    <Page title="People" eyebrow="Company" description={description} width="max-w-6xl">
      <PeoplePage bundle={bundle} settingsHref={`/w/${slug}/settings`} forecast={{ href: `/w/${slug}/forecast` }} />
    </Page>
  );
}

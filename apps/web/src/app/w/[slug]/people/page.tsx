import { notFound } from "next/navigation";
import { PeoplePage } from "@/components/people-page";
import { Page } from "@/components/shell/page";
import { loadLiveProcess } from "@/lib/data";

/** The People page (issue #120): the company's client health against its benchmark, the team, and how busy each person is. */
export default async function WorkspacePeoplePage(props: PageProps<"/w/[slug]/people">) {
  const { slug } = await props.params;
  const bundle = await loadLiveProcess(slug);
  if (!bundle) notFound();
  return (
    <Page
      title="People"
      eyebrow="Company"
      description="How healthy your clients are, and how busy each person is, from a simulation of the live process."
      width="max-w-6xl"
    >
      <PeoplePage bundle={bundle} settingsHref={`/w/${slug}/settings`} forecast={{ href: `/w/${slug}/forecast` }} />
    </Page>
  );
}

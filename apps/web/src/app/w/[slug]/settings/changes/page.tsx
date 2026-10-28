import { notFound } from "next/navigation";
import { ChangeLog } from "@/components/change-log";
import { Page } from "@/components/shell/page";
import { loadChangeLogPage } from "@/lib/company-data";

/**
 * Settings -> Change log: the company model's audit log, for owners and agency admins (RLS decides; anyone else is told so). It was
 * the end of the Suggestions page, which was removed 28 Oct 2026 (docs/plans/cut-list.md item 2).
 */
export default async function ChangeLogPage(props: PageProps<"/w/[slug]/settings/changes">) {
  const { slug } = await props.params;
  const data = await loadChangeLogPage(slug);
  if (!data) notFound();
  return (
    <Page title="Change log" eyebrow="Company" description="Who changed the company model, and what they changed.">
      {data.changes ? (
        <ChangeLog entries={data.changes} model={data.model} people={data.people} stepNames={data.stepNames} />
      ) : (
        <p className="rounded-lg border border-dashed border-line p-4 text-fg-2">Only owners can read the change log.</p>
      )}
    </Page>
  );
}

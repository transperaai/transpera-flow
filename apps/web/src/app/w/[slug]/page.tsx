import { parseVersion } from "@/lib/process-version";
import { WorkspaceOverview } from "@/components/overview/workspace-overview";
import { RestoreNotice } from "@/components/restore/restore-notice";

/** A workspace opens on its Overview (issue #100); the first process's map is under Processes, at `/w/[slug]/p/[processId]`. */
/** AI analysis runs here after a response (A46): allow it time. */
export const maxDuration = 120;

export default async function WorkspacePage(props: PageProps<"/w/[slug]">) {
  const { slug } = await props.params;
  const { version } = await props.searchParams;
  return (
    <>
      <RestoreNotice />
      <WorkspaceOverview slug={slug} mapVersion={parseVersion(version)} />
    </>
  );
}

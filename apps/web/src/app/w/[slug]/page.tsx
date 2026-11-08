import { parseVersion } from "@/lib/process-version";
import { WorkspaceOverview } from "@/components/overview/workspace-overview";
import { RestoreNotice } from "@/components/restore/restore-notice";

/** A workspace opens on its Overview (issue #100); the first process's map is under Processes, at `/w/[slug]/p/[processId]`. */
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

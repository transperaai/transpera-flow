import { parseVersion } from "@/lib/process-version";
import { WorkspaceOverview } from "@/components/overview/workspace-overview";

/** The Overview (issue #100): where the whole company stands. */
/** AI analysis runs here after a response (A46): allow it time. */
export const maxDuration = 120;

export default async function OverviewPage(props: PageProps<"/w/[slug]/overview">) {
  const { slug } = await props.params;
  const { version } = await props.searchParams;
  return <WorkspaceOverview slug={slug} mapVersion={parseVersion(version)} />;
}

import { notFound } from "next/navigation";
import { WorkspaceProcessPage } from "@/components/workspace-process-page";
import { isId } from "@/lib/editor/validate";
import { parseVersion } from "@/lib/process-version";

/** Any process of the workspace on the canvas, including one never published (issue #76); `?version=N` shows an earlier version. */
export default async function ProcessPage(props: PageProps<"/w/[slug]/p/[processId]">) {
  const { slug, processId } = await props.params;
  if (!isId(processId)) notFound();
  const { version } = await props.searchParams;
  return <WorkspaceProcessPage slug={slug} processId={processId} version={parseVersion(version)} />;
}

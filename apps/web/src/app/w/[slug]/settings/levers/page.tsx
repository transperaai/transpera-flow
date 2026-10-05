import { notFound } from "next/navigation";
import { LeversSettings } from "@/components/levers/levers-settings";
import { SavedScenarios } from "@/components/levers/saved-scenarios";
import { canEditWorkspace } from "@/lib/access-data";
import { loadWorkspaceHead, loadWorkspaceScenarios } from "@/lib/data";
import { loadWorkspaceLeverSettings } from "@/lib/levers/data";
import { deleteScenario } from "../../scenario-actions";

/**
 * Settings -> Levers (issue #123): every lever, with a switch for whether it shows on process pages and in the
 * Editor, stored per workspace. Everyone in the workspace sees the list; owners and editors change it. Under it, the
 * workspace's saved scenarios, which owners and editors can delete (issue #182).
 */
export default async function LeversPage(props: PageProps<"/w/[slug]/settings/levers">) {
  const { slug } = await props.params;
  const head = await loadWorkspaceHead(slug);
  if (!head) notFound();
  const [canEdit, levers, scenarios] = await Promise.all([canEditWorkspace(head.id), loadWorkspaceLeverSettings(head.id), loadWorkspaceScenarios(head.id)]);
  return (
    <LeversSettings mode={canEdit ? "live" : "readonly"} workspaceId={head.id} initial={levers} settingsBase={`/w/${slug}`}>
      <SavedScenarios scenarios={scenarios} canEdit={canEdit} remove={deleteScenario} />
    </LeversSettings>
  );
}

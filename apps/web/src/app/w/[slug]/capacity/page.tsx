import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCapacitySetup } from "@transpera-flow/db";
import { CapacityPage } from "@/components/capacity/capacity-page";
import { NotPublished } from "@/components/shell/not-published";
import { Page } from "@/components/shell/page";
import { canEditWorkspace } from "@/lib/access-data";
import { getDb } from "@/lib/auth/session";
import { loadLiveProcess, loadPublishState } from "@/lib/data";

const DESCRIPTION = "Are we at capacity, who has room, and how many more clients fit. \"Today\" is the current book of clients with nobody arriving or leaving.";

/**
 * The Capacity page (capacity build P5), which replaces the People page: the service-line headline and DLER, room for more clients per
 * department, who looks after what, shared teams, the bottleneck, what if someone leaves, time to serve one client and the next 12 months.
 * Everyone who can read the workspace sees it; salaries are loaded as the viewer (row-level security) and never reach someone who can't see pay.
 */
export default async function WorkspaceCapacityPage(props: PageProps<"/w/[slug]/capacity">) {
  const { slug } = await props.params;
  const base = `/w/${slug}`;
  const bundle = await loadLiveProcess(slug);
  if (!bundle) {
    // Nothing is published (a new client): nothing to simulate. No roster, names, counts or pay here, for anyone (#30).
    const state = await loadPublishState(slug);
    if (!state) notFound();
    const canEdit = await canEditWorkspace(state.workspace.id);
    return (
      <Page title="Capacity" eyebrow="Company" description={DESCRIPTION} width="max-w-6xl">
        <NotPublished
          what="Capacity, and who has room for more clients, comes from a simulation of a published process."
          canEdit={canEdit}
          base={base}
          firstDraft={state.firstDraft}
          // No create action here: the Capacity page changes nothing (role-gating.test.ts). An editor starts a process from Processes.
        />
        {canEdit && (
          <p className="mt-3 text-sm">
            <Link href={`${base}/setup/people`} className="font-medium text-accent hover:underline">
              Add people in Set up →
            </Link>
          </p>
        )}
      </Page>
    );
  }
  const setup = await loadCapacitySetup(await getDb(), bundle.workspace.id);
  if (!setup) notFound();
  return (
    <Page title="Capacity" eyebrow="Company" description={DESCRIPTION} width="max-w-6xl">
      <CapacityPage bundle={bundle} setup={setup} base={base} />
    </Page>
  );
}

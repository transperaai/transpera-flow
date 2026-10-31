import { notFound } from "next/navigation";
import { loadCapacitySetup, uniqueClients } from "@transpera-flow/db";
import { Page } from "@/components/shell/page";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { TiersAndClients } from "@/components/setup/tiers-clients";
import { loadWorkspaceClients, loadWorkspaceSettings } from "@/lib/data";
import { getDb } from "@/lib/auth/session";

/** Set up, Tiers & clients (capacity build P1): tiers and their numbers, clients taking both services, and named clients with their own values. */
export default async function SetupClientsPage(props: PageProps<"/w/[slug]/setup/clients">) {
  const { slug } = await props.params;
  const data = await loadWorkspaceSettings(slug);
  if (!data) notFound();
  const setup = await loadCapacitySetup(await getDb(), data.workspace.id);
  if (!setup) notFound();
  const roster = await loadWorkspaceClients(data.workspace.id);
  const u = uniqueClients(setup);
  const counts = setup.departments.map((d) => `${u.byDepartment[d.id] ?? 0} with ${d.name}`);
  return (
    <Page
      title="Tiers & clients"
      eyebrow="Set up"
      description="Where tiers, tier counts and named clients are keyed in. A named client starts from its tier's values; anything filled in replaces them. Agency admins and the Owner can change this; everyone can read it."
      width="max-w-6xl"
    >
      <PhoneNotice />
      <p className="rounded-lg border border-line bg-panel p-3 text-sm" data-unique-clients>
        <b>{u.unique}</b> unique clients: {counts.join(", ")}, {u.both} taking both services.
      </p>
      <TiersAndClients setup={setup} data={data} roster={roster} />
    </Page>
  );
}

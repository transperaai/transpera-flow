import { notFound } from "next/navigation";
import { loadCapacitySetup, uniqueClients } from "@transpera-flow/db";
import { SettingsPage } from "@/components/settings/settings-page";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { TiersAndClients } from "@/components/setup/tiers-clients";
import { loadWorkspaceClients, loadWorkspaceSettings } from "@/lib/data";
import { getDb } from "@/lib/auth/session";

/** Settings, Tiers & clients (capacity build P1): tiers and their numbers, clients taking both services, and named clients with their own values. */
export default async function SettingsClientsPage(props: PageProps<"/w/[slug]/settings/clients">) {
  const { slug } = await props.params;
  const data = await loadWorkspaceSettings(slug);
  if (!data) notFound();
  const setup = await loadCapacitySetup(await getDb(), data.workspace.id);
  if (!setup) notFound();
  const roster = await loadWorkspaceClients(data.workspace.id);
  const u = uniqueClients(setup);
  const counts = setup.departments.map((d) => `${u.byDepartment[d.id] ?? 0} with ${d.name}`);
  return (
    <SettingsPage
      title="Tiers & clients"
      slug={slug}
      canManage={data.canManage}
      description="Where tiers, tier counts and named clients are keyed in. A named client starts from its tier's values; anything filled in replaces them. Agency admins and the Owner can change this; everyone can read it."
    >
      <PhoneNotice />
      <p className="px-1 text-sm text-fg-2" data-unique-clients>
        <b className="text-foreground">{u.unique}</b> unique clients: {counts.join(", ")}, {u.both} taking both services.
      </p>
      <TiersAndClients setup={setup} data={data} roster={roster} />
    </SettingsPage>
  );
}

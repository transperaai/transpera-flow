import { notFound } from "next/navigation";
import { loadCapacitySetup } from "@transpera-flow/db";
import { SettingsPage } from "@/components/settings/settings-page";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { PeopleAndRoles, PeopleHeaderActions } from "@/components/setup/people-roles";
import { peopleMeta } from "@/lib/setup/people-meta";
import { loadWorkspaceSettings } from "@/lib/data";
import { getDb } from "@/lib/auth/session";

/** Settings, People & roles (capacity build P1): people and roles as standard rows that open into a panel, how the shared teams work, and the workspace-wide defaults. */
export default async function SettingsPeoplePage(props: PageProps<"/w/[slug]/settings/people">) {
  const { slug } = await props.params;
  const data = await loadWorkspaceSettings(slug);
  if (!data) notFound();
  const setup = await loadCapacitySetup(await getDb(), data.workspace.id);
  if (!setup) notFound();
  return (
    <SettingsPage
      title="People & roles"
      eyebrow="Settings"
      description={peopleMeta(setup)}
      actions={<PeopleHeaderActions setup={setup} data={data} />}
      width="max-w-6xl"
    >
      <PhoneNotice />
      <PeopleAndRoles setup={setup} data={data} />
    </SettingsPage>
  );
}

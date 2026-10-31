import { notFound } from "next/navigation";
import { loadCapacitySetup } from "@transpera-flow/db";
import { Page } from "@/components/shell/page";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { PeopleAndRoles } from "@/components/setup/people-roles";
import { loadWorkspaceSettings } from "@/lib/data";
import { getDb } from "@/lib/auth/session";

/** Set up, People & roles (capacity build P1): roles with their kind and line, how the shared teams work, and the people with their portfolios. */
export default async function SetupPeoplePage(props: PageProps<"/w/[slug]/setup/people">) {
  const { slug } = await props.params;
  const data = await loadWorkspaceSettings(slug);
  if (!data) notFound();
  const setup = await loadCapacitySetup(await getDb(), data.workspace.id);
  if (!setup) notFound();
  return (
    <Page
      title="People & roles"
      eyebrow="Set up"
      description="Who works here, their hours, their team time and their portfolio. Portfolios are named clients plus a count per tier. Agency admins and the Owner can change this; everyone can read it."
      width="max-w-6xl"
    >
      <PhoneNotice />
      <PeopleAndRoles setup={setup} data={data} />
    </Page>
  );
}

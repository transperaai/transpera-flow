import { Users } from "lucide-react";
import { EmptyState, SectionCard } from "@/components/page-kit";
import { Help } from "@/components/help";
import { SettingsBand } from "@/components/settings/settings-band";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { selectablePeople } from "@/lib/access";
import type { AccessSettings } from "@/lib/access-data";
import type { DeploymentAccessView } from "@/lib/deployment-access";
import { MEMBERSHIP_ROLE_LABEL } from "@/lib/deployment-rules";
import { setMemberPerson } from "./actions";
import { WhoCanSignIn } from "./who-can-sign-in";

function PersonSelect({ people, value }: { people: { id: string; name: string }[]; value?: string | null }) {
  return (
    <>
      <NativeSelect name="person_id" defaultValue={value ?? ""} aria-label="Person record" className="w-auto">
        <option value="">No person record</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </NativeSelect>
      <Help
        label="Person record"
        description="Links this sign-in to a person in your team, so the app knows which person is looking. A Viewer sees only their own person's details and no pay. Leave it empty for someone who isn't on the team."
        example="Link maya@northbeam.example to Maya Collins."
        className="self-center"
      />
    </>
  );
}

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Never";

/** What the Access section shows after an action sent the person back (`?error=` or `?notice=`, and the add form's draft). */
export interface AccessParams {
  error: string | null;
  notice: string | null;
  draft?: { kind?: string; value?: string; role?: string };
}

/** Reads the Access section's query parameters off the Settings page's search params. */
export function accessParams(search: Record<string, string | string[] | undefined>): AccessParams {
  const param = (key: string) => (typeof search[key] === "string" ? (search[key] as string) : undefined);
  const error = param("error") ?? null;
  return { error, notice: param("notice") ?? null, draft: error ? { kind: param("kind"), value: param("value"), role: param("role") } : undefined };
}

/**
 * Settings, Access: the last section of the Settings page, for whoever manages the workspace (the page renders it only when
 * `loadAccessSettings` answers, which it does only with can_manage_workspace). Who can sign in, and the people in this workspace.
 */
export function AccessSection({ slug, settings, userId, signInView, params }: { slug: string; settings: AccessSettings; userId: string | null; signInView: DeploymentAccessView | null; params: AccessParams }) {
  const { error, notice, draft } = params;
  const { members, people } = settings;
  const personName = new Map(people.map((p) => [p.id, p.name]));

  // Who is linked to which person, so each picker offers only people nobody else is linked to.
  const links = new Map<string, Set<string>>();
  for (const m of members) {
    if (!m.personId) continue;
    const keys = links.get(m.personId) ?? new Set<string>();
    links.set(m.personId, keys.add(m.membershipId));
  }

  return (
    <SettingsBand id="access" title="Access" description="People get in by signing in with Google. Nobody is emailed. Changes apply on their next page load.">
      <PhoneReadOnly notice={false}>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert role="status">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        {signInView && <WhoCanSignIn slug={slug} view={signInView} myEmail={members.find((m) => m.userId === userId)?.email ?? null} draft={draft} />}

        <div role="region" aria-labelledby="members-heading">
          <SectionCard
          id="members"
          level={3}
          title="People in this workspace"
          description="Everyone who can sign in is added to every workspace, as an Agency admin or a Viewer, the next time they sign in. Change who can sign in, and as what, in the list above."
        >
          {members.length === 0 ? (
            <EmptyState icon={Users}>Nobody has signed in yet.</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role here</TableHead>
                  <TableHead>
                    <span className="flex items-center">
                      Person
                      <Help
                        label="Person"
                        description="The person record this sign-in belongs to, so the app knows who is looking. Leave it empty for someone who isn't on the team."
                        example="Link a new starter to their person record, Maya Collins."
                      />
                    </span>
                  </TableHead>
                  <TableHead>Last sign-in</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => {
                  const you = m.userId === userId;
                  return (
                    <TableRow key={m.membershipId} className={m.active ? undefined : "text-muted-foreground"}>
                      <TableCell className="font-mono">
                        {m.email}
                        {you && <span className="ml-2 font-sans text-muted-foreground">(you)</span>}
                      </TableCell>
                      <TableCell>{MEMBERSHIP_ROLE_LABEL[m.role]}</TableCell>
                      <TableCell>
                        {m.active ? (
                          <form action={setMemberPerson.bind(null, slug)} className="flex flex-wrap gap-2">
                            <input type="hidden" name="id" value={m.membershipId} />
                            <PersonSelect people={selectablePeople(people, links, m.membershipId)} value={m.personId} />
                            <Button type="submit" variant="outline">
                              Save
                            </Button>
                          </form>
                        ) : (
                          (m.personId && personName.get(m.personId)) || <span className="text-muted-foreground">None</span>
                        )}
                      </TableCell>
                      <TableCell>{formatDate(m.lastSignInAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </SectionCard>
        </div>
      </PhoneReadOnly>
    </SettingsBand>
  );
}

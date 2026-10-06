import { notFound } from "next/navigation";
import { CopyInviteButton } from "@/components/access/copy-invite-button";
import { Help } from "@/components/help";
import { Page } from "@/components/shell/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ASSIGNABLE_ROLES, selectablePeople } from "@/lib/access";
import { currentUserId, loadAccessSettings, type WorkspaceMember } from "@/lib/access-data";
import {
  addDomain,
  addEmail,
  removeDomain,
  removeEmail,
  setMemberActive,
  setMemberPerson,
  setMemberRole,
  updateEmail,
} from "./actions";

const SOURCE_LABEL: Record<WorkspaceMember["source"], string> = {
  access_list: "Pre-assigned email",
  domain: "Allowed domain",
  manual: "Added by Transpera",
};

function RoleSelect({ value, name = "role" }: { value?: string; name?: string }) {
  return (
    <>
      <NativeSelect name={name} defaultValue={value ?? "member"} aria-label="Role" className="w-auto">
        {ASSIGNABLE_ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </NativeSelect>
      <Help
        label="Role"
        description="What this person can do here. Owners manage the workspace and who has access, editors change the model and settings, members can look and run simulations, and viewers can only look."
        example="Make Maya an editor so she can update times; leave new starters as members until they need to edit."
        className="self-center"
      />
    </>
  );
}

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
        description="Links this sign-in to a person in your team, so the app knows which person is looking. Leave it empty for someone who isn't on the team."
        example="Link maya@northbeam.example to Maya Collins."
        className="self-center"
      />
    </>
  );
}

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Never";

export default async function AccessPage(props: PageProps<"/w/[slug]/settings/access">) {
  const { slug } = await props.params;
  const search = await props.searchParams;
  const error = typeof search.error === "string" ? search.error : null;
  const notice = typeof search.notice === "string" ? search.notice : null;

  const settings = await loadAccessSettings(slug);
  if (!settings) notFound();
  const { workspace, domains, emails, members, people, isAgencyAdmin } = settings;
  const userId = await currentUserId();
  const listed = new Map(emails.map((e) => [e.email, e]));
  const personName = new Map(people.map((p) => [p.id, p.name]));

  // Who is linked to which person, so each picker offers only people nobody else is linked to. A list row and the membership it
  // made carry the same person and count as one.
  const links = new Map<string, Set<string>>();
  const link = (personId: string | null, key: string) => {
    if (!personId) return;
    const keys = links.get(personId) ?? new Set<string>();
    links.set(personId, keys.add(key));
  };
  const memberKey = (m: WorkspaceMember) => {
    const row = m.source === "access_list" ? listed.get(m.email.toLowerCase()) : undefined;
    return row ? `e:${row.id}` : `m:${m.membershipId}`;
  };
  for (const e of emails) link(e.person_id, `e:${e.id}`);
  for (const m of members) link(m.personId, memberKey(m));

  return (
    <Page
      title="Access"
      eyebrow="Company"
      description="People get in by signing in with Google. Nobody is emailed. Changes apply on their next page load."
    >
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

      <Card role="region" aria-labelledby="domains-heading">
        <CardHeader>
          <h2 id="domains-heading" className="flex items-center font-heading text-base font-medium">
            Allowed domains
            <Help
              label="Allowed domains"
              description="Anyone who signs in with a company Google account on one of these domains gets into this workspace as a member. Free email providers can't be added."
              example="Add northbeam.example and everyone with a @northbeam.example Google account can sign in."
            />
          </h2>
          <CardDescription>Personal Google accounts made with a work address don&apos;t qualify.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-wrap gap-2">
            {domains.length === 0 && <li className="text-muted-foreground">No domains yet.</li>}
            {domains.map((d) => (
              <li key={d.id} className="flex items-center gap-2 rounded-lg border bg-muted/40 py-1 pr-1 pl-3">
                <span className="font-mono">{d.domain}</span>
                <form action={removeDomain.bind(null, slug)}>
                  <input type="hidden" name="id" value={d.id} />
                  <Button type="submit" variant="ghost" size="xs" className="text-destructive" aria-label={`Remove ${d.domain}`}>
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
          <form action={addDomain.bind(null, slug, workspace.id)} className="flex flex-wrap gap-2">
            <Input name="domain" required placeholder="acme.com" aria-label="Domain" className="w-full sm:w-64" />
            <Help label="Domain" description="The part of a work email after the @. Everyone who signs in with a Google account on it can join." example="northbeam.example, for people at name@northbeam.example." className="self-center" />
            <Button type="submit">Add domain</Button>
          </form>
        </CardContent>
      </Card>

      <Card role="region" aria-labelledby="emails-heading">
        <CardHeader>
          <h2 id="emails-heading" className="flex items-center font-heading text-base font-medium">
            Pre-assigned emails
            <Help
              label="Pre-assigned emails"
              description="Whoever signs in with one of these emails gets exactly the role you choose, whatever their domain. Use it for owners, editors and contractors on personal addresses."
              example="Add sam@gmail.com as an editor and Sam can edit the process even though gmail.com isn't an allowed domain."
            />
          </h2>
          <CardDescription>Exact roles for named people.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>
                  <span className="flex items-center">
                    Role and person
                    <Help
                      label="Role and person"
                      description="Role is what they can do: owners and editors can change things, members and viewers can look. Person links the sign-in to a person record, so their work shows under their name."
                      example="Add maya@northbeam.example as an editor, linked to the person Maya Collins."
                    />
                  </span>
                </TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {emails.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    Nobody yet.
                  </TableCell>
                </TableRow>
              )}
              {emails.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono">{e.email}</TableCell>
                  <TableCell>
                    <form action={updateEmail.bind(null, slug)} className="flex flex-wrap gap-2">
                      <input type="hidden" name="id" value={e.id} />
                      <RoleSelect value={e.role} />
                      <PersonSelect people={selectablePeople(people, links, `e:${e.id}`)} value={e.person_id} />
                      <Button type="submit" variant="outline">
                        Save
                      </Button>
                    </form>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <CopyInviteButton workspaceName={workspace.name} email={e.email} />
                      <form action={removeEmail.bind(null, slug)}>
                        <input type="hidden" name="id" value={e.id} />
                        <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                          Remove
                        </Button>
                      </form>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <form action={addEmail.bind(null, slug, workspace.id)} className="flex flex-wrap gap-2">
            <Input name="email" type="email" required placeholder="name@company.com" aria-label="Email" className="w-full sm:w-64" />
            <Help label="Email" description="The email address of one person you want to let in. When they sign in with it, they join with the role you pick." example="maya@northbeam.example, as an editor." className="self-center" />
            <RoleSelect />
            <PersonSelect people={selectablePeople(people, links)} />
            <Button type="submit">Add email</Button>
          </form>
        </CardContent>
      </Card>

      <Card role="region" aria-labelledby="members-heading">
        <CardHeader>
          <h2 id="members-heading" className="font-heading text-base font-medium">
            Members
          </h2>
          <CardDescription>
            Everyone who has signed in to this workspace. Change a pre-assigned person&apos;s role and person in the list above.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>
                  <span className="flex items-center">
                    Person
                    <Help
                      label="Person"
                      description="The person record this sign-in belongs to, so the app knows who is looking. For people on the pre-assigned list it is set in the list above. Leave it empty for someone who isn't on the team."
                      example="Link a new starter who joined through your domain to their person record, Maya Collins."
                    />
                  </span>
                </TableHead>
                <TableHead>How they got in</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    Nobody has signed in yet.
                  </TableCell>
                </TableRow>
              )}
              {members.map((m) => {
                const you = m.userId === userId;
                const adminRow = m.role === "agency_admin" && !isAgencyAdmin;
                const locked = you || adminRow;
                const onList = m.source === "access_list" && listed.has(m.email.toLowerCase());
                const linkable = !adminRow && !onList && (m.source === "domain" || m.source === "manual");
                return (
                  <TableRow key={m.membershipId} className={m.active ? undefined : "text-muted-foreground"}>
                    <TableCell className="font-mono">
                      {m.email}
                      {you && <span className="ml-2 font-sans text-muted-foreground">(you)</span>}
                    </TableCell>
                    <TableCell>
                      {locked || onList || !m.active ? (
                        m.role
                      ) : (
                        <form action={setMemberRole.bind(null, slug)} className="flex gap-2">
                          <input type="hidden" name="id" value={m.membershipId} />
                          <RoleSelect value={m.role} />
                          <Button type="submit" variant="outline">
                            Save
                          </Button>
                        </form>
                      )}
                    </TableCell>
                    <TableCell>
                      {linkable ? (
                        <form action={setMemberPerson.bind(null, slug)} className="flex flex-wrap gap-2">
                          <input type="hidden" name="id" value={m.membershipId} />
                          <PersonSelect people={selectablePeople(people, links, memberKey(m))} value={m.personId} />
                          <Button type="submit" variant="outline">
                            Save
                          </Button>
                        </form>
                      ) : (
                        (m.personId && personName.get(m.personId)) || <span className="text-muted-foreground">None</span>
                      )}
                    </TableCell>
                    <TableCell>{SOURCE_LABEL[m.source]}</TableCell>
                    <TableCell>{formatDate(m.lastSignInAt)}</TableCell>
                    <TableCell>
                      {locked ? null : onList ? (
                        <span className="text-muted-foreground">Remove from the list above</span>
                      ) : (
                        <form action={setMemberActive.bind(null, slug)}>
                          <input type="hidden" name="id" value={m.membershipId} />
                          <input type="hidden" name="active" value={m.active ? "false" : "true"} />
                          <Button type="submit" variant="ghost" size="sm" className={m.active ? "text-destructive" : undefined}>
                            {m.active ? "Remove access" : "Restore access"}
                          </Button>
                        </form>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Page>
  );
}

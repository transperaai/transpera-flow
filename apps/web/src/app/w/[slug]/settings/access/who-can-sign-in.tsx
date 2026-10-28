import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DeploymentAccessView } from "@/lib/deployment-access";
import { DEPLOYMENT_ROLES, DEPLOYMENT_ROLE_HELP, DEPLOYMENT_ROLE_LABEL, assignableRoles } from "@/lib/deployment-rules";
import { addDeploymentRule, removeDeploymentRule, setDeploymentRole } from "./actions";

function RuleRoleSelect({ value, isOwner }: { value?: string; isOwner: boolean }) {
  return (
    <NativeSelect name="role" defaultValue={value ?? "viewer"} aria-label="Role" className="w-auto">
      {assignableRoles(isOwner).map((r) => (
        <option key={r} value={r}>
          {DEPLOYMENT_ROLE_LABEL[r]}
        </option>
      ))}
    </NativeSelect>
  );
}

/** The Owner and Agency admins: who may sign in to this deployment at all, and with which of the three roles. Only an Owner changes an Owner. */
export function WhoCanSignIn({ slug, view }: { slug: string; view: DeploymentAccessView }) {
  const { rules, environmentAdmins, isOwner } = view;
  return (
    <Card role="region" aria-labelledby="sign-in-heading">
      <CardHeader>
        <h2 id="sign-in-heading" className="flex items-center font-heading text-base font-medium">
          Who can sign in
          <Help
            label="Who can sign in"
            description="Applies to the whole deployment, not one workspace. Anyone whose verified email is on this list can sign in. A named email beats its domain. Agency admins and Viewers are added to every workspace with that role, and moved to match the list when they next sign in. Everyone else is refused."
            example="Add northbeam.example as Viewer, then maya@northbeam.example as Agency admin."
          />
        </h2>
        <CardDescription>
          {DEPLOYMENT_ROLES.map((r) => `${DEPLOYMENT_ROLE_LABEL[r]}: ${DEPLOYMENT_ROLE_HELP[r]}`).join(" ")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rule</TableHead>
              <TableHead>Role</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.length === 0 && environmentAdmins.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">
                  Nobody can sign in yet.
                </TableCell>
              </TableRow>
            )}
            {environmentAdmins.map((email) => (
              <TableRow key={`env:${email}`}>
                <TableCell>
                  <span className="font-mono">{email}</span> <span className="text-muted-foreground">(email)</span>
                </TableCell>
                <TableCell>{DEPLOYMENT_ROLE_LABEL.owner}</TableCell>
                <TableCell className="text-muted-foreground">Set in the deployment&apos;s settings</TableCell>
              </TableRow>
            ))}
            {rules.map((r) => {
              // Only an Owner changes or removes an Owner rule; the database refuses an Agency admin who tries.
              const locked = r.role === "owner" && !isOwner;
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <span className="font-mono">{r.kind === "domain" ? `@${r.value}` : r.value}</span>{" "}
                    <span className="text-muted-foreground">({r.kind === "domain" ? "everyone on the domain" : "email"})</span>
                  </TableCell>
                  <TableCell>
                    {locked ? (
                      DEPLOYMENT_ROLE_LABEL[r.role]
                    ) : (
                      <form action={setDeploymentRole.bind(null, slug)} className="flex gap-2">
                        <input type="hidden" name="id" value={r.id} />
                        <RuleRoleSelect value={r.role} isOwner={isOwner} />
                        <Button type="submit" variant="outline">
                          Save
                        </Button>
                      </form>
                    )}
                  </TableCell>
                  <TableCell>
                    {locked ? (
                      <span className="text-muted-foreground">Only an Owner can change this</span>
                    ) : (
                      <form action={removeDeploymentRule.bind(null, slug)}>
                        <input type="hidden" name="id" value={r.id} />
                        <Button type="submit" variant="ghost" size="sm" className="text-destructive" aria-label={`Remove ${r.value}`}>
                          Remove
                        </Button>
                      </form>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <form action={addDeploymentRule.bind(null, slug)} className="flex flex-wrap gap-2">
          <NativeSelect name="kind" defaultValue="domain" aria-label="Kind" className="w-auto">
            <option value="domain">Domain</option>
            <option value="email">Email</option>
          </NativeSelect>
          <Help
            label="Kind"
            description="A domain lets in everyone whose verified work email ends with it (not subdomains). An email names one person, and beats their domain."
            example="Domain acme.com for the whole company; email sam@gmail.com for a contractor."
            className="self-center"
          />
          <Input name="value" required placeholder="acme.com or name@acme.com" aria-label="Domain or email" className="w-full sm:w-72" />
          <Help
            label="Domain or email"
            description="The domain (the part after the @) or the full address. Free email providers like gmail.com can only be added as a single email."
            example="northbeam.example, or maya@northbeam.example."
            className="self-center"
          />
          <RuleRoleSelect isOwner={isOwner} />
          <Help
            label="Role"
            description="Owner is for Transpera: everything. Agency admin is for the client's founder and head of CS: edits everything, sees individual pay and manages this list (but not Owners). Viewer reads everything except individual pay."
            example="Make the client's domain Viewers and their founder an Agency admin."
            className="self-center"
          />
          <Button type="submit">Add</Button>
        </form>
      </CardContent>
    </Card>
  );
}

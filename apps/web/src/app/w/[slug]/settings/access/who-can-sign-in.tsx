import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DeploymentAccessView } from "@/lib/deployment-access";
import { DEPLOYMENT_ROLES, DEPLOYMENT_ROLE_HELP } from "@/lib/deployment-rules";
import { addDeploymentRule, removeDeploymentRule, setDeploymentRole } from "./actions";

function RuleRoleSelect({ value }: { value?: string }) {
  return (
    <NativeSelect name="role" defaultValue={value ?? "viewer"} aria-label="Role" className="w-auto">
      {DEPLOYMENT_ROLES.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </NativeSelect>
  );
}

/** Agency admins only: who may sign in to this deployment at all, and with what role. */
export function WhoCanSignIn({ slug, view }: { slug: string; view: DeploymentAccessView }) {
  const { rules, environmentAdmins } = view;
  return (
    <Card role="region" aria-labelledby="sign-in-heading">
      <CardHeader>
        <h2 id="sign-in-heading" className="flex items-center font-heading text-base font-medium">
          Who can sign in
          <Help
            label="Who can sign in"
            description="Applies to the whole deployment, not one workspace. Anyone whose verified email is on this list can sign in. A named email beats its domain. Admins see every workspace; editors and viewers are added to every workspace at that role (anyone already higher keeps their role). Everyone else is refused."
            example="Add northbeam.example as viewer, then maya@northbeam.example as editor."
          />
        </h2>
        <CardDescription>
          {DEPLOYMENT_ROLES.map((r) => `${r}: ${DEPLOYMENT_ROLE_HELP[r]}`).join(" ")}
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
                <TableCell>admin</TableCell>
                <TableCell className="text-muted-foreground">Set in the deployment&apos;s settings</TableCell>
              </TableRow>
            ))}
            {rules.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <span className="font-mono">{r.kind === "domain" ? `@${r.value}` : r.value}</span>{" "}
                  <span className="text-muted-foreground">({r.kind === "domain" ? "everyone on the domain" : "email"})</span>
                </TableCell>
                <TableCell>
                  <form action={setDeploymentRole.bind(null, slug)} className="flex gap-2">
                    <input type="hidden" name="id" value={r.id} />
                    <RuleRoleSelect value={r.role} />
                    <Button type="submit" variant="outline">
                      Save
                    </Button>
                  </form>
                </TableCell>
                <TableCell>
                  <form action={removeDeploymentRule.bind(null, slug)}>
                    <input type="hidden" name="id" value={r.id} />
                    <Button type="submit" variant="ghost" size="sm" className="text-destructive" aria-label={`Remove ${r.value}`}>
                      Remove
                    </Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
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
          <RuleRoleSelect />
          <Help
            label="Role"
            description="Admin sees and manages every workspace and this list. Editor and viewer are added to every workspace at that role; someone already higher keeps their role."
            example="Make the client's domain viewers and their lead an editor."
            className="self-center"
          />
          <Button type="submit">Add</Button>
        </form>
      </CardContent>
    </Card>
  );
}

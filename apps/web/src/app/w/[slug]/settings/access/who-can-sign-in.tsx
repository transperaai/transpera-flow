import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/page-kit";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DeploymentAccessView } from "@/lib/deployment-access";
import { DEPLOYMENT_ROLES, DEPLOYMENT_ROLE_HELP, DEPLOYMENT_ROLE_LABEL, assignableRoles } from "@/lib/deployment-rules";
import { addDeploymentRule, removeDeploymentRule, setDeploymentRole } from "./actions";
import { RemoveRule } from "./remove-rule";

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

/** Whether a rule lets in this email: the same address, or an address on the rule's domain (not its subdomains). */
export function ruleMatches(rule: { kind: string; value: string }, email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  const v = rule.value.trim().toLowerCase();
  return rule.kind === "domain" ? e.endsWith(`@${v}`) : e === v;
}

/**
 * The Owner and Agency admins: who may sign in to this deployment at all, and with which of the three roles. Only an Owner changes an
 * Owner. `myEmail` is the signed-in person's, so removing a rule that lets them in can say so.
 */
export function WhoCanSignIn({ slug, view, myEmail, draft }: { slug: string; view: DeploymentAccessView; myEmail?: string | null; /** What the add form held when the server refused it, to fill it in again. */ draft?: { kind?: string; value?: string; role?: string } }) {
  const { rules, environmentAdmins, isOwner } = view;
  return (
    <div role="region" aria-labelledby="sign-in-heading">
      <SectionCard
        id="sign-in"
        level={3}
        title={
          <span className="flex items-center">
            Who can sign in
            <Help
              label="Who can sign in"
              description="Applies to the whole deployment, not one workspace. Anyone whose verified email is on this list can sign in. A named email beats its domain. Agency admins and Viewers are added to every workspace with that role, and moved to match the list when they next sign in. Everyone else is refused."
              example="Add northbeam.example as Viewer, then maya@northbeam.example as Agency admin."
            />
          </span>
        }
        description={DEPLOYMENT_ROLES.map((r) => `${DEPLOYMENT_ROLE_LABEL[r]}: ${DEPLOYMENT_ROLE_HELP[r]}`).join(" ")}
      >
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
                      <RemoveRule
                        action={removeDeploymentRule.bind(null, slug)}
                        id={r.id}
                        name={r.kind === "domain" ? `@${r.value}` : r.value}
                        value={r.value}
                        // Only when nothing else lets them in: a named email beats its domain, and the deployment's own admins stay in.
                        locksYouOut={ruleMatches(r, myEmail) && !environmentAdmins.some((a) => a.toLowerCase() === myEmail?.toLowerCase()) && !rules.some((o) => o.id !== r.id && ruleMatches(o, myEmail))}
                      />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {/* Keyed on what came back, so a refused add opens with what was typed rather than an empty form. */}
        <form key={JSON.stringify(draft ?? {})} action={addDeploymentRule.bind(null, slug)} className="flex flex-wrap gap-2">
          <NativeSelect name="kind" defaultValue={draft?.kind === "email" ? "email" : "domain"} aria-label="Kind" className="w-auto">
            <option value="domain">Domain</option>
            <option value="email">Email</option>
          </NativeSelect>
          <Help
            label="Kind"
            description="A domain lets in everyone whose verified work email ends with it (not subdomains). An email names one person, and beats their domain."
            example="Domain acme.com for the whole company; email sam@gmail.com for a contractor."
            className="self-center"
          />
          <Input name="value" required defaultValue={draft?.value} placeholder="acme.com or name@acme.com" aria-label="Domain or email" className="w-full sm:w-72" />
          <Help
            label="Domain or email"
            description="The domain (the part after the @) or the full address. Free email providers like gmail.com can only be added as a single email."
            example="northbeam.example, or maya@northbeam.example."
            className="self-center"
          />
          <RuleRoleSelect value={draft?.role} isOwner={isOwner} />
          <Help
            label="Role"
            description="Owner is for Transpera: everything. Agency admin is for the client's founder and head of CS: edits everything, sees individual pay and manages this list (but not Owners). Viewer reads everything except individual pay."
            example="Make the client's domain Viewers and their founder an Agency admin."
            className="self-center"
          />
          <Button type="submit">Add</Button>
        </form>
      </SectionCard>
    </div>
  );
}

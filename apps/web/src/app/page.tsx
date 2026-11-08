import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AgencyWorkspaceTable } from "@/components/agency-workspace-table";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isAgencyAdmin } from "@/lib/access-data";
import { listAgencyWorkspaces, listWorkspaces } from "@/lib/data";
import { authEnv } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";
import { NewWorkspaceForm } from "./new-workspace-form";

export default async function HomePage() {
  // Render per request: Auth and database settings are read at runtime, not build time.
  await connection();
  // No sign-in settings: this deployment is not set up, so there is nothing to show.
  if (!authEnv()) notFound();
  // Memberships are made at sign-in from the "Who can sign in" list (and for a new workspace by the database), so there is nothing
  // to resolve here.
  const [workspaces, admin] = await Promise.all([listWorkspaces(), isAgencyAdmin()]);
  // The Owner with no workspaces creates the first one here.
  if (workspaces.length === 0 && !admin) {
    const user = await getSessionUser();
    return <HoldingPage email={user?.email ?? "an unknown account"} />;
  }
  // The Owner sees each company's headline numbers; everyone else keeps the cards.
  const agencyRows = admin && workspaces.length > 0 ? await listAgencyWorkspaces() : null;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-12 sm:px-6">
      <AppHeader signedIn />
      <PageHeader title="Workspaces" description="Each workspace is one company: its processes, people, issues and settings." />
      {admin && (
        <Card>
          <CardContent>
            <details open={workspaces.length === 0}>
              <summary className="cursor-pointer font-medium">New workspace</summary>
              <div className="pt-4">
                <PhoneReadOnly>
                  <NewWorkspaceForm />
                </PhoneReadOnly>
              </div>
            </details>
          </CardContent>
        </Card>
      )}
      {workspaces.length === 0 && <p className="text-muted-foreground">No workspaces yet. Create the first one above.</p>}
      {agencyRows ? (
        <AgencyWorkspaceTable rows={agencyRows} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {workspaces.map((ws) => (
            <li key={ws.id}>
              <Link
                href={`/w/${ws.slug}`}
                className="flex items-center gap-3 rounded-xl bg-card px-4 py-3 text-sm font-medium ring-1 ring-foreground/10 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-soft font-display text-sm font-bold text-accent">
                  {ws.name.trim().charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 truncate">{ws.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** Signed in, but neither a pre-assigned email nor an allowed domain matched. */
function HoldingPage({ email }: { email: string }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-4 py-16">
      <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Transpera Flow</p>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">No workspace yet</h1>
      <p>
        You&apos;re signed in as <strong>{email}</strong> but don&apos;t have access to a workspace yet. Ask your
        company&apos;s owner or Transpera to add you.
      </p>
      <p className="text-sm text-muted-foreground">
        Using a personal Google account? Sign out and sign in with your work account instead.
      </p>
      <form action="/auth/signout" method="post">
        <Button type="submit">Sign out</Button>
      </form>
    </main>
  );
}

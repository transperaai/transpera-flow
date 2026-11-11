import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { AgencyWorkspaceTable } from "@/components/agency-workspace-table";
import { AppHeader } from "@/components/app-header";
import { ArrowRight, Building2 } from "lucide-react";
import { EmptyState } from "@/components/page-kit";
import { ListTable, ListTableHeader } from "@/components/processes/list-table";
import { PageHeader, pageBodyClass } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { isAgencyAdmin } from "@/lib/access-data";
import { listAgencyWorkspaces, listWorkspaces } from "@/lib/data";
import { authEnv } from "@/lib/auth/env";
import { getSessionUser } from "@/lib/auth/session";
import { mayCreateWorkspace } from "@/lib/workspace-limit";
import { PhoneReadOnly } from "@/components/shell/phone-read-only";
import { NewWorkspaceButton } from "./new-workspace-form";

export default async function HomePage() {
  // Render per request: Auth and database settings are read at runtime, not build time.
  await connection();
  // No sign-in settings: this deployment is not set up, so there is nothing to show.
  if (!authEnv()) notFound();
  // Memberships are made at sign-in from the "Who can sign in" list (and for a new workspace by the database), so there is nothing
  // to resolve here.
  const [workspaces, admin] = await Promise.all([listWorkspaces(), isAgencyAdmin()]);
  // One deployment is one client (docs/adr/0024-*): with exactly one workspace there is no list to choose from, so go
  // straight to it. Zero (the Owner makes the first) and two or more (a demo or QA deployment) keep this page.
  if (workspaces.length === 1) redirect(`/w/${encodeURIComponent(workspaces[0]!.slug)}`);
  // The Owner with no workspaces creates the first one here.
  if (workspaces.length === 0 && !admin) {
    const user = await getSessionUser();
    return <HoldingPage email={user?.email ?? "an unknown account"} />;
  }
  // The Owner sees each company's headline numbers; everyone else keeps the cards.
  const agencyRows = admin && workspaces.length > 0 ? await listAgencyWorkspaces() : null;
  return (
    <main className="flex w-full flex-col">
      <div className="px-4 sm:px-6 lg:px-8">
        <AppHeader signedIn />
      </div>
      <div className={pageBodyClass("fluid")}>
        <PageHeader
          title="Workspaces"
          description="Each workspace is one company: its processes, people, issues and settings."
          actions={
            // The first workspace, or another only where ALLOW_MULTIPLE_WORKSPACES is on (createWorkspace refuses it otherwise).
            admin && mayCreateWorkspace(workspaces.length) ? (
              <PhoneReadOnly notice={false}>
                <NewWorkspaceButton defaultOpen={workspaces.length === 0} />
              </PhoneReadOnly>
            ) : undefined
          }
        />
        {workspaces.length === 0 ? (
          <EmptyState icon={Building2} data-no-workspaces>
            No workspaces yet. Create the first one with New workspace.
          </EmptyState>
        ) : agencyRows ? (
          <AgencyWorkspaceTable rows={agencyRows} />
        ) : (
          <ListTable aria-label="Workspaces" data-workspaces>
            <ListTableHeader stickyTop="page">
              <TableRow>
                <TableHead className="px-3">Workspace</TableHead>
                <TableHead className="px-3">Address</TableHead>
                <TableHead className="px-3" aria-label="Open the workspace" />
              </TableRow>
            </ListTableHeader>
            <TableBody>
              {workspaces.map((ws) => (
                <TableRow key={ws.id} data-workspace={ws.slug}>
                  <TableCell className="px-3 py-2.5">
                    <Link href={`/w/${ws.slug}`} className="flex items-center gap-3 font-medium hover:underline">
                      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-accent-soft text-xs font-semibold text-accent">
                        {ws.name.trim().charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 truncate">{ws.name}</span>
                    </Link>
                  </TableCell>
                  <TableCell className="px-3 py-2.5 font-mono text-xs text-muted-foreground">/w/{ws.slug}</TableCell>
                  <TableCell className="px-3 py-2 text-right">
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/w/${ws.slug}`} aria-label={`Open ${ws.name}`}>
                        Open <ArrowRight aria-hidden />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ListTable>
        )}
      </div>
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

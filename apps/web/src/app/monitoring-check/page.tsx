import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/shell/page";
import { Card, CardContent } from "@/components/ui/card";
import { isAgencyAdmin } from "@/lib/access-data";
import { sentryDsn, sentryEnvironment } from "@/lib/monitoring/env";
import { supabaseEnv } from "@/lib/supabase/env";
import { MonitoringCheckButtons } from "./buttons";

export const metadata = { title: "Error reporting check · Transpera Flow", robots: { index: false, follow: false } };

/** For agency admins only (issue #44): proves error reporting works after the Sentry variables are set. Not linked from the app. */
export default async function MonitoringCheckPage() {
  await connection();
  if (!supabaseEnv() || !(await isAgencyAdmin())) notFound();
  const configured = sentryDsn() !== null;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-12 sm:px-6">
      <AppHeader signedIn />
      <PageHeader
        title="Error reporting check"
        description="Send one test error from the browser and one from the server, then look for them in Sentry (Issues). Each should show our file names and lines, a method and a path, and nothing about you."
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
            <dt className="text-muted-foreground">Error reporting is</dt>
            <dd className="font-medium">{configured ? "on (a DSN is set)" : "off (no DSN is set)"}</dd>
            <dt className="text-muted-foreground">Environment</dt>
            <dd className="font-medium">{sentryEnvironment()}</dd>
          </dl>
          <MonitoringCheckButtons />
        </CardContent>
      </Card>
    </main>
  );
}

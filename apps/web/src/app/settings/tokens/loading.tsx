import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/shell/page";
import { FormSkeleton } from "@/components/shell/skeletons";

/** Shown while the API tokens load; it sits in the same frame as the page, outside the workspace shell. */
export default function LoadingApiTokens() {
  return (
    <main className="flex w-full flex-col gap-6 px-4 pb-12 sm:px-6 lg:px-8">
      <AppHeader signedIn />
      <PageHeader title="API tokens" description="Loading…" />
      <FormSkeleton />
    </main>
  );
}

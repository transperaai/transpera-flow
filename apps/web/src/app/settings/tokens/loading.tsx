import { AppHeader } from "@/components/app-header";
import { PageHeader, pageBodyClass } from "@/components/shell/page";
import { TableSkeleton } from "@/components/shell/skeletons";

/** Shown while the API tokens load: the page's own frame (header, then one table), outside the workspace shell. */
export default function LoadingApiTokens() {
  return (
    <main className="flex w-full flex-col">
      <div className="px-4 sm:px-6 lg:px-8">
        <AppHeader signedIn />
      </div>
      <div className={pageBodyClass("fluid")}>
        <PageHeader title="API tokens" />
        <TableSkeleton columns={5} rows={3} />
      </div>
    </main>
  );
}

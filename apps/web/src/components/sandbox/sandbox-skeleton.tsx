import { ShellHeader } from "@/components/shell/shell-header";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while the Sandbox's loaders run: the workbench's own shape (the toolbar, the levers pane on the left, then the verdict, its figures and the
 * charts' grid on the right), so nothing jumps when the page arrives. A server module with no data, like the shared skeletons (to be re-exported from `shell/skeletons.tsx`).
 */
export function SandboxSkeleton() {
  return (
    <div className="flex min-w-0 flex-col lg:h-svh">
      <ShellHeader title="Sandbox" />
      <div role="status" aria-label="Loading the Sandbox" data-loading="sandbox" className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-2 sm:px-6" aria-hidden>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-7 w-56" />
          <span className="flex-1" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-20" />
        </div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[20rem_minmax(0,1fr)]" aria-hidden>
          <div className="flex flex-col gap-4 border-b border-line bg-panel px-4 py-4 lg:border-r lg:border-b-0">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-col gap-6 px-4 pt-5 pb-12 sm:px-6 lg:px-8">
            <Skeleton className="h-5 w-2/3 max-w-prose" />
            <Skeleton className="h-[4.5rem] w-full rounded-xl" />
            <Skeleton className="h-72 w-full rounded-xl" />
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] gap-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-64 w-full rounded-xl" />
              ))}
            </div>
          </div>
        </div>
        <span className="sr-only">Loading the Sandbox…</span>
      </div>
    </div>
  );
}

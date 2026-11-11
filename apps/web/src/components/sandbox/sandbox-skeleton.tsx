import { pageBodyClass } from "@/components/shell/page";
import { ShellHeader } from "@/components/shell/shell-header";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while the Sandbox's loaders run: the page's own shape, top to bottom (the toolbar, the company map's big block, the levers band with its five
 * columns, then the verdict line, the strip of its figures and the charts' grid), so nothing jumps when the page arrives. One page that scrolls, like
 * the Sandbox. A server module with no data, like the shared skeletons (re-exported from `shell/skeletons.tsx`).
 */
export function SandboxSkeleton() {
  return (
    <div className="flex min-w-0 flex-col">
      <ShellHeader title="Sandbox" />
      <div role="status" aria-label="Loading the Sandbox" data-loading="sandbox" className="flex min-w-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-2 sm:px-6" aria-hidden>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-7 w-56" />
          <span className="flex-1" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-20" />
        </div>
        <div className={pageBodyClass()} aria-hidden>
          <div className="flex flex-col gap-3" data-skeleton-map>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-[82svh] min-h-[34rem] w-full rounded-xl" />
          </div>
          <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel" data-skeleton-levers>
            <div className="flex items-center gap-3 border-b border-line px-4 py-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-20" />
              <span className="flex-1" />
              <Skeleton className="h-7 w-14" />
            </div>
            <div className="-mt-px -ml-px grid grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))]">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex flex-col gap-3 border-t border-l border-line px-4 pt-3 pb-4">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ))}
            </div>
          </div>
          <div className="mt-1 flex min-w-0 flex-col gap-6">
            <div className="flex flex-col gap-3">
              <Skeleton className="h-5 w-2/3 max-w-prose" />
              <Skeleton className="h-[4.5rem] w-full rounded-xl" />
            </div>
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

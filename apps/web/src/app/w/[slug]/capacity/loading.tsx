import { PageSkeleton } from "@/components/shell/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Shown while the Capacity page's loaders run: the dashboard's shape (two flat strips of figures, then the panels two or three across). */
export default function LoadingCapacity() {
  return (
    <PageSkeleton title="Capacity" eyebrow="Company">
      <div role="status" aria-label="Loading Capacity" data-loading="capacity" className="flex min-w-0 flex-col gap-6">
        <div className="grid gap-4 2xl:grid-cols-2" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-[5.5rem] w-full rounded-xl" />
            </div>
          ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-72 w-full rounded-xl" />
          ))}
        </div>
        <span className="sr-only">Loading Capacity…</span>
      </div>
    </PageSkeleton>
  );
}

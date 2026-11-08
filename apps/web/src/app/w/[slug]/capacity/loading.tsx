import { PageSkeleton, TableSkeleton } from "@/components/shell/skeletons";

/** Shown while the Capacity page's loaders run. */
export default function LoadingCapacity() {
  return (
    <PageSkeleton title="Capacity" eyebrow="Company" width="max-w-6xl">
      <TableSkeleton />
    </PageSkeleton>
  );
}

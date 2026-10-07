import { PageSkeleton, TableSkeleton } from "@/components/shell/skeletons";

/** Shown while the People page's loaders run. */
export default function LoadingPeople() {
  return (
    <PageSkeleton title="People" eyebrow="Company" width="max-w-6xl">
      <TableSkeleton />
    </PageSkeleton>
  );
}

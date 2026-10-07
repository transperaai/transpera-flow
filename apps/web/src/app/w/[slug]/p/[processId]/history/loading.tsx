import { PageSkeleton, TableSkeleton } from "@/components/shell/skeletons";

/** Shown while a process's versions load. */
export default function LoadingHistory() {
  return (
    <PageSkeleton title="Process history" width="max-w-6xl">
      <TableSkeleton columns={4} />
    </PageSkeleton>
  );
}

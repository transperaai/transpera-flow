import { ListSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the processes load. */
export default function LoadingProcesses() {
  return (
    <PageSkeleton title="Processes" eyebrow="Company" width="max-w-6xl">
      <ListSkeleton />
    </PageSkeleton>
  );
}

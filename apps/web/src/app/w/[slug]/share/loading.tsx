import { PageSkeleton, TableSkeleton } from "@/components/shell/skeletons";

/** Shown while the share links load. */
export default function LoadingShare() {
  return (
    <PageSkeleton title="Share links" eyebrow="Company" width="max-w-6xl">
      <TableSkeleton columns={4} />
    </PageSkeleton>
  );
}

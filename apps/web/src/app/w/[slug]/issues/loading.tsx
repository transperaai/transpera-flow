import { ListSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the issues load. */
export default function LoadingIssues() {
  return (
    <PageSkeleton title="Issues" eyebrow="Improve">
      <ListSkeleton />
    </PageSkeleton>
  );
}

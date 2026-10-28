import { ListSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the change log loads. */
export default function LoadingChangeLog() {
  return (
    <PageSkeleton title="Change log" eyebrow="Company">
      <ListSkeleton />
    </PageSkeleton>
  );
}

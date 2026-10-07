import { CardGridSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the block library loads. */
export default function LoadingBlocks() {
  return (
    <PageSkeleton title="Block library" eyebrow="Improve">
      <CardGridSkeleton />
    </PageSkeleton>
  );
}

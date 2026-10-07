import { CardGridSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the solutions load. */
export default function LoadingSolutions() {
  return (
    <PageSkeleton title="Solutions" eyebrow="Improve">
      <CardGridSkeleton />
    </PageSkeleton>
  );
}

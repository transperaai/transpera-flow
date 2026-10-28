import { ChartSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the Sandbox's loaders run. The page draws its own header (`hideHeader`), so the skeleton has none either. */
export default function LoadingSandbox() {
  return (
    <PageSkeleton title="Sandbox" width="max-w-6xl" hideHeader>
      <ChartSkeleton />
    </PageSkeleton>
  );
}

import { ChartSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the forecast's loaders run. The page draws its own header (`hideHeader`), so the skeleton has none either. */
export default function LoadingForecast() {
  return (
    <PageSkeleton title="Forecast" width="max-w-6xl" hideHeader>
      <ChartSkeleton />
    </PageSkeleton>
  );
}

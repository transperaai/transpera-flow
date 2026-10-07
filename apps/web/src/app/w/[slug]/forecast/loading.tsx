import { ChartSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the forecast's loaders run. */
export default function LoadingForecast() {
  return (
    <PageSkeleton title="Forecast" eyebrow="Company" width="max-w-6xl">
      <ChartSkeleton />
    </PageSkeleton>
  );
}

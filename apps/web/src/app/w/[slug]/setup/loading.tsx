import { PageSkeleton, SettingsSkeleton } from "@/components/shell/skeletons";

/** Shown while a Set up page loads. */
export default function LoadingSetup() {
  return (
    <PageSkeleton title="Set up" eyebrow="Set up">
      <SettingsSkeleton />
    </PageSkeleton>
  );
}

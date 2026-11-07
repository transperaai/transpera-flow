import { PageSkeleton, SettingsSkeleton } from "@/components/shell/skeletons";

/** Shown while the settings load. The pages under Settings (Access, AI, Levers) show it too. */
export default function LoadingSettings() {
  return (
    <PageSkeleton title="Settings" eyebrow="Company">
      <SettingsSkeleton />
    </PageSkeleton>
  );
}

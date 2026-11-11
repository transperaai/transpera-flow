import { PageSkeleton, SettingsSkeleton } from "@/components/shell/skeletons";

/** Shown while the Settings page (one scroll of eight sections) loads: the sub-nav, then a few section bands. */
export default function LoadingSettings() {
  return (
    <PageSkeleton title="Settings" eyebrow="Settings">
      <SettingsSkeleton />
    </PageSkeleton>
  );
}

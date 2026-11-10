import { PageSkeleton, SettingsSkeleton } from "@/components/shell/skeletons";

/** Shown while the settings load. The pages under Settings (Tiers & clients, People & roles, Access) show it too. */
export default function LoadingSettings() {
  return (
    <PageSkeleton title="Settings" eyebrow="Settings">
      <SettingsSkeleton />
    </PageSkeleton>
  );
}

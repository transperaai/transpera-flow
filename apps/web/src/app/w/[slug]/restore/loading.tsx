import { FormSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the restore page checks whether the workspace is empty. */
export default function LoadingRestore() {
  return (
    <PageSkeleton title="Restore a backup" eyebrow="Workspace" width="max-w-3xl">
      <FormSkeleton />
    </PageSkeleton>
  );
}

import { FormSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while a process's first principles load. */
export default function LoadingFirstPrinciples() {
  return (
    <PageSkeleton title="First principles">
      <FormSkeleton />
    </PageSkeleton>
  );
}

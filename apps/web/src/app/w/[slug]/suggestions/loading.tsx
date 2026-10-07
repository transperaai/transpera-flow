import { ListSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the suggestions load. */
export default function LoadingSuggestions() {
  return (
    <PageSkeleton title="Suggestions" eyebrow="Improve">
      <ListSkeleton />
    </PageSkeleton>
  );
}

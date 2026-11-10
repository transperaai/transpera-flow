import { ListSkeleton, PageSkeleton } from "@/components/shell/skeletons";

/** Shown while the library's sources load: the same header, toolbar and table as the page. */
export default function LoadingSources() {
  return (
    <PageSkeleton title="Sources" eyebrow="Company">
      <ListSkeleton />
    </PageSkeleton>
  );
}

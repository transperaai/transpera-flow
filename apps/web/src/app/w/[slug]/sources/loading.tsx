import { Page } from "@/components/shell/page";
import { SourcesLibrarySkeleton } from "@/components/sources/sources-library";

/** Shown while the library's sources load. */
export default function LoadingSources() {
  return (
    <Page title="Sources" eyebrow="Company" description="Loading the sources…">
      <SourcesLibrarySkeleton />
    </Page>
  );
}

import { northbeamIssues, northbeamScenarios, processesOf } from "@transpera-flow/db";
import { IssuesPage } from "@/components/issues-page";
import { Page } from "@/components/shell/page";
import { demoBundle, demoSources } from "@/lib/sources/demo";

/** The Issues list on the demo: Northbeam's sample issues, in memory. */
export default function DemoIssuesPage() {
  const bundle = demoBundle();
  return (
    <Page
      title="Issues"
      eyebrow="Improve"
      description={
        <>
          Problems you&apos;ve confirmed, linked to a whole process or to specific steps. Each one keeps the rating agreed when it was confirmed. Demo mode: changes stay in this tab and are gone when you reload.
        </>
      }
    >
      <IssuesPage
        bundle={bundle}
        issues={northbeamIssues()}
        scenarios={northbeamScenarios()}
        processes={processesOf(bundle).map((p) => ({ id: p.id, name: p.name }))}
        sources={demoSources()}
        base="/demo"
        mode="demo"
      />
    </Page>
  );
}

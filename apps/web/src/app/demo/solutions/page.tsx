import { northbeamIssues, processesOf } from "@transpera-flow/db";
import { NewSolutionButton, SolutionsList } from "@/components/solutions/solutions-list";
import { Page } from "@/components/shell/page";
import { demoBundle } from "@/lib/sources/demo";

/** The Solutions list on the demo: the solutions saved in this tab (the Editor's solution mode writes them), gone on reload. */
export default function DemoSolutionsPage() {
  const processes = processesOf(demoBundle()).map((p) => ({ id: p.id, name: p.name }));
  return (
    <Page
      title="Solutions"
      eyebrow="Improve"
      description="Every solution that has been built and simulated. Each one says which issues it solves, and how it did against each issue's target. Demo mode: solutions stay in this tab and are gone when you reload."
      actions={<NewSolutionButton processes={processes} base="/demo" />}
    >
      <SolutionsList issues={northbeamIssues()} processes={processes} base="/demo" mode="demo" />
    </Page>
  );
}

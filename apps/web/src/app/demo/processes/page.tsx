import { northbeamIssues, partOf } from "@transpera-flow/db";
import { ProcessesPage } from "@/components/processes/processes-page";
import { processRows, type LiveVersion } from "@/lib/processes/rows";
import { demoBundle } from "@/lib/sources/demo";
import { openDemoProcessCard } from "./actions";

/** Northbeam's processes on the demo, each row opening its map card (issue #101). */
export default function DemoProcessesPage() {
  const pipeline = demoBundle();
  const parts = [partOf(pipeline), ...(pipeline.otherProcesses ?? [])];
  const rows = processRows({
    processes: parts.map(({ process: p }) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      description: p.description,
      parentId: p.parent_process_id,
      live: true,
      draft: false,
    })),
    steps: parts.flatMap((p) => p.steps),
    issues: northbeamIssues(),
    versions: new Map<string, LiveVersion>(parts.map((p) => [p.process.id, { number: p.revision.number, publishedAt: null }])),
  });
  return (
    <ProcessesPage
      rows={rows}
      hrefs={Object.fromEntries(rows.map((r) => [r.id, `/demo/p/${r.id}`]))}
      companyMap={{ href: "/demo", edit: false }}
      loadCard={openDemoProcessCard}
      note="Demo mode: sample data. Nothing here is kept."
    />
  );
}
